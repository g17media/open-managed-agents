// MCP / outbound credential-injection forwarding. The only layer that
// ever holds plaintext upstream tokens — the sandbox / harness sees only
// references. Shared by the CF worker (HTTP endpoint + McpProxyRpc) and
// main-node's in-process mcpBinding.

import type { AgentConfig, CredentialConfig } from "@open-managed-agents/shared";
import { log, logWarn } from "@open-managed-agents/shared";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { CredentialService } from "@open-managed-agents/credentials-store";

/** Narrow slice of the Services container these functions touch. Both the
 *  CF per-tenant container and main-node's individual store services
 *  satisfy it structurally. */
export interface ProxyServices {
  sessions: SessionService;
  credentials: CredentialService;
}

type McpProxyServer =
  | {
      name: string;
      type: "url";
      url: string;
      authorizationToken?: string;
    }
  | {
      name: string;
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/** Session half of the managed MCP boundary. The official v1 API stores
 *  sessions in a different shape from the legacy `Services.sessions`
 *  adapter; resolveProxyTargetByTenant accepts either. */
export interface McpProxySessionSource {
  find(input: { workspaceId: string; sessionId: string }): Promise<{
    archivedAt: string | null;
    vaultIds: string[];
    agent: {
      mcpServers: McpProxyServer[];
    };
  } | null>;
}

export interface ManagedProxyCredential {
  id: string;
  vaultId: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  auth: Record<string, unknown> & { type: string };
}

export interface ManagedProxyCredentialRecord {
  revision: number;
  credential: ManagedProxyCredential;
}

/**
 * Credential half of the managed MCP boundary. The official v1 Vault API
 * persists encrypted documents in `managed_credentials`; the legacy
 * `Services.credentials` adapter reads a different table and encryption
 * context. Keeping this as a narrow Port prevents either storage shape from
 * leaking into the MCP protocol code.
 *
 * The concrete CF/D1 implementation lives in apps/main (it needs D1 +
 * WebCryptoAesGcm); this package only depends on the shape.
 */
export interface McpProxyCredentialSource {
  listByVaults(input: {
    workspaceId: string;
    vaultIds: string[];
  }): Promise<ManagedProxyCredentialRecord[]>;
  find?(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<ManagedProxyCredentialRecord | null>;
  replace?(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
    expectedRevision: number;
    next: ManagedProxyCredential;
  }): Promise<
    | { type: "replaced"; record: ManagedProxyCredentialRecord }
    | { type: "not_found" }
    | { type: "revision_conflict"; actualRevision: number }
  >;
}

export interface ProxyTarget {
  /** Real upstream MCP server URL (e.g. https://integrations.openma.dev/.../mcp). */
  upstreamUrl: string;
  /** Bearer token to inject on the upstream request. */
  upstreamToken: string;
  /** Set when the matched credential has the bits needed to refresh on
   *  401 (refresh_token + token_endpoint). Used by `forwardWithRefresh`
   *  to retry once with a fresh token if the upstream rejects the
   *  bearer. Stays internal to main — never leaves through any RPC
   *  return value or HTTP response body. */
  refresh?: {
    refreshToken: string;
    tokenEndpoint: string;
    clientId?: string;
    clientSecret?: string;
    credentialId: string;
    vaultId: string;
    /** Where in the credential's `auth` blob the rotated access token
     *  is read from + written back to. mcp_oauth uses `access_token`;
     *  cap_cli uses `token`. Defaults to `access_token` to keep
     *  pre-cap callers working unchanged. */
    tokenField?: "access_token" | "token";
    /** Present for credentials created through the official v1 Vault API. */
    credentialSource?: McpProxyCredentialSource;
  };
}


/**
 * Validate the (tenantId, sid, serverName) triple and resolve the upstream
 * URL + injection token. Returns null if anything fails — the caller turns
 * that into a 403 with a generic message.
 *
 * Used by both the HTTP endpoint (auth via apiKey → tenantId) and the RPC
 * entrypoint (auth via service binding; tenantId comes from the agent
 * worker's session context). Keeping the cred-resolution step apiKey-free
 * is what lets cloud agents skip the apiKey-bootstrap problem.
 */
export async function resolveProxyTargetByTenant(
  services: ProxyServices,
  tenantId: string,
  sid: string,
  serverName: string,
  sessionSource?: McpProxySessionSource,
  credentialSource?: McpProxyCredentialSource,
): Promise<ProxyTarget | null> {
  // 1. Session must exist, belong to the same tenant, not archived.
  const managedSessionRecord = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId: sid }).catch(() => null)
    : null;
  const session = managedSessionRecord
    ?? await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const legacySession = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
    agent_snapshot?: AgentConfig;
  };
  const managedSession = session as {
    archivedAt?: string | null;
    vaultIds?: string[] | null;
    agent?: {
      mcpServers?: McpProxyServer[];
    };
  };
  if (legacySession.archived_at || managedSession.archivedAt) return null;

  // 2. agent_snapshot must declare the requested mcp server.
  const legacyAgent = legacySession.agent_snapshot;
  const server = legacyAgent
    ? (legacyAgent.mcp_servers ?? []).find((candidate) => candidate.name === serverName)
    : (managedSession.agent?.mcpServers ?? []).find(
        (candidate) => candidate.name === serverName,
      );
  if (!server || !("url" in server) || !server.url) return null;

  // 3. Resolve credential. agent.mcp_servers[].authorization_token, if set,
  //    is the literal token we should inject. Otherwise look up an active
  //    credential matching the server URL across the session's vault_ids.
  const inlineToken = (server as {
    authorization_token?: string;
    authorizationToken?: string;
  }).authorization_token ?? (server as { authorizationToken?: string }).authorizationToken;
  if (inlineToken) {
    return { upstreamUrl: server.url, upstreamToken: inlineToken };
  }

  const vaultIds = legacySession.vault_ids ?? managedSession.vaultIds ?? [];
  if (vaultIds.length === 0) return null;
  const useManagedCredentialSource = managedSessionRecord !== null && credentialSource !== undefined;
  const managedCredentials = useManagedCredentialSource
    ? await credentialSource
      .listByVaults({ workspaceId: tenantId, vaultIds })
      .catch(() => [])
    : [];
  const grouped = useManagedCredentialSource
    ? [{ vault_id: "managed", credentials: managedCredentials.map((record) => record.credential) }]
    : await services.credentials.listByVaults({ tenantId, vaultIds }).catch(() => []);
  for (const g of grouped) {
    for (const c of g.credentials) {
      const credential = c as unknown as {
        id: string;
        archivedAt?: string | null;
        archived_at?: string | null;
        vaultId?: string;
        vault_id?: string;
        auth?: Record<string, unknown>;
      };
      if (credential.archivedAt || credential.archived_at) continue;
      const auth = credential.auth as
        | {
            type?: string;
            mcp_server_url?: string;
            mcpServerUrl?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            accessToken?: string;
            refresh_token?: string;
            token_endpoint?: string;
            client_id?: string;
            client_secret?: string;
            refresh?: {
              refreshToken?: string | null;
              tokenEndpoint?: string;
              clientId?: string;
              tokenEndpointAuth?: {
                type?: string;
                clientSecret?: string | null;
              };
            } | null;
          }
        | undefined;
      if (!auth) continue;
      if ((auth.mcp_server_url ?? auth.mcpServerUrl) !== server.url) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken;
      if (!token) continue;
      const target: ProxyTarget = { upstreamUrl: server.url, upstreamToken: token };
      // Surface refresh metadata for mcp_oauth so 401 can trigger an
      // automatic token refresh + retry. static_bearer creds skip this.
      if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint,
          clientId: auth.client_id,
          clientSecret: auth.client_secret,
          credentialId: (c as { id: string }).id,
          vaultId: g.vault_id,
        };
      }
      if (
        credentialSource
        && auth.type === "mcp_oauth"
        && auth.refresh?.refreshToken
        && auth.refresh.tokenEndpoint
      ) {
        target.refresh = {
          refreshToken: auth.refresh.refreshToken,
          tokenEndpoint: auth.refresh.tokenEndpoint,
          clientId: auth.refresh.clientId,
          clientSecret: auth.refresh.tokenEndpointAuth?.clientSecret ?? undefined,
          credentialId: credential.id,
          vaultId: credential.vaultId ?? credential.vault_id ?? "",
          credentialSource,
        };
      }
      return target;
    }
  }
  return null;
}

/**
 * Forward an MCP request to the upstream server, swapping the authorization
 * header for the resolved upstream token. Strips any session-/proxy-specific
 * CF headers so the upstream sees only what it would have if the agent had
 * called it directly with the real credential.
 *
 * Streams the response back as-is — MCP-over-HTTP clients expect to read
 * the body progressively (SSE / chunked NDJSON). Both the HTTP endpoint
 * and the RPC entrypoint share this code path.
 */
export async function forwardToUpstream(
  target: ProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  upstreamHeaders.set("authorization", `Bearer ${target.upstreamToken}`);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("cf-connecting-ip");
  upstreamHeaders.delete("cf-ray");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");
  upstreamHeaders.delete("x-api-key");
  upstreamHeaders.delete("proxy-authorization");
  upstreamHeaders.delete("cookie");
  upstreamHeaders.delete("x-active-tenant");

  const upstreamReq = new Request(target.upstreamUrl, {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    // A redirect is a new destination and must be re-authorized explicitly;
    // never let fetch replay a Vault bearer automatically.
    redirect: "manual",
  });

  return fetch(upstreamReq);
}

/**
 * Forward + auto-refresh on 401 for `mcp_oauth` credentials. Wraps
 * `forwardToUpstream` with: if the first response is 401 AND the
 * resolved credential carries refresh metadata, hit `token_endpoint`
 * with the `refresh_token`, persist the rotated token back to D1 (via
 * services.credentials.refreshAuth so the next session sees the new
 * token immediately), and retry the upstream call once with the fresh
 * bearer. Returns whatever the retry produced — including another 401
 * if refresh itself was rejected (revoked refresh_token, scopes
 * removed) — so the caller's UI can surface the genuine auth failure.
 *
 * Body must be pre-buffered (string | null) because the request stream
 * gets consumed by the first fetch and we need to replay it on retry.
 * For Worker-to-Worker traffic both `mcpForward` and `outboundForward`
 * already pass body as a string; the public HTTP /v1/mcp-proxy endpoint
 * pre-buffers via `c.req.text()` for the same reason.
 *
 * Replaces the old apps/agent/src/outbound.ts:tryRefreshToken path,
 * which lived in the agent worker and updated a per-session KV
 * snapshot. The KV snapshot is gone (see previous commit); refresh
 * persistence is now D1-direct so the canonical credential row is the
 * single source of truth and stays consistent across sessions.
 */
export async function forwardWithRefresh(
  services: ProxyServices,
  tenantId: string,
  target: ProxyTarget,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
  /** Audit context — surfaces in structured log lines so production
   *  incidents have a "who called what when" trail without us having to
   *  thread it through every call. tenantId comes from the function arg
   *  above; this just adds the session/server discriminators that vary
   *  per call. */
  audit?: {
    sessionId?: string;
    serverName?: string;
    callerKind: "http" | "rpc-mcp" | "rpc-outbound";
  },
): Promise<Response> {
  const started = Date.now();
  let upstreamHost: string | undefined;
  try {
    upstreamHost = new URL(target.upstreamUrl).hostname;
  } catch {
    /* never */
  }

  const first = await forwardToUpstream(target, method, inboundHeaders, body);
  // Trigger refresh on either 401 (canonical "your token is expired /
  // invalid") or 403 (some MCP servers — observed on mcp.airtable.com,
  // mcp.asana.com, mcp.sentry.dev — return Forbidden instead of
  // Unauthorized when the bearer is expired or revoked, presumably
  // because their auth layer treats "no usable identity" as a
  // permission failure rather than an auth failure). 403 is ambiguous
  // — it could also mean "scope removed" or "plan tier downgrade", in
  // which case refresh succeeds + retry still 403s, and we surface that
  // genuine error to the caller. The cost of an extra refresh call in
  // the false-positive case is one HTTP round-trip + D1 write, which is
  // cheap relative to the user-visible breakage of "token expired and
  // nothing ever recovers" (the actual symptom — staging 2026-05-20
  // sess-pvdx9d16zitzhw39 saw all three of airtable/asana/sentry
  // permanently 403 across multiple sessions until manual SQL cleanup).
  const refreshableStatus = first.status === 401 || first.status === 403;
  if (!refreshableStatus || !target.refresh) {
    log(
      {
        op: "mcp_proxy.forward",
        caller: audit?.callerKind ?? "unknown",
        tenant_id: tenantId,
        session_id: audit?.sessionId,
        server: audit?.serverName,
        host: upstreamHost,
        method,
        status: first.status,
        refreshed: false,
        ms: Date.now() - started,
      },
      "mcp_proxy forward",
    );
    return first;
  }

  // Drain so we can return a fresh Response without two outstanding
  // streams. We don't read the body — its content is irrelevant once
  // we've decided to refresh.
  try {
    await first.body?.cancel();
  } catch {
    /* already consumed / closed */
  }

  const fresh = await tryRefreshOauth(services, tenantId, target.refresh, target.upstreamToken);
  if (!fresh) {
    // Refresh failed: re-issue the original request unchanged so the
    // caller gets the upstream's actual 401 (matches old behavior).
    const retry = await forwardToUpstream(target, method, inboundHeaders, body);
    logWarn(
      {
        op: "mcp_proxy.refresh_failed",
        caller: audit?.callerKind ?? "unknown",
        tenant_id: tenantId,
        session_id: audit?.sessionId,
        server: audit?.serverName,
        host: upstreamHost,
        status: retry.status,
        ms: Date.now() - started,
      },
      "mcp_proxy refresh failed; surfacing upstream 401",
    );
    return retry;
  }

  const retried = await forwardToUpstream(
    { ...target, upstreamToken: fresh },
    method,
    inboundHeaders,
    body,
  );
  log(
    {
      op: "mcp_proxy.forward",
      caller: audit?.callerKind ?? "unknown",
      tenant_id: tenantId,
      session_id: audit?.sessionId,
      server: audit?.serverName,
      host: upstreamHost,
      method,
      status: retried.status,
      refreshed: true,
      ms: Date.now() - started,
    },
    "mcp_proxy forward (after refresh)",
  );
  return retried;
}

async function tryRefreshOauth(
  services: ProxyServices,
  tenantId: string,
  refresh: NonNullable<ProxyTarget["refresh"]>,
  staleAccessToken: string,
): Promise<string | null> {
  const tokenField = refresh.tokenField ?? "access_token";
  let managedCurrent: ManagedProxyCredentialRecord | null = null;
  if (refresh.credentialSource?.find) {
    managedCurrent = await refresh.credentialSource.find({
      workspaceId: tenantId,
      vaultId: refresh.vaultId,
      credentialId: refresh.credentialId,
    }).catch(() => null);
    const liveAccessToken = managedCurrent?.credential.auth.accessToken;
    if (typeof liveAccessToken === "string" && liveAccessToken !== staleAccessToken) {
      return liveAccessToken;
    }
  }
  // Double-checked locking against concurrent refresh: if N parallel
  // calls all 401 at the same instant (typical when access_token TTL
  // hits boundary mid-multi-tool-call), they'll all enter this path.
  // Re-fetch the canonical credential from D1 first; if its access_token
  // has already moved past the stale one we just got 401'd with, another
  // call already refreshed — return the live token, skip the
  // token_endpoint call entirely. This isn't a perfect mutex (two calls
  // can both re-fetch BEFORE either persists), but it cuts the race
  // window from "every 401" to "two 401s landing in the same low
  // single-digit ms". Good enough for current scale; perfect mutex
  // would need a per-credential Durable Object and isn't worth it
  // until we see real concurrent-refresh damage in production logs.
  // Read the current row WITH its raw ciphertext. We need the bytes to
  // CAS the post-refresh write — AES-GCM uses a random IV so two
  // encrypts of the same plaintext produce different ciphertexts; the
  // only way to predicate "the row hasn't moved since I read it" is on
  // the exact ciphertext bytes.
  let expectedAuthCipher: string | null = null;
  try {
    const fresh = await services.credentials
      .getRawForRefresh({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
      .catch(() => null);
    if (fresh) {
      const liveAccessToken = (fresh.row.auth as unknown as Record<string, unknown>)?.[tokenField];
      if (typeof liveAccessToken === "string" && liveAccessToken !== staleAccessToken) {
        // Another in-flight refresh (or a manual /v1/oma/oauth/refresh) has
        // already rotated the token between our caller's first 401/403
        // and us reaching this re-read. Use the live token, skip the
        // token_endpoint roundtrip + the CAS write entirely.
        return liveAccessToken;
      }
      expectedAuthCipher = fresh.authCipher;
    }
  } catch {
    // D1 unreachable — fall through to token_endpoint refresh without CAS.
  }

  const tokenBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh.refreshToken,
    client_id: refresh.clientId || "open-managed-agents",
  });
  if (refresh.clientSecret) tokenBody.set("client_secret", refresh.clientSecret);

  let res: Response;
  try {
    res = await fetch(refresh.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    // token_endpoint rejected our refresh_token. Two distinct cases:
    //   (a) Real failure: refresh_token revoked / scopes removed → no
    //       way forward, return null and the caller surfaces the
    //       upstream error.
    //   (b) Race we lost: a parallel refresh on this same credential
    //       beat us, the provider rotated refresh_token, ours is now
    //       invalid. The winner persisted a fresh access_token to D1.
    //       Re-read and route the caller's retry through it.
    try {
      if (refresh.credentialSource?.find) {
        const after = await refresh.credentialSource.find({
          workspaceId: tenantId,
          vaultId: refresh.vaultId,
          credentialId: refresh.credentialId,
        });
        const winner = after?.credential.auth.accessToken;
        if (typeof winner === "string" && winner !== staleAccessToken) return winner;
      }
      const after = await services.credentials
        .get({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
        .catch(() => null);
      const winnerAuth = (after as { auth?: Record<string, unknown> } | null)?.auth;
      const winnerAccessToken = winnerAuth?.[tokenField];
      if (typeof winnerAccessToken === "string" && winnerAccessToken !== staleAccessToken) {
        return winnerAccessToken;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return null;
  }
  if (!tokens.access_token) return null;

  if (
    refresh.credentialSource?.replace
    && managedCurrent !== null
    && managedCurrent.credential.auth.type === "mcp_oauth"
  ) {
    const currentAuth = managedCurrent.credential.auth;
    const currentRefresh = currentAuth.refresh;
    if (typeof currentRefresh === "object" && currentRefresh !== null) {
      const next: ManagedProxyCredential = {
        ...managedCurrent.credential,
        updatedAt: new Date().toISOString(),
        auth: {
          ...currentAuth,
          accessToken: tokens.access_token,
          ...(tokens.expires_in !== undefined && {
            expiresAt: new Date(Date.now() + tokens.expires_in * 1_000).toISOString(),
          }),
          refresh: {
            ...currentRefresh,
            refreshToken: tokens.refresh_token ?? refresh.refreshToken,
          },
        },
      };
      const replaced = await refresh.credentialSource.replace({
        workspaceId: tenantId,
        vaultId: refresh.vaultId,
        credentialId: refresh.credentialId,
        expectedRevision: managedCurrent.revision,
        next,
      }).catch(() => null);
      if (replaced?.type === "replaced") return tokens.access_token;
      if (replaced?.type === "revision_conflict") {
        const winner = await refresh.credentialSource.find?.({
          workspaceId: tenantId,
          vaultId: refresh.vaultId,
          credentialId: refresh.credentialId,
        }).catch(() => null);
        const winnerToken = winner?.credential.auth.accessToken;
        if (typeof winnerToken === "string") return winnerToken;
      }
      // The provider already issued a valid token. A transient persistence
      // failure must not throw away the current request; the next 401 retries
      // refresh and exposes the storage problem through normal logs.
      return tokens.access_token;
    }
  }

  // Persist back to D1 via CAS. Two parallel refreshes that both made it
  // through token_endpoint successfully (the provider didn't one-shot
  // its refresh_token) end up here with potentially different new tokens.
  // CAS picks a winner. Loser re-reads and uses winner's token — the
  // ones we just got back from token_endpoint get dropped on the floor,
  // which is fine because both are valid (the provider didn't invalidate
  // either) and consistency-of-stored-state matters more than which
  // valid-token-we-got is "ours".
  if (expectedAuthCipher) {
    const updated = await services.credentials
      .refreshAuthCAS({
        tenantId,
        vaultId: refresh.vaultId,
        credentialId: refresh.credentialId,
        expectedAuthCipher,
        auth: {
          [tokenField]: tokens.access_token,
          refresh_token: tokens.refresh_token ?? refresh.refreshToken,
          expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined,
        } as Partial<import("@open-managed-agents/shared").CredentialAuth>,
      })
      .catch(() => null);
    if (!updated) {
      // CAS lost — winner already wrote. Re-read and return their token.
      try {
        const after = await services.credentials
          .get({ tenantId, vaultId: refresh.vaultId, credentialId: refresh.credentialId })
          .catch(() => null);
        const winnerToken = (after as { auth?: Record<string, unknown> } | null)?.auth?.[tokenField];
        if (typeof winnerToken === "string") return winnerToken;
      } catch {
        /* fall through */
      }
      // Couldn't read the winner — return our just-acquired token
      // anyway, the caller's retry will at least use a valid bearer.
      return tokens.access_token;
    }
  } else {
    // No expectedAuthCipher (D1 was unreachable when we tried to read).
    // Fall back to non-CAS update — accepts the small "two writers
    // clobber" risk in exchange for persisting at all when D1 was
    // briefly unavailable on the read but recovered for the write.
    try {
      await services.credentials.refreshAuth({
        tenantId,
        vaultId: refresh.vaultId,
        credentialId: refresh.credentialId,
        auth: {
          [tokenField]: tokens.access_token,
          refresh_token: tokens.refresh_token ?? refresh.refreshToken,
          expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : undefined,
        } as Partial<import("@open-managed-agents/shared").CredentialAuth>,
      });
    } catch {
      /* best-effort */
    }
  }

  return tokens.access_token;
}

