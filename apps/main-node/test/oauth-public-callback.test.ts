// OAuth redirect URI behind a TLS-terminating proxy: the callback address
// sent to the provider must be the public https:// one (PUBLIC_BASE_URL, or
// the X-Forwarded-Proto scheme), must be reused verbatim for the token
// exchange, and a refused Dynamic Client Registration must surface the
// provider's reason instead of "does not support Dynamic Client Registration".
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildOAuthRoutes, nativeOAuthCredentials, type RouteServices } from "@open-managed-agents/http-routes";
import { MemoryCredentialStore } from "../../../packages/credential-store-memory/src/index";

afterEach(() => vi.restoreAllMocks());

const workspaceId = "workspace_public_callback";
const vault = { id: "vault_public_callback", archivedAt: null };
const mcpServerUrl = "https://mcp.test/mcp";

/** OAuth routes mounted at /v1/oma/oauth with in-memory state and credentials. */
function buildApp(env: Partial<Record<string, string>>) {
  const store = new MemoryCredentialStore();
  const credentials = nativeOAuthCredentials({
    workspaceId, store, nextId: () => "credential_new",
    vaults: { retrieveVault: async () => ({ type: "found", vault }) } as never,
  });
  const state = new Map<string, string>();
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", workspaceId); await next(); });
  app.route("/v1/oma/oauth", buildOAuthRoutes({
    env, credentialsFor: () => credentials,
    services: { kv: { get: async (key: string) => state.get(key) ?? null,
      put: async (key: string, value: string) => { state.set(key, value); },
      delete: async (key: string) => { state.delete(key); } } } as unknown as RouteServices,
  }));
  return { app, store };
}

/**
 * Fake MCP + auth server. Records the redirect URIs it sees at registration
 * and token exchange; `register` decides the registration response.
 */
function mockProvider(register: (redirectUris: string[]) => Response) {
  const seen = { registered: [] as string[], tokenRedirect: null as string | null };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url));
    if (path.hostname === "mcp.test" && path.pathname.startsWith("/.well-known")) {
      return Response.json({ resource: mcpServerUrl, authorization_servers: ["https://oauth.test"] });
    }
    if (path.hostname === "oauth.test" && path.pathname.startsWith("/.well-known")) {
      return Response.json({ issuer: "https://oauth.test", authorization_endpoint: "https://oauth.test/authorize",
        token_endpoint: "https://oauth.test/token", registration_endpoint: "https://oauth.test/register" });
    }
    if (path.pathname === "/register") {
      const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
      seen.registered.push(...body.redirect_uris);
      return register(body.redirect_uris);
    }
    if (path.pathname === "/token") {
      seen.tokenRedirect = new URLSearchParams(String(init?.body)).get("redirect_uri");
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    if (path.hostname === "mcp.test" && path.pathname === "/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    throw new Error(`Unexpected request ${path.href}`);
  });
  return seen;
}

const authorizePath = `/v1/oma/oauth/authorize?${new URLSearchParams({ vault_id: vault.id, mcp_server_url: mcpServerUrl })}`;

describe("OAuth public callback URI", () => {
  it("uses PUBLIC_BASE_URL for registration, authorize and token exchange", async () => {
    const { app, store } = buildApp({ PUBLIC_BASE_URL: "https://oma.example/" });
    const seen = mockProvider(() => Response.json({ client_id: "dcr-client" }));
    const expected = "https://oma.example/v1/oma/oauth/callback";

    // The request itself arrives as plain http, as it does behind nginx.
    const response = await app.request(`http://oma.example${authorizePath}`);
    expect(response.status, await response.clone().text()).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.searchParams.get("redirect_uri")).toBe(expected);
    expect(seen.registered).toEqual([expected]);

    const callback = await app.request(
      `http://oma.example/v1/oma/oauth/callback?state=${redirect.searchParams.get("state")}&code=authorization-code`,
    );
    expect(callback.status, await callback.clone().text()).toBe(200);
    expect(seen.tokenRedirect).toBe(expected);
    expect(await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true })).toHaveLength(1);
  });

  it("takes the https scheme from X-Forwarded-Proto when PUBLIC_BASE_URL is unset", async () => {
    const { app } = buildApp({});
    const seen = mockProvider(() => Response.json({ client_id: "dcr-client" }));

    const response = await app.request(`http://oma.example${authorizePath}`, { headers: { "x-forwarded-proto": "https" } });
    expect(response.status, await response.clone().text()).toBe(302);
    expect(seen.registered).toEqual(["https://oma.example/v1/oma/oauth/callback"]);
  });

  it("names the provider's reason when registration is refused", async () => {
    const { app } = buildApp({});
    mockProvider(() => Response.json({ error: "invalid_redirect_uri", error_description: "Redirect URI must use HTTPS" }, { status: 400 }));

    const response = await app.request(`http://oma.example${authorizePath}`);
    expect(response.status).toBe(502);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("HTTP 400");
    expect(error).toContain("Redirect URI must use HTTPS");
    expect(error).toContain("http://oma.example/v1/oma/oauth/callback");
    expect(error).not.toContain("does not support Dynamic Client Registration");
  });
});
