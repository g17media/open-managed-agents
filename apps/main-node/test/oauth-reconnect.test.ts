import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildOAuthRoutes, nativeOAuthCredentials, type RouteServices } from "@open-managed-agents/http-routes";
import { MemoryCredentialStore } from "../../../packages/credential-store-memory/src/index";

afterEach(() => vi.restoreAllMocks());

describe("OAuth credential reconnection", () => {
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
