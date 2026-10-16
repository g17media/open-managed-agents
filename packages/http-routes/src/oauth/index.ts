import { Hono } from "hono";
import { logWarn } from "@open-managed-agents/shared";
import type { CredentialAuth } from "@open-managed-agents/shared";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

export interface OAuthCredentialPersistence {
  vaultExists(vaultId: string): Promise<boolean>;
  authorizationSettings(vaultId: string, credentialId: string): Promise<{
    scope?: string; clientId?: string; clientSecret?: string;
    tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  } | null>;
  saveGrant(input: { vaultId: string; credentialId?: string; displayName: string; auth: CredentialAuth;
    tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post" }): Promise<string>;
  saveCliGrant(input: { vaultId: string; cliId: string; auth: CredentialAuth }): Promise<string>;
  refresh(vaultId: string, credentialId: string): Promise<{ expires_at?: string | null }>;
}

export interface OAuthRoutesDeps {
  credentialsFor?: (workspaceId: string) => OAuthCredentialPersistence | Promise<OAuthCredentialPersistence>;
  services: RouteServicesArg;
  /** CF passes worker env, Node passes process.env. Only PUBLIC_BASE_URL
   *  (the public origin for the callback URI) and the provider OAuth client
   *  credentials (<PROVIDER>_OAUTH_CLIENT_ID/_SECRET) are read. */
  env: Partial<Record<string, string>>;
}

export function buildOAuthRoutes(deps: OAuthRoutesDeps) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();

  // ─── Helpers ───

  /** Escape text for an HTML page. The callback pages echo
   *  `error_description` (anyone can set it through a crafted callback URL)
   *  and provider-controlled text such as token-endpoint error bodies —
   *  unescaped, that is script on the console origin running with the
   *  visitor's session. */
  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** JSON for an inline <script>. JSON.stringify leaves `</script>` and
   *  `<!--` intact, so a value carrying them (an MCP server's probe error
   *  body, a crafted return URL) would end the script early and run its own
   *  markup; writing every `<` as < keeps it inside the string. */
  function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c");
  }

  /** True for an absolute http: or https: URL. */
  function isHttpUrl(value: string): boolean {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  /** Generate a cryptographically random string for PKCE and state. */
  function randomString(length: number): string {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
  }

  /** SHA-256 hash as base64url (for PKCE S256). */
  async function sha256Base64url(value: string): Promise<string> {
    const encoded = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    const bytes = new Uint8Array(hash);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /**
   * Public origin that the browser and the OAuth provider see for this server.
   *
   * PUBLIC_BASE_URL wins when set. Self-hosted Node runs behind a proxy that
   * terminates TLS and forwards plain http://, so the request URL alone hands
   * the provider an http:// redirect URI — which providers such as StackOne
   * refuse, first at Dynamic Client Registration and again on their authorize
   * page. Without the setting, the request URL is used, upgraded to https when
   * the proxy reports a TLS client connection (X-Forwarded-Proto). Only the
   * scheme is taken from the header; the host always comes from the request.
   */
  function getBaseUrl(c: { req: { url: string; header(name: string): string | undefined } }): string {
    const configured = deps.env.PUBLIC_BASE_URL?.trim();
    if (configured) return configured.replace(/\/+$/, "");
    const url = new URL(c.req.url);
    const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return `${forwardedProto === "https" ? "https:" : url.protocol}//${url.host}`;
  }

  /**
   * Probe an MCP server with a freshly-obtained bearer token. POSTs
   * `tools/list`, classifies the response:
   *
   *   2xx → server accepted the token, model will see typed tools
   *   401/403 → token rejected (likely scope-insufficient or vendor toggle off)
   *   anything else → unknown; surface the upstream HTTP status
   *
   * 5s timeout. Failures here NEVER roll back the credential — it's already
   * persisted; this is purely descriptive ("we just stored a token that
   * works" / "we stored a token but the server rejects it; here's why").
   */
  async function probeMcpServer(
    url: string,
    bearerToken: string,
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 200 && res.status < 300) return { ok: true };
      const body = await res.text().catch(() => "");
      // Surface vendor-specific guidance verbatim when present (e.g. Slack's
      // "App is not enabled for Slack MCP server access. Please enable it
      // here: <url>"). Truncate to keep the URL-encoded query param sane.
      const slice = body.slice(0, 240).trim();
      return {
        ok: false,
        message: `MCP probe HTTP ${res.status}${slice ? `: ${slice}` : ""}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `MCP probe failed: ${msg.slice(0, 120)}` };
    }
  }

  // ─── MCP OAuth Metadata Discovery ───

  interface ProtectedResourceMeta {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
  }

  interface AuthServerMeta {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
  }

  /**
   * Discover OAuth metadata for an MCP server.
   * Follows the MCP spec: fetch Protected Resource Metadata → fetch Auth Server Metadata.
   */
  async function discoverOAuthMeta(mcpServerUrl: string): Promise<{
    resource: ProtectedResourceMeta;
    authServer: AuthServerMeta;
  }> {
    const url = new URL(mcpServerUrl);
    const origin = url.origin;
    // RFC 9728 path-based discovery: a resource at https://api.example.com/mcp
    // publishes its PRM at https://api.example.com/.well-known/oauth-protected-resource/mcp.
    // The MCP server URL's path is treated as part of the resource identifier.
    // Strip a single trailing slash so /mcp/ and /mcp produce the same probe.
    const path = url.pathname.replace(/\/+$/, "");

    // Step 1: Protected Resource Metadata.
    // Probe order:
    //   a. path-based  ${origin}/.well-known/oauth-protected-resource${path}
    //      — RFC 9728 §3.1, what GitHub Copilot MCP and Feishu MCP serve.
    //   b. origin-only ${origin}/.well-known/oauth-protected-resource
    //      — fallback for resources whose origin and path coincide.
    // Both are GET; first 200 wins. 404 on (a) is normal — many resources
    // only publish (b). Network errors abort the chain.
    const candidates: string[] = [];
    if (path) candidates.push(`${origin}/.well-known/oauth-protected-resource${path}`);
    candidates.push(`${origin}/.well-known/oauth-protected-resource`);

    let resource: ProtectedResourceMeta | null = null;
    let lastErr = "";
    for (const candidateUrl of candidates) {
      const res = await fetch(candidateUrl);
      if (res.ok) {
        resource = (await res.json()) as ProtectedResourceMeta;
        break;
      }
      lastErr = `${candidateUrl}: ${res.status}`;
    }
    if (!resource) {
      throw new Error(`Failed to fetch Protected Resource Metadata (tried ${candidates.length}): ${lastErr}`);
    }

    if (!resource.authorization_servers?.length) {
      throw new Error("No authorization_servers in Protected Resource Metadata");
    }

    // Step 2: Auth Server Metadata.
    // RFC 8414 §3: the well-known segment is inserted between origin and
    // path of the issuer URL — NOT appended to the issuer URL. So issuer
    // `https://accounts.feishu.cn/mcp` → ASM at
    // `https://accounts.feishu.cn/.well-known/oauth-authorization-server/mcp`.
    // Probe order:
    //   a. RFC 8414 path-based ${origin}/.well-known/oauth-authorization-server${path}
    //   b. OpenID Connect path-based ${origin}/.well-known/openid-configuration${path}
    //      (some providers serve OIDC discovery instead of OAuth ASM)
    //   c. RFC 8414 origin-only fallback
    //   d. OIDC origin-only fallback
    //   e. Naive issuer-suffix (legacy ${issuer}/.well-known/...) — what older
    //      MCP clients used; some servers still serve this for backward compat.
    // Plus a hard-coded fallback for known providers that don't publish any
    // ASM at all (GitHub).
    const authServerUrl = resource.authorization_servers[0];
    const asmIssuer = new URL(authServerUrl);
    const asmOrigin = asmIssuer.origin;
    const asmPath = asmIssuer.pathname.replace(/\/+$/, "");
    const asmCandidates: string[] = [];
    if (asmPath) {
      asmCandidates.push(`${asmOrigin}/.well-known/oauth-authorization-server${asmPath}`);
      asmCandidates.push(`${asmOrigin}/.well-known/openid-configuration${asmPath}`);
    }
    asmCandidates.push(`${asmOrigin}/.well-known/oauth-authorization-server`);
    asmCandidates.push(`${asmOrigin}/.well-known/openid-configuration`);
    asmCandidates.push(`${authServerUrl}/.well-known/oauth-authorization-server`);

    let authServer: AuthServerMeta | null = null;
    let asmLastErr = "";
    for (const candidateUrl of asmCandidates) {
      const res = await fetch(candidateUrl);
      if (res.ok) {
        authServer = (await res.json()) as AuthServerMeta;
        break;
      }
      asmLastErr = `${candidateUrl}: ${res.status}`;
    }

    // Hard-coded fallback for known providers that don't publish an ASM.
    // GitHub OAuth (issuer `https://github.com/login/oauth`) returns 404
    // on every well-known probe — but the endpoints are stable + public.
    if (!authServer && /^https:\/\/github\.com\/login\/oauth\/?$/.test(authServerUrl)) {
      authServer = {
        issuer: "https://github.com/login/oauth",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
      };
    }

    if (!authServer) {
      throw new Error(`Failed to fetch Auth Server Metadata (tried ${asmCandidates.length}): ${asmLastErr}`);
    }

    if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
      throw new Error("Auth Server Metadata missing authorization_endpoint or token_endpoint");
    }

    return { resource, authServer };
  }

  /**
   * Attempt Dynamic Client Registration (RFC 7591) with the auth server.
   *
   * Registers a public client whose only redirect URI is `redirectUri`.
   * Returns the issued client on success, or the reason registration failed.
   * Failure is not fatal — the caller falls back to preset client
   * credentials — but the reason is kept so the final error names it.
   */
  async function dynamicClientRegistration(
    registrationEndpoint: string,
    redirectUri: string,
  ): Promise<
    | { ok: true; client_id: string; client_secret?: string }
    | { ok: false; reason: string }
  > {
    try {
      const res = await fetch(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Open Managed Agents",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none", // public client
        }),
      });
      if (!res.ok) {
        // Providers explain a refusal in the body (StackOne, for one, rejects
        // a non-HTTPS redirect URI here). Without it the caller could only
        // claim the server "does not support Dynamic Client Registration",
        // which sends the operator after the wrong problem.
        const body = (await res.text().catch(() => "")).slice(0, 300).trim();
        logWarn(
          { op: "oauth.dcr_register", status: res.status, registration_endpoint: registrationEndpoint, redirect_uri: redirectUri, body },
          "OAuth DCR register rejected; caller will fall back",
        );
        return { ok: false, reason: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
      }
      const data = (await res.json()) as { client_id?: string; client_secret?: string };
      if (!data.client_id) return { ok: false, reason: "response carried no client_id" };
      return { ok: true, client_id: data.client_id, client_secret: data.client_secret };
    } catch (err) {
      // Network or JSON failure. Persistent failures here block per-server
      // OAuth onboarding entirely, so we want visibility.
      logWarn(
        { op: "oauth.dcr_register", err },
        "OAuth DCR register failed; caller will fall back",
      );
      return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) };
    }
  }

  // ─── OAuth State (stored in KV, TTL 10 minutes) ───

  interface OAuthState {
    tenant_id: string;
    vault_id: string;
    credential_id?: string;
    mcp_server_url: string;
    code_verifier: string;
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
    token_endpoint: string;
    authorization_server: string;
    redirect_uri: string;
    /** The exact redirect_uri sent to the provider's authorize endpoint. */
    callback_uri?: string;
    resource_uri: string;
    scope?: string;
  }

  // ─── Routes ───

  /**
   * GET /v1/oma/oauth/authorize
   *
   * Starts the MCP OAuth 2.1 flow. Discovers OAuth endpoints from the
   * MCP server's .well-known metadata, then redirects to the authorization page.
   *
   * Query params:
   *   - mcp_server_url (required): The MCP server URL to authorize with
   *   - vault_id (required): Vault to store the credential in
   *   - credential_id (optional): Update existing credential instead of creating new
   *   - redirect_uri (optional): Where to redirect after auth (defaults to console)
   *   - scope (optional): Space-delimited scopes to request IN ADDITION to
   *     whatever the server's Protected Resource Metadata advertises — e.g.
   *     `offline_access` for auth servers that only issue refresh tokens
   *     when it's requested. Persisted on the credential and reused as the
   *     default on re-authorization.
   *   - active_tenant (optional): consumed by the auth middleware, not this
   *     route — pins the tenant for cookie-authenticated navigations that
   *     can't send the x-active-tenant header (this route opens in a popup).
   *     Membership-validated; without it the session's default tenant is
   *     used and non-default-tenant vaults 404.
   */
  app.get("/authorize", async (c) => {
    const services = resolveServices(deps.services, c);
    const mcpServerUrl = c.req.query("mcp_server_url");
    const vaultId = c.req.query("vault_id");
    const credentialId = c.req.query("credential_id");
    const clientRedirectUri = c.req.query("redirect_uri");
    let extraScope = c.req.query("scope")?.trim() ?? "";

    if (!mcpServerUrl || !vaultId) {
      return c.json({ error: "mcp_server_url and vault_id are required" }, 400);
    }

    // The return URI becomes the success page's fallback navigation target,
    // so only http(s) is accepted: a javascript: or data: URL there would run
    // on this origin. Plain http stays allowed for the CLI's localhost listener.
    if (clientRedirectUri && !isHttpUrl(clientRedirectUri)) {
      return c.json({ error: "redirect_uri must be an http or https URL" }, 400);
    }

    // Verify vault exists. Vaults live in D1 (vaults-store) since the
    // KV → D1 migration; this route was missed in that sweep — every
    // OAuth flow returned 404 "Vault not found" because KV was always
    // empty. Read via the service like every other route does.
    const t = c.get("tenant_id");
    const native = await deps.credentialsFor?.(t);
    const vault = native ? await native.vaultExists(vaultId) : await services.vaults.get({ tenantId: t, vaultId });
    if (!vault) {
      return c.json({ error: "Vault not found" }, 404);
    }

    // Re-authorization of an existing credential with no explicit scope
    // override: reuse the scopes stored on the credential so user-added
    // scopes survive reconnects.
    let savedAuthorization = credentialId && native
      ? await native.authorizationSettings(vaultId, credentialId)
      : null;
    if (credentialId && !native) {
      const existing = await services.credentials
        .get({ tenantId: t, vaultId, credentialId })
        .catch(() => null);
      // Legacy credentials already persist the client outside refresh state;
      // reconnect must reuse it before attempting DCR or provider presets.
      if (existing?.auth.type === "mcp_oauth" && !existing.archived_at) {
        savedAuthorization = { scope: existing.auth.scope,
          clientId: existing.auth.client_id, clientSecret: existing.auth.client_secret };
      }
    }
    if (credentialId && !savedAuthorization) return c.json({ error: "Credential not found" }, 404);
    if (!extraScope && savedAuthorization) extraScope = savedAuthorization.scope ?? "";

    const baseUrl = getBaseUrl(c);
    const callbackUri = `${baseUrl}/v1/oma/oauth/callback`;

    // Discover OAuth metadata from the MCP server
    let meta: Awaited<ReturnType<typeof discoverOAuthMeta>>;
    try {
      meta = await discoverOAuthMeta(mcpServerUrl);
    } catch (err) {
      return c.json({ error: `OAuth discovery failed: ${(err as Error).message}` }, 502);
    }

    // Caller-supplied OAuth client credentials. Highest priority — when
    // present, skip DCR and the env-preset fallback. Lets the user pin a
    // specific OAuth App per credential (e.g. their own GitHub OAuth App
    // when the worker doesn't have GITHUB_OAUTH_CLIENT_ID set, or when they
    // want to use different scopes than the worker default).
    const callerClientId = c.req.query("client_id");
    const callerClientSecret = c.req.query("client_secret");

    // Dynamic Client Registration if supported (skipped when caller supplied creds).
    let clientId: string | null = callerClientId || savedAuthorization?.clientId || null;
    let clientSecret: string | undefined = callerClientSecret ||
      ((!callerClientId || callerClientId === savedAuthorization?.clientId)
        ? savedAuthorization?.clientSecret : undefined);
    let registrationFailure: string | null = null;
    if (!clientId && meta.authServer.registration_endpoint) {
      const reg = await dynamicClientRegistration(
        meta.authServer.registration_endpoint,
        callbackUri,
      );
      if (reg.ok) {
        clientId = reg.client_id;
        clientSecret = reg.client_secret;
      } else {
        registrationFailure = reg.reason;
      }
    }
    // Appended to the preset setup errors below, so a provider that offers
    // registration but refused ours (Feishu, Lark, ClickUp) still reports why.
    const registrationNote = registrationFailure
      ? ` Dynamic Client Registration at ${meta.authServer.registration_endpoint} was refused (${registrationFailure}) for redirect URI ${callbackUri}.`
      : "";

    // Known-provider preset: GitHub OAuth doesn't support DCR. Operator
    // must pre-register an OAuth App at https://github.com/settings/developers
    // (Authorization callback URL = ${baseUrl}/v1/oma/oauth/callback) and set
    // GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET env vars on the
    // main worker. Without them this MCP server can't onboard.
    if (!clientId && /^https:\/\/github\.com\/login\/oauth\/?$/.test(meta.authServer.issuer)) {
      if (deps.env.GITHUB_OAUTH_CLIENT_ID && deps.env.GITHUB_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.GITHUB_OAUTH_CLIENT_ID;
        clientSecret = deps.env.GITHUB_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "GitHub OAuth requires a pre-registered OAuth App: visit https://github.com/settings/developers, create an App with callback " +
              `${callbackUri}, then set GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // Known-provider preset: Feishu MCP exposes a DCR endpoint but rejects
    // arbitrary redirect_uris (returns invalid_redirect_uri unless the
    // domain is on their partner-portal allowlist). Operator workflow:
    // register an app at https://open.feishu.cn (Web App, redirect URL =
    // ${baseUrl}/v1/oma/oauth/callback), then set FEISHU_OAUTH_CLIENT_ID +
    // FEISHU_OAUTH_CLIENT_SECRET on the main worker.
    if (!clientId && /^https:\/\/accounts\.feishu\.cn\//.test(meta.authServer.issuer)) {
      if (deps.env.FEISHU_OAUTH_CLIENT_ID && deps.env.FEISHU_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.FEISHU_OAUTH_CLIENT_ID;
        clientSecret = deps.env.FEISHU_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "Feishu MCP OAuth requires a pre-registered Feishu app: visit https://open.feishu.cn, create a Web App with redirect URL " +
              `${callbackUri}, then set FEISHU_OAUTH_CLIENT_ID + FEISHU_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // Known-provider preset: Lark MCP is the international counterpart of
    // Feishu — same vendor (ByteDance) but a separate developer console
    // (open.larksuite.com vs open.feishu.cn) and separate OAuth Apps.
    // Same DCR-rejection behavior as Feishu. Operator workflow: register
    // an app at https://open.larksuite.com (Web App, redirect URL =
    // ${baseUrl}/v1/oma/oauth/callback), then set LARK_OAUTH_CLIENT_ID +
    // LARK_OAUTH_CLIENT_SECRET on the main worker.
    if (!clientId && /^https:\/\/accounts\.larksuite\.com\//.test(meta.authServer.issuer)) {
      if (deps.env.LARK_OAUTH_CLIENT_ID && deps.env.LARK_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.LARK_OAUTH_CLIENT_ID;
        clientSecret = deps.env.LARK_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "Lark MCP OAuth requires a pre-registered Lark app: visit https://open.larksuite.com, create a Web App with redirect URL " +
              `${callbackUri}, then set LARK_OAUTH_CLIENT_ID + LARK_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // Known-provider preset: Asana publishes ASM but no registration_endpoint.
    // Operator workflow: visit https://app.asana.com/0/my-apps, create an
    // OAuth app with redirect URL ${baseUrl}/v1/oma/oauth/callback, then set
    // ASANA_OAUTH_CLIENT_ID + ASANA_OAUTH_CLIENT_SECRET on the main worker.
    if (!clientId && /^https:\/\/app\.asana\.com\/?$/.test(meta.authServer.issuer)) {
      if (deps.env.ASANA_OAUTH_CLIENT_ID && deps.env.ASANA_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.ASANA_OAUTH_CLIENT_ID;
        clientSecret = deps.env.ASANA_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "Asana MCP OAuth requires a pre-registered Asana app: visit https://app.asana.com/0/my-apps, create an OAuth app with redirect URL " +
              `${callbackUri}, then set ASANA_OAUTH_CLIENT_ID + ASANA_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // Known-provider preset: ClickUp exposes a DCR endpoint but gates it
    // behind an allowlist form (returns invalid_request: "integration is
    // not currently allowlisted"). Operator workflow: visit
    // https://app.clickup.com/settings/apps, create an OAuth app with
    // redirect URL ${baseUrl}/v1/oma/oauth/callback, then set
    // CLICKUP_OAUTH_CLIENT_ID + CLICKUP_OAUTH_CLIENT_SECRET on the main worker.
    if (!clientId && /^https:\/\/mcp\.clickup\.com\/?$/.test(meta.authServer.issuer)) {
      if (deps.env.CLICKUP_OAUTH_CLIENT_ID && deps.env.CLICKUP_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.CLICKUP_OAUTH_CLIENT_ID;
        clientSecret = deps.env.CLICKUP_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "ClickUp MCP OAuth requires a pre-registered ClickUp app: visit https://app.clickup.com/settings/apps, create an OAuth app with redirect URL " +
              `${callbackUri}, then set CLICKUP_OAUTH_CLIENT_ID + CLICKUP_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // Known-provider preset: Slack publishes ASM but no registration_endpoint.
    // Note: distinct from SLACK_CLIENT_ID/SECRET used by `oma slack bind`'s
    // per-installation App flow — that's a different OAuth App with bot
    // scopes for the integrations gateway. This one is for the Slack MCP
    // server (https://mcp.slack.com/mcp) and uses user-scope tokens.
    // Operator workflow: visit https://api.slack.com/apps, create an app
    // with redirect URL ${baseUrl}/v1/oma/oauth/callback, then set
    // SLACK_OAUTH_CLIENT_ID + SLACK_OAUTH_CLIENT_SECRET on the main worker.
    if (!clientId && /^https:\/\/slack\.com\/?$/.test(meta.authServer.issuer)) {
      if (deps.env.SLACK_OAUTH_CLIENT_ID && deps.env.SLACK_OAUTH_CLIENT_SECRET) {
        clientId = deps.env.SLACK_OAUTH_CLIENT_ID;
        clientSecret = deps.env.SLACK_OAUTH_CLIENT_SECRET;
      } else {
        return c.json(
          {
            error:
              "Slack MCP OAuth requires a pre-registered Slack app: visit https://api.slack.com/apps, create an app with redirect URL " +
              `${callbackUri}, then set SLACK_OAUTH_CLIENT_ID + SLACK_OAUTH_CLIENT_SECRET on the main worker.${registrationNote}`,
          },
          501,
        );
      }
    }

    // The server offers registration but refused ours: report the provider's
    // reason and the redirect URI we sent, since "does not support Dynamic
    // Client Registration" would be false here.
    if (!clientId && registrationFailure) {
      return c.json(
        {
          error: `Dynamic Client Registration at ${meta.authServer.registration_endpoint} failed (${registrationFailure}) for redirect URI ${callbackUri}, and no preset client_id is configured for issuer ${meta.authServer.issuer}.`,
        },
        502,
      );
    }

    if (!clientId) {
      return c.json(
        {
          error: `MCP server ${mcpServerUrl} does not support Dynamic Client Registration and no preset client_id is configured for issuer ${meta.authServer.issuer}.`,
        },
        501,
      );
    }

    // Generate PKCE pair
    const codeVerifier = randomString(64);
    const codeChallenge = await sha256Base64url(codeVerifier);

    // Generate state
    const state = randomString(32);

    // Requested scope = PRM-advertised scopes ∪ caller-supplied extras.
    // Order-preserving dedupe; empty → no scope param at all (server
    // default), matching prior behavior.
    const requestedScopes: string[] = [];
    for (const s of [
      ...(meta.resource.scopes_supported ?? []),
      ...extraScope.split(/\s+/).filter(Boolean),
    ]) {
      if (!requestedScopes.includes(s)) requestedScopes.push(s);
    }
    const requestedScope = requestedScopes.join(" ");

    // Store state in KV (10 minute TTL)
    const oauthState: OAuthState = {
      tenant_id: t,
      vault_id: vaultId,
      credential_id: credentialId,
      mcp_server_url: mcpServerUrl,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
      token_endpoint_auth_method: clientSecret
        ? (!callerClientSecret && (!callerClientId || callerClientId === savedAuthorization?.clientId)
          ? savedAuthorization?.tokenEndpointAuthMethod ?? "client_secret_post" : "client_secret_post")
        : "none",
      token_endpoint: meta.authServer.token_endpoint,
      authorization_server: meta.authServer.issuer,
      redirect_uri: clientRedirectUri || `${baseUrl}/`,
      callback_uri: callbackUri,
      resource_uri: meta.resource.resource,
      scope: requestedScope || undefined,
    };

    await services.kv.put(
      `oauth_state:${state}`,
      JSON.stringify(oauthState),
      { expirationTtl: 600 },
    );

    // Build authorization URL
    const authUrl = new URL(meta.authServer.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", callbackUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", meta.resource.resource);
    if (requestedScope) {
      authUrl.searchParams.set("scope", requestedScope);
    }

    return c.redirect(authUrl.toString());
  });

  /**
   * GET /v1/oma/oauth/callback
   *
   * OAuth callback handler. Exchanges authorization code for tokens,
   * creates/updates credential in vault, redirects user back to console.
   */
  app.get("/callback", async (c) => {
    const services = resolveServices(deps.services, c);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      const desc = c.req.query("error_description") || error;
      return c.html(`<html><body><h2>Authorization failed</h2><p>${escapeHtml(desc)}</p><script>window.close()</script></body></html>`, 400);
    }

    if (!code || !state) {
      return c.json({ error: "code and state are required" }, 400);
    }

    // Look up state
    const stateKey = `oauth_state:${state}`;
    const stateData = await services.kv.get(stateKey);
    if (!stateData) {
      return c.json({ error: "Invalid or expired OAuth state" }, 400);
    }

    const oauthState: OAuthState = JSON.parse(stateData);

    // Exchange code for tokens. The token request must repeat the authorize
    // step's redirect_uri exactly (RFC 6749 §4.1.3), so reuse the stored one
    // rather than re-deriving it from this request, whose scheme or host can
    // differ behind a proxy. States written before callback_uri existed fall
    // back to the derived value.
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthState.callback_uri ?? `${getBaseUrl(c)}/v1/oma/oauth/callback`,
      client_id: oauthState.client_id,
      code_verifier: oauthState.code_verifier,
      resource: oauthState.resource_uri,
    });
    // Preserve a saved confidential client's authentication method across
    // reconnects; putting a Basic-only secret in the body can be rejected.
    const tokenHeaders = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      // GitHub defaults to form-encoded responses without this JSON opt-in.
      Accept: "application/json",
    });
    if (oauthState.client_secret && oauthState.token_endpoint_auth_method === "client_secret_basic") {
      tokenHeaders.set("Authorization", `Basic ${btoa(`${encodeURIComponent(oauthState.client_id)}:${encodeURIComponent(oauthState.client_secret)}`)}`);
    } else if (oauthState.client_secret && oauthState.token_endpoint_auth_method !== "none") {
      tokenBody.set("client_secret", oauthState.client_secret);
    }

    const tokenRes = await fetch(oauthState.token_endpoint, {
      method: "POST",
      headers: tokenHeaders,
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      await services.kv.delete(stateKey);
      return c.html(`<html><body><h2>Token exchange failed</h2><p>${escapeHtml(errBody)}</p><script>window.close()</script></body></html>`, 502);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    // Calculate expiry
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Derive display name from URL
    const mcpHost = new URL(oauthState.mcp_server_url).hostname;
    const serverName = mcpHost.replace(/^mcp\./, "").replace(/\.(com|app|dev|io)$/, "");

    // Create or update credential
    const credAuth: CredentialAuth = {
      type: "mcp_oauth",
      mcp_server_url: oauthState.mcp_server_url,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_endpoint: oauthState.token_endpoint,
      client_id: oauthState.client_id,
      client_secret: oauthState.client_secret,
      expires_at: expiresAt,
      authorization_server: oauthState.authorization_server,
      // Granted scope when the token response reports it (RFC 6749 §5.1),
      // else what we requested — the default for future re-authorizations.
      scope: tokens.scope || oauthState.scope,
    };

    const native = await deps.credentialsFor?.(oauthState.tenant_id);
    if (native) {
      await native.saveGrant({ vaultId: oauthState.vault_id, credentialId: oauthState.credential_id,
        displayName: `${serverName} (OAuth)`, auth: credAuth,
        tokenEndpointAuthMethod: oauthState.token_endpoint_auth_method });
    } else if (oauthState.credential_id) {
      // Update existing credential — refresh on a known credential row. If the
      // row vanished mid-flow (race with delete/archive), swallow: the OAuth
      // dance still completes for UX and the operator can retry attaching.
      await services.credentials
        .update({
          tenantId: oauthState.tenant_id,
          vaultId: oauthState.vault_id,
          credentialId: oauthState.credential_id,
          auth: credAuth,
        })
        .catch(() => {
          /* not found — leave it; user can re-initiate */
        });
    } else {
      // Create new credential
      await services.credentials.create({
        tenantId: oauthState.tenant_id,
        vaultId: oauthState.vault_id,
        displayName: `${serverName} (OAuth)`,
        auth: credAuth,
      });
    }

    // Clean up state
    await services.kv.delete(stateKey);

    // Probe the MCP server with the just-obtained token. Same shape as the
    // Slack publish probe — POST tools/list, classify the response, surface
    // the result on the success page so the user sees ✓ or a precise warning
    // instead of silently storing a token that won't work. 5s bound; failure
    // here doesn't roll back the credential (it's already persisted).
    const probeResult = await probeMcpServer(oauthState.mcp_server_url, tokens.access_token);

    // Redirect back to console
    const redirectUrl = new URL(oauthState.redirect_uri);
    redirectUrl.searchParams.set("oauth", "success");
    redirectUrl.searchParams.set("service", serverName);
    redirectUrl.searchParams.set("probe_ok", probeResult.ok ? "1" : "0");
    if (probeResult.message) redirectUrl.searchParams.set("probe_message", probeResult.message);

    // If opened in a popup, close it and notify parent.
    //
    // Two transports because COOP can sever window.opener:
    //   1. window.opener.postMessage — works when the OAuth provider doesn't
    //      set Cross-Origin-Opener-Policy headers (Linear, Notion, Airtable).
    //   2. BroadcastChannel("openma-oauth") — survives COOP severance because
    //      it uses same-origin browser bus, not the popup→parent reference.
    //      Required for Sentry (COOP: same-origin), GitHub etc., effectively
    //      anything large enough to set COOP defensively. Both popup and
    //      parent are same-origin (app.openma.dev / app.staging.openma.dev),
    //      so the channel is delivered.
    //
    // We always try both, then close — but only when the return URL is on
    // this page's origin, i.e. a console popup that one of the transports can
    // reach. A posted BroadcastChannel message counts as sent even with no
    // listener, so a cross-origin return URL (the `oma` CLI's localhost
    // listener) is always navigated to; closing instead would leave the CLI
    // waiting until it times out. Navigation is also the fallback when
    // neither transport is available (very old browser).
    //
    // Every value reaches the inline script through scriptJson: the probe
    // message is the MCP server's own response text and the return URL is
    // caller-supplied, so either could otherwise close the script tag.
    const completion = {
      type: "oauth_complete",
      service: serverName,
      vault_id: oauthState.vault_id,
      probe_ok: probeResult.ok,
      probe_message: probeResult.message ?? null,
    };
    return c.html(`
      <html><body>
      <p>Connected to ${escapeHtml(serverName)}. Closing…</p>
      <script>
        (function(){
          var msg = ${scriptJson(completion)};
          var returnUrl = ${scriptJson(redirectUrl.toString())};
          var notified = false;
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage(msg, "*");
              notified = true;
            }
          } catch (e) {}
          try {
            var bc = new BroadcastChannel("openma-oauth");
            bc.postMessage(msg);
            bc.close();
            notified = true;
          } catch (e) {}
          var sameOrigin = false;
          try {
            sameOrigin = new URL(returnUrl).origin === window.location.origin;
          } catch (e) {}
          if (notified && sameOrigin) {
            window.close();
          } else {
            window.location.href = returnUrl;
          }
        })();
      </script>
      </body></html>
    `);
  });

  /**
   * POST /v1/oma/oauth/refresh
   *
   * Refresh an OAuth token. Called by the outbound worker when a 401 is received.
   * Body: { vault_id, credential_id }
   * Returns: { access_token, expires_at }
   */
  app.post("/refresh", async (c) => {
    const services = resolveServices(deps.services, c);
    const body = await c.req.json<{ vault_id: string; credential_id: string }>();

    if (!body.vault_id || !body.credential_id) {
      return c.json({ error: "vault_id and credential_id are required" }, 400);
    }

    const t = c.get("tenant_id");
    const native = await deps.credentialsFor?.(t);
    if (native) return c.json(await native.refresh(body.vault_id, body.credential_id));
    const service = services.credentials;
    const cred = await service.get({
      tenantId: t,
      vaultId: body.vault_id,
      credentialId: body.credential_id,
    });
    if (!cred) {
      return c.json({ error: "Credential not found" }, 404);
    }

    if (cred.auth.type !== "mcp_oauth") {
      return c.json({ error: "Credential is not mcp_oauth type" }, 400);
    }

    if (!cred.auth.refresh_token || !cred.auth.token_endpoint) {
      return c.json({ error: "No refresh_token or token_endpoint" }, 400);
    }

    // Refresh the token
    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.auth.refresh_token,
      client_id: cred.auth.client_id || "open-managed-agents",
    });
    if (cred.auth.client_secret) {
      tokenBody.set("client_secret", cred.auth.client_secret);
    }

    const tokenRes = await fetch(cred.auth.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // See note in /callback — GitHub returns form-encoded by default.
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      return c.json({ error: "Token refresh failed", status: tokenRes.status }, 502);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Merge-update: refreshAuth keeps mcp_server_url, token_endpoint, client_id, etc.
    await service.refreshAuth({
      tenantId: t,
      vaultId: body.vault_id,
      credentialId: body.credential_id,
      auth: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? cred.auth.refresh_token,
        expires_at: expiresAt,
      },
    });

    return c.json({
      access_token: tokens.access_token,
      expires_at: expiresAt,
    });
  });

  return app;
}
