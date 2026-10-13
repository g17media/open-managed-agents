// OAuth redirect URI behind a TLS-terminating proxy: the callback address
// sent to the provider must be the public https:// one (PUBLIC_BASE_URL, or
// the X-Forwarded-Proto scheme), must be reused verbatim for the token
// exchange, and a refused Dynamic Client Registration must surface the
// provider's reason instead of "does not support Dynamic Client Registration".
// Also pins the callback pages against markup injection from provider text
// and caller-supplied return URLs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildOAuthRoutes, nativeOAuthCredentials, type RouteServices } from "@open-managed-agents/http-routes";
import { MemoryCredentialStore } from "../../../packages/credential-store-memory/src/index";

afterEach(() => vi.restoreAllMocks());

const workspaceId = "workspace_public_callback";
const vault = { id: "vault_public_callback", archivedAt: null };
const mcpServerUrl = "https://mcp.test/mcp";
const refusal = { error: "invalid_redirect_uri", error_description: "Redirect URI must use HTTPS" };

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
 * and token exchange. `register` decides the registration response, `probe`
 * the MCP server's answer to the post-grant tools/list probe, and `issuer`
 * lets a test pose as a known provider.
 */
function mockProvider(options: {
  register: (redirectUris: string[]) => Response;
  probe?: () => Response;
  issuer?: string;
}) {
  const issuer = options.issuer ?? "https://oauth.test";
  const seen = { registered: [] as string[], tokenRedirect: null as string | null };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url));
    if (path.hostname === "mcp.test" && path.pathname.startsWith("/.well-known")) {
      return Response.json({ resource: mcpServerUrl, authorization_servers: ["https://oauth.test"] });
    }
    if (path.hostname === "oauth.test" && path.pathname.startsWith("/.well-known")) {
      return Response.json({ issuer, authorization_endpoint: "https://oauth.test/authorize",
        token_endpoint: "https://oauth.test/token", registration_endpoint: "https://oauth.test/register" });
    }
    if (path.pathname === "/register") {
      const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
      seen.registered.push(...body.redirect_uris);
      return options.register(body.redirect_uris);
    }
    if (path.pathname === "/token") {
      seen.tokenRedirect = new URLSearchParams(String(init?.body)).get("redirect_uri");
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    if (path.hostname === "mcp.test" && path.pathname === "/mcp") {
      return options.probe?.() ?? Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }
    throw new Error(`Unexpected request ${path.href}`);
  });
  return seen;
}

/** Authorize query for the test vault, plus any extra parameters. */
function authorizePath(extra: Record<string, string> = {}): string {
  return `/v1/oma/oauth/authorize?${new URLSearchParams({ vault_id: vault.id, mcp_server_url: mcpServerUrl, ...extra })}`;
}

/** Follow an authorize redirect back into the callback with a code. */
function callbackPath(authorize: Response): string {
  const state = new URL(authorize.headers.get("location")!).searchParams.get("state");
  return `/v1/oma/oauth/callback?state=${state}&code=authorization-code`;
}

const registered = () => Response.json({ client_id: "dcr-client" });

describe("OAuth public callback URI", () => {
  it("uses PUBLIC_BASE_URL for registration, authorize and token exchange", async () => {
    const { app, store } = buildApp({ PUBLIC_BASE_URL: "https://oma.example/" });
    const seen = mockProvider({ register: registered });
    const expected = "https://oma.example/v1/oma/oauth/callback";

    // Requests reach the server as plain http on its internal address, as
    // they do behind nginx; the configured public origin must win over both.
    const response = await app.request(`http://oma-server:8787${authorizePath()}`);
    expect(response.status, await response.clone().text()).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("redirect_uri")).toBe(expected);
    expect(seen.registered).toEqual([expected]);

    const callback = await app.request(`http://oma-server:8787${callbackPath(response)}`);
    expect(callback.status, await callback.clone().text()).toBe(200);
    expect(seen.tokenRedirect).toBe(expected);
    expect(await store.list({ workspaceId, vaultId: vault.id, limit: 10, includeArchived: true })).toHaveLength(1);
  });

  it("takes the https scheme from X-Forwarded-Proto and reuses the authorize callback for the token exchange", async () => {
    const { app } = buildApp({});
    const seen = mockProvider({ register: registered });
    const expected = "https://oma.example/v1/oma/oauth/callback";

    const response = await app.request(`http://oma.example${authorizePath()}`, { headers: { "x-forwarded-proto": "https" } });
    expect(response.status, await response.clone().text()).toBe(302);
    expect(seen.registered).toEqual([expected]);

    // The callback arrives without the header and on another host: re-deriving
    // the callback here would send the provider a different redirect_uri.
    const callback = await app.request(`http://10.0.0.5:8787${callbackPath(response)}`);
    expect(callback.status, await callback.clone().text()).toBe(200);
    expect(seen.tokenRedirect).toBe(expected);
  });

  it("names the provider's reason when registration is refused", async () => {
    const { app } = buildApp({});
    mockProvider({ register: () => Response.json(refusal, { status: 400 }) });

    const response = await app.request(`http://oma.example${authorizePath()}`);
    expect(response.status).toBe(502);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("HTTP 400");
    expect(error).toContain("Redirect URI must use HTTPS");
    expect(error).toContain("http://oma.example/v1/oma/oauth/callback");
    expect(error).not.toContain("does not support Dynamic Client Registration");
  });

  it("keeps the refusal reason in a known provider's setup error", async () => {
    const { app } = buildApp({});
    mockProvider({ register: () => Response.json(refusal, { status: 400 }), issuer: "https://accounts.feishu.cn/oauth" });

    const response = await app.request(`http://oma.example${authorizePath()}`);
    expect(response.status).toBe(501);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("FEISHU_OAUTH_CLIENT_ID");
    expect(error).toContain("Redirect URI must use HTTPS");
  });
});

describe("OAuth callback page injection", () => {
  it("escapes a provider error description on the callback page", async () => {
    const { app } = buildApp({});
    const payload = "<script>alert(document.cookie)</script>";

    const response = await app.request(
      `/v1/oma/oauth/callback?${new URLSearchParams({ error: "access_denied", error_description: payload })}`,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain(payload);
    expect(html).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
  });

  it("keeps an MCP server's probe error inside the success page script", async () => {
    const { app } = buildApp({});
    const payload = "</script><script>globalThis.injected=1</script>";
    mockProvider({ register: registered, probe: () => new Response(payload, { status: 403 }) });

    const response = await app.request(authorizePath());
    const callback = await app.request(callbackPath(response));
    expect(callback.status, await callback.clone().text()).toBe(200);
    const html = await callback.text();
    // Only the page's own closing tag may appear; the payload's must be escaped.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>globalThis.injected");
    expect(html).toContain("\\u003c/script>\\u003cscript>globalThis.injected=1\\u003c/script>");
  });

  it("refuses a return URI that is not http or https", async () => {
    const { app } = buildApp({});
    const network = mockProvider({ register: registered });

    for (const redirectUri of ["data:text/html,<script>1</script>", "javascript:alert(1)", "not a url"]) {
      const response = await app.request(authorizePath({ redirect_uri: redirectUri }));
      expect(response.status, redirectUri).toBe(400);
    }
    expect(network.registered).toEqual([]);

    // The CLI's plain-http localhost listener stays allowed.
    const cli = await app.request(authorizePath({ redirect_uri: "http://localhost:19500/callback" }));
    expect(cli.status, await cli.clone().text()).toBe(302);
  });
});
