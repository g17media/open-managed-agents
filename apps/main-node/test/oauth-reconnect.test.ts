import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildOAuthRoutes, nativeOAuthCredentials, type RouteServices } from "@open-managed-agents/http-routes";
import { createInMemoryCredentialService } from "../../../packages/credentials-store/src/test-fakes";
import { CredentialsApplicationService } from "@open-managed-agents/managed-agents-application";
import { MemoryCredentialStore } from "../../../packages/credential-store-memory/src/index";

afterEach(() => vi.restoreAllMocks());

describe("OAuth credential reconnection", () => {
  it.each([true, false])("automatically obtains a renewable native grant and keeps its scopes on reconnect (reported scope=%s)", async reportsScope => {
    const workspaceId = "workspace_offline_access";
    const vault = { id: "vault_offline_access", archivedAt: null };
    const store = new MemoryCredentialStore();
    const credentials = nativeOAuthCredentials({ workspaceId, store, nextId: () => "credential_offline_access",
      vaults: { retrieveVault: async () => ({ type: "found", vault }) } as never });
    const state = new Map<string, string>();
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", workspaceId); await next(); });
    app.route("/v1/oma/oauth", buildOAuthRoutes({ env: {}, credentialsFor: () => credentials,
      services: { kv: { get: async (key: string) => state.get(key) ?? null,
        put: async (key: string, value: string) => { state.set(key, value); },
        delete: async (key: string) => { state.delete(key); } } } as unknown as RouteServices,
    }));
    let advertisesOfflineAccess = true;
    const authorizedScopes = new Map<string, string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url));
      if (path.hostname === "mcp.test" && path.pathname.startsWith("/.well-known")) {
        return Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://oauth.test"], scopes_supported: ["openid", "profile", "email"] });
      }
      if (path.href === "https://oauth.test/.well-known/oauth-authorization-server") return new Response(null, { status: 404 });
      if (path.href === "https://oauth.test/.well-known/openid-configuration") {
        return Response.json({ issuer: "https://oauth.test", authorization_endpoint: "https://oauth.test/authorize", token_endpoint: "https://oauth.test/token",
          scopes_supported: advertisesOfflineAccess ? ["openid", "profile", "email", "offline_access"] : ["openid", "profile", "email"] });
      }
      if (path.origin === "https://oauth.test" && path.pathname === "/authorize") {
        const code = `code-${authorizedScopes.size}`;
        authorizedScopes.set(code, path.searchParams.get("scope") ?? "");
        const callback = new URL(path.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", path.searchParams.get("state")!);
        callback.searchParams.set("code", code);
        return Response.redirect(callback, 302);
      }
      if (path.href === "https://oauth.test/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("existing-client");
        const scope = authorizedScopes.get(body.get("code")!);
        expect(scope).toBeDefined();
        // The fake models an AS that only issues refresh tokens when the
        // authorization request asked for offline access, as Zitadel does.
        return Response.json({ access_token: "new-access", expires_in: 3600,
          ...(scope!.split(" ").includes("offline_access") && { refresh_token: "new-refresh" }),
          ...(reportsScope && { scope }) });
      }
      if (path.href === "https://mcp.test/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      throw new Error(`Unexpected offline request ${path.href}`);
    });
    const params = new URLSearchParams({ vault_id: vault.id, mcp_server_url: "https://mcp.test/mcp", client_id: "existing-client" });
    for (const reconnect of [false, true]) {
      if (reconnect) {
        // A saved grant must retain the requested/granted scope even if the
        // provider's later metadata stops advertising it.
        advertisesOfflineAccess = false;
        params.delete("client_id");
        params.set("credential_id", "credential_offline_access");
      }
      const response = await app.request(`/v1/oma/oauth/authorize?${params}`);
      expect(response.status, await response.clone().text()).toBe(302);
      const authorization = await fetch(response.headers.get("location")!);
      const callback = await app.request(authorization.headers.get("location")!);
      expect(callback.status, await callback.clone().text()).toBe(200);
      const saved = await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true });
      expect(saved).toHaveLength(1);
      expect(saved[0]!.credential).toMatchObject({ id: "credential_offline_access", auth: {
        accessToken: "new-access", scope: "openid profile email offline_access",
        refresh: { refreshToken: "new-refresh", clientId: "existing-client", scope: "openid profile email offline_access" },
      } });
    }
    expect([...authorizedScopes.values()]).toEqual(["openid profile email offline_access", "openid profile email offline_access"]);
  });

  it.each([
    ["native", false, false], ["native", true, false], ["native", true, true],
    ["legacy", false, false], ["legacy", true, false],
  ] as const)("reconnects a %s grant without a refresh token (confidential=%s, basic=%s)", async (mode, confidential, basic) => {
    const workspaceId = "workspace_no_refresh";
    const vault = { id: "vault_no_refresh", archivedAt: null };
    const store = new MemoryCredentialStore();
    const credentials = nativeOAuthCredentials({ workspaceId, store, nextId: () => "credential_saved",
      vaults: { retrieveVault: async () => ({ type: "found", vault }) } as never });
    const legacy = createInMemoryCredentialService().service;
    const state = new Map<string, string>();
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", workspaceId); await next(); });
    app.route("/oauth", buildOAuthRoutes({ env: {},
      ...(mode === "native" && { credentialsFor: () => credentials }),
      services: { credentials: legacy, vaults: { get: async () => vault }, kv: {
        get: async (key: string) => state.get(key) ?? null,
        put: async (key: string, value: string) => { state.set(key, value); },
        delete: async (key: string) => { state.delete(key); },
      } } as unknown as RouteServices,
    }));
    const clientId = "preset-client";
    const clientSecret = confidential ? "write-only-secret" : undefined;
    let tokenExchanges = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url));
      if (path.hostname === "mcp.test" && path.pathname.startsWith("/.well-known")) {
        return Response.json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://oauth.test"], scopes_supported: ["openid"] });
      }
      if (path.hostname === "oauth.test" && path.pathname.startsWith("/.well-known")) {
        // A non-DCR provider cannot recover a forgotten client_id itself.
        return Response.json({ issuer: "https://oauth.test", authorization_endpoint: "https://oauth.test/authorize", token_endpoint: "https://oauth.test/token" });
      }
      if (path.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe(clientId);
        if (basic && tokenExchanges++ > 0) {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa(`${clientId}:${clientSecret}`)}`);
          expect(body.has("client_secret")).toBe(false);
        } else expect(body.get("client_secret")).toBe(clientSecret ?? null);
        return Response.json({ access_token: "access-without-refresh", expires_in: 3600 });
      }
      if (path.href === "https://mcp.test/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      throw new Error(`Unexpected offline request ${path.pathname}`);
    });
    const params = new URLSearchParams({ vault_id: vault.id, mcp_server_url: "https://mcp.test/mcp", client_id: clientId, scope: "extra" });
    if (clientSecret) params.set("client_secret", clientSecret);
    const connected = await app.request(`/oauth/authorize?${params}`);
    expect(connected.status).toBe(302);
    const redirect = new URL(connected.headers.get("location")!);
    const callback = await app.request(`/oauth/callback?state=${redirect.searchParams.get("state")}&code=first-code`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).not.toContain("write-only-secret");
    const nativeRecords = await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true });
    const legacyRecords = await legacy.list({ tenantId: workspaceId, vaultId: vault.id });
    const credentialId = mode === "native" ? nativeRecords[0]!.credential.id : legacyRecords[0]!.id;
    if (mode === "native") {
      expect(nativeRecords[0]!.credential.auth).toMatchObject({ clientId, tokenEndpointAuth: confidential
        ? { type: "client_secret_post", clientSecret } : { type: "none" } });
      expect(nativeRecords[0]!.credential.auth).not.toHaveProperty("refresh");
      if (basic) {
        const record = nativeRecords[0]!;
        if (record.credential.auth.type !== "mcp_oauth") throw new Error("Expected OAuth credential");
        await store.replace({ workspaceId, vaultId: vault.id, credentialId, expectedRevision: record.revision,
          next: { ...record.credential, auth: { ...record.credential.auth,
            tokenEndpointAuth: { type: "client_secret_basic", clientSecret: clientSecret! } } } });
      }
      const views = new CredentialsApplicationService({ workspaceId, store } as never);
      expect(JSON.stringify(await views.retrieveCredential({ vaultId: vault.id, credentialId }))).not.toContain("write-only-secret");
    }
    params.delete("client_id");
    params.delete("client_secret");
    params.delete("scope");
    params.set("credential_id", credentialId);
    const reconnected = await app.request(`/oauth/authorize?${params}`);
    expect(reconnected.status, await reconnected.clone().text()).toBe(302);
    const reconnectRedirect = new URL(reconnected.headers.get("location")!);
    expect(reconnectRedirect.searchParams.get("client_id")).toBe(clientId);
    expect(reconnectRedirect.searchParams.get("scope")).toBe("openid extra");
    expect(reconnectRedirect.searchParams.has("client_secret")).toBe(false);
    const completed = await app.request(`/oauth/callback?state=${reconnectRedirect.searchParams.get("state")}&code=reconnect-code`);
    expect(completed.status).toBe(200);
    expect(await completed.text()).not.toContain("write-only-secret");
    if (mode === "native") {
      const saved = await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true });
      expect(saved).toHaveLength(1);
      expect(saved[0]!.credential.auth).toMatchObject({ clientId,
        tokenEndpointAuth: { type: basic ? "client_secret_basic" : confidential ? "client_secret_post" : "none" } });
      expect(saved[0]!.credential.auth).not.toHaveProperty("refresh");
    } else {
      expect(await legacy.list({ tenantId: workspaceId, vaultId: vault.id })).toHaveLength(1);
    }
  });

  it.each(["none", "client_secret_basic"] as const)("prefers top-level %s client settings over old refresh settings", async method => {
    const workspaceId = "workspace_precedence";
    const store = new MemoryCredentialStore();
    const credentials = nativeOAuthCredentials({ workspaceId, store, nextId: () => "credential_saved",
      vaults: { retrieveVault: async () => ({ type: "found", vault: { archivedAt: null } }) } as never });
    await credentials.saveGrant({ vaultId: "vault", displayName: "OAuth", auth: {
      type: "mcp_oauth", mcp_server_url: "https://mcp.test/mcp", access_token: "access", client_id: "top-client", client_secret: "top-secret",
    }, tokenEndpointAuthMethod: method });
    const location = { workspaceId, vaultId: "vault", credentialId: "credential_saved" };
    const record = (await store.find(location))!;
    await store.replace({ ...location, expectedRevision: record.revision, next: { ...record.credential,
      auth: { ...record.credential.auth, refresh: { clientId: "old-client", refreshToken: "old-refresh", tokenEndpoint: "https://oauth.test/token",
        tokenEndpointAuth: { type: "client_secret_post", clientSecret: "old-secret" } } } as never } });
    expect(await credentials.authorizationSettings("vault", "credential_saved")).toMatchObject({
      clientId: "top-client", clientSecret: method === "none" ? undefined : "top-secret", tokenEndpointAuthMethod: method,
    });
  });

  it("reuses the saved client and scopes, then replaces the existing credential", async () => {
    const workspaceId = "workspace_reconnect";
    const vault = { id: "vault_reconnect", archivedAt: null };
    const store = new MemoryCredentialStore();
    const credentials = nativeOAuthCredentials({
      workspaceId, store, nextId: () => "credential_original",
      vaults: { retrieveVault: async () => ({ type: "found", vault }) } as never,
    });
    const auth = { type: "mcp_oauth" as const, mcp_server_url: "https://mcp.test/mcp",
      access_token: "expired-access", refresh_token: "invalid-refresh", client_id: "existing-client",
      client_secret: "existing-client-secret", token_endpoint: "https://oauth.test/token", scope: "openid offline_access extra" };
    await credentials.saveGrant({ vaultId: vault.id, displayName: "Dendrite", auth });
    // Existing stored credentials only have refresh settings; keep reconnect
    // compatibility when the new independent client settings are absent.
    const location = { workspaceId, vaultId: vault.id, credentialId: "credential_original" };
    const record = (await store.find(location))!;
    if (record.credential.auth.type !== "mcp_oauth") throw new Error("Expected OAuth credential");
    const { clientId, tokenEndpointAuth, ...oldAuth } = record.credential.auth;
    await store.replace({ ...location, expectedRevision: record.revision, next: { ...record.credential, auth: oldAuth } });
    const state = new Map<string, string>();
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", workspaceId); await next(); });
    app.route("/oauth", buildOAuthRoutes({
      env: {}, credentialsFor: () => credentials,
      services: { kv: { get: async (key: string) => state.get(key) ?? null,
        put: async (key: string, value: string) => { state.set(key, value); },
        delete: async (key: string) => { state.delete(key); } } } as unknown as RouteServices,
    }));
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url));
      if (path.hostname === "mcp.test" && path.pathname.startsWith("/.well-known")) {
        return Response.json({ resource: auth.mcp_server_url, authorization_servers: ["https://oauth.test"], scopes_supported: ["openid"] });
      }
      if (path.hostname === "oauth.test" && path.pathname.startsWith("/.well-known")) {
        return Response.json({ issuer: "https://oauth.test", authorization_endpoint: "https://oauth.test/authorize",
          token_endpoint: "https://oauth.test/token", registration_endpoint: "https://oauth.test/register" });
      }
      if (path.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("existing-client");
        expect(body.get("client_secret")).toBe("existing-client-secret");
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      }
      if (path.hostname === "mcp.test" && path.pathname === "/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      throw new Error(`Unexpected request ${path.pathname}`);
    });
    const params = new URLSearchParams({ vault_id: vault.id, credential_id: "credential_original", mcp_server_url: auth.mcp_server_url });
    const response = await app.request(`/oauth/authorize?${params}`);
    expect(response.status, await response.clone().text()).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.searchParams.get("client_id")).toBe("existing-client");
    expect(redirect.searchParams.get("scope")).toBe(auth.scope);
    expect(redirect.searchParams.has("client_secret")).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
    const callback = await app.request(`/oauth/callback?state=${redirect.searchParams.get("state")}&code=authorization-code`);
    expect(callback.status, await callback.clone().text()).toBe(200);
    const records = await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true });
    expect(records).toHaveLength(1);
    expect(records[0]?.credential).toMatchObject({ id: "credential_original", displayName: "Dendrite",
      auth: { accessToken: "new-access", scope: auth.scope, refresh: { refreshToken: "new-refresh", clientId: "existing-client" } } });
  });
});
