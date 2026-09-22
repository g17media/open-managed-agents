/**
 * MCP proxy — gateway between an OMA agent (cloud or local-runtime) and the
 * upstream MCP servers configured on that agent. The credential lives in
 * a vault on the cloud side; this proxy is the only layer that ever holds
 * the plaintext token, mirroring Anthropic's Managed Agents design (the
 * sandbox / harness never sees credentials, only references to them).
 *
 *   ┌────────────────────────────────┐
 *   │  ACP child  /  Cloud agent DO  │   "调 server X，sid=Y"
 *   │  (the harness — no creds)      │
 *   └─────────────┬──────────────────┘
 *                 │
 *                 ├── HTTP via API key or current Work bearer
 *                 │   /v1/oma/mcp-proxy/<sid>/<server_name>
 *                 │
 *                 └── WorkerEntrypoint RPC via service binding
 *                     (cloud agent path — see apps/main/src/index.ts:McpProxyRpc)
 *                 │
 *   ┌─────────────▼──────────────────┐
 *   │  resolveProxyTarget(...)        │   ← only function that touches creds
 *   │  + forwardToUpstream(...)       │
 *   └─────────────┬──────────────────┘
 *                 │  Authorization: Bearer <real-token>
 *                 ▼
 *           upstream MCP server
 *
 * Auth surface (HTTP path):
 *   - Bearer omak_*: hashed in CONFIG_KV `apikey:<sha256>` (same row API
 *     keys created via /v1/oma/api_keys use). Resolves to (tenant_id, user_id).
 *   - Bearer sk-ant-req-v1.*: sealed self-hosted Work capability; the top-level
 *     middleware validates expiry, exact current claim, heartbeat TTL, and the
 *     Session-scoped proxy path before this router runs.
 *   - sid in URL: must reference a row in `sessions` belonging to the same
 *     tenant. session.archived_at IS NULL gates "this session is still alive";
 *     deletion → proxy returns 403 immediately, no token revocation needed.
 *   - server_name in URL: must match one of agent.mcp_servers[].name on the
 *     session's agent_snapshot.
 *
 * Auth surface (RPC path): tenant_id is established by the binding itself —
 * only configured Workers can RPC into us, and the caller (agent worker)
 * already authenticated the session out-of-band. The same session/server
 * checks below run, just without the apiKey lookup step.
 *
 * Auth flow is intentionally cache-friendly: a single function
 * `resolveProxyTargetByTenant(services, tenantId, sid, serverName) →
 * ProxyTarget | null` isolates the lookup so a future KV cache layer can
 * drop in around it without changing call sites. We don't add the cache
 * yet — current scale runs sub-ms per call, KV round-trip would be slower.
 */

import { Hono } from "hono";
import type { Env, AgentConfig, CredentialConfig } from "@open-managed-agents/shared";
import { log, logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  builtinSpecs,
  createSpecRegistry,
  applyCapOverrides,
  parseCapOverridesFromEnv,
  type SpecRegistry,
} from "@open-managed-agents/cap";
// MCP forwarding moved to @open-managed-agents/vault-forward/proxy so
// main-node's in-process mcpBinding can share it with the CF worker. The
// platform-specific half (D1 + WebCryptoAesGcm) stays here.
import {
  resolveProxyTargetByTenant,
  forwardToUpstream,
  forwardWithRefresh,
} from "@open-managed-agents/vault-forward/proxy";
import type {
  ProxyTarget,
  McpProxySessionSource,
  McpProxyCredentialSource,
  ManagedProxyCredential,
  ManagedProxyCredentialRecord,
} from "@open-managed-agents/vault-forward/proxy";

export { resolveProxyTargetByTenant, forwardToUpstream, forwardWithRefresh };
export type {
  ProxyTarget,
  McpProxySessionSource,
  McpProxyCredentialSource,
  ManagedProxyCredential,
  ManagedProxyCredentialRecord,
};
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";

// Built once per isolate on first use: the registry is pure data, but the
// CAP_OVERRIDE_* bindings it merges in are only reachable through a
// request's `env`, not at module scope.
let capRegistry: SpecRegistry | undefined;
function getCapRegistry(env: Env): SpecRegistry {
  capRegistry ??= createSpecRegistry(applyCapOverrides(
    builtinSpecs,
    parseCapOverridesFromEnv(builtinSpecs.map((s) => s.cli_id), env as unknown as Partial<Record<string, string>>),
  ));
  return capRegistry;
}

const app = new Hono<{
  Bindings: Env;
  Variables: { services: Services; tenantDb: D1Database };
}>();


export function createManagedMcpProxyCredentialSource(
  env: Env,
  tenantDb: D1Database,
): McpProxyCredentialSource {
  if (!env.PLATFORM_ROOT_SECRET) {
    throw new Error("PLATFORM_ROOT_SECRET is required for managed Vault credentials");
  }
  const crypto = new WebCryptoAesGcm(
    env.PLATFORM_ROOT_SECRET,
    "managed.vault.credentials",
  );
  const store = new SqlCredentialStore(new CfD1SqlClient(tenantDb), {
    seal: async ({ plaintext }) => ({ ciphertext: await crypto.encrypt(plaintext) }),
    open: async ({ ciphertext }) => ({ plaintext: await crypto.decrypt(ciphertext) }),
  });
  return {
    async listByVaults({ workspaceId, vaultIds }) {
      const records: ManagedProxyCredentialRecord[] = [];
      for (const vaultId of vaultIds) {
        let position: { createdAt: string; credentialId: string } | undefined;
        for (;;) {
          const page = await store.list({
            workspaceId,
            vaultId,
            includeArchived: true,
            limit: 100,
            ...(position !== undefined && { position }),
          });
          records.push(...page as ManagedProxyCredentialRecord[]);
          if (page.length < 100) break;
          const last = page.at(-1)!;
          position = {
            createdAt: last.credential.createdAt,
            credentialId: last.credential.id,
          };
        }
      }
      return records;
    },
    find: (input) => store.find(input) as Promise<ManagedProxyCredentialRecord | null>,
    replace: (input) => store.replace(input as never) as Promise<
      | { type: "replaced"; record: ManagedProxyCredentialRecord }
      | { type: "not_found" }
      | { type: "revision_conflict"; actualRevision: number }
    >,
  };
}


export interface ForwardHttpMcpProxyRequestInput {
  env: Env;
  services: Services;
  /** Current v1 Session source. Omit only for legacy embedders/tests. */
  sessionSource?: McpProxySessionSource;
  /** Current v1 managed Credential source. Omit for legacy callers. */
  credentialSource?: McpProxyCredentialSource;
  tenantId: string;
  sessionId: string;
  serverName: string;
  request: Request;
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve apiKey → tenant_id via the existing KV `apikey:<sha256>`
 * index. Exported so the HTTP endpoint can do its auth step before handing
 * off to `resolveProxyTargetByTenant`. Returns null on miss / malformed row.
 */
export async function apiKeyToTenantId(kv: KvStore, apiKey: string): Promise<string | null> {
  const hash = await sha256(apiKey);
  const keyData = await kv.get(`apikey:${hash}`);
  if (!keyData) return null;
  const { tenant_id: tenantId } = JSON.parse(keyData) as { tenant_id: string; user_id?: string };
  return tenantId || null;
}


/**
 * Outbound counterpart to `resolveProxyTargetByTenant`: pick a vault bearer
 * token whose `auth.mcp_server_url` shares a hostname with the request the
 * sandbox is about to make. Returns null when the session has no matching
 * credential — caller forwards the request without injection (works for
 * unauthenticated upstreams and matches the pre-refactor "pass through if
 * no match" behavior).
 *
 * Hostname-based match (rather than full URL like the MCP path) because
 * the sandbox container hits arbitrary upstream paths — e.g. the agent
 * configures an MCP server at `https://api.linear.app/mcp` and then
 * fetches `https://api.linear.app/v1/issues/...` from a script. Both
 * should get the same Bearer.
 *
 * Live read on every call: no DO-side snapshot, no KV blob in agent
 * worker. If a vault credential is rotated mid-session, the next outbound
 * call sees the new token without any session-side invalidation.
 */
export async function resolveOutboundCredentialByHost(
  env: Env,
  services: Services,
  tenantId: string,
  sid: string,
  hostname: string,
  sessionSource?: McpProxySessionSource,
  credentialSource?: McpProxyCredentialSource,
): Promise<ProxyTarget | null> {
  const managedSessionRecord = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId: sid }).catch(() => null)
    : null;
  const session = managedSessionRecord
    ?? await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const legacySession = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
  };
  const managedSession = session as {
    archivedAt?: string | null;
    vaultIds?: string[] | null;
  };
  if (legacySession.archived_at || managedSession.archivedAt) return null;

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

  // First pass: cap_cli credentials matched via cap's spec registry.
  // Cap owns the per-CLI knowledge — endpoints (`api.github.com`,
  // `*.amazonaws.com`, …), header shape, OAuth refresh metadata. Here we
  // just match by hostname → cli_id and find a cap_cli credential whose
  // cli_id matches. Header rewrite happens later in forwardWithRefresh.
  //
  // Selection rule when the vault has more than one matching cap_cli
  // (typical after a re-auth): pick the newest non-archived row by
  // `updated_at`. listByVaults returns `created_at ASC` and includes
  // archived rows, so a naive "first match wins" loop kept injecting
  // the OLDEST (= staler) token for sessions whose user re-ran
  // `cap login` to refresh — observed in prod 2026-05-13: gh `repo list`
  // returned 401 even immediately after a successful re-auth.
  const capSpec = getCapRegistry(env).byHostname(hostname);
  if (capSpec) {
    let best: { c: typeof grouped[number]["credentials"][number]; vaultId: string; ts: number } | null = null;
    for (const g of grouped) {
      for (const c of g.credentials) {
        if (
          (c as { archived_at?: string | null }).archived_at
          || (c as { archivedAt?: string | null }).archivedAt
        ) continue;
        const auth = (c as unknown as CredentialConfig).auth as
          | {
              type?: string;
              cli_id?: string;
              token?: string;
              refresh_token?: string;
            }
          | undefined;
        if (auth?.type !== "cap_cli") continue;
        if (auth.cli_id !== capSpec.cli_id) continue;
        if (!auth.token) continue;
        const meta = c as { updated_at?: string | number; created_at?: string | number };
        const tsRaw = meta.updated_at ?? meta.created_at ?? 0;
        const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
        if (!best || ts > best.ts) best = { c, vaultId: g.vault_id, ts };
      }
    }
    if (best) {
      const auth = (best.c as unknown as CredentialConfig).auth as {
        token?: string;
        refresh_token?: string;
      };
      // Treat every cap_cli credential as a static bearer for the
      // matched hostname. Header-mode CLIs (gh, glab, fly, …) all
      // emit `Authorization: Bearer <token>` which matches existing
      // forwardWithRefresh behaviour. metadata_ep / exec_helper modes
      // need the full cap.handleHttp pipeline — wired in PR 2.
      const target: ProxyTarget = {
        upstreamUrl: `https://${hostname}/`,
        upstreamToken: auth.token!,
      };
      // Wire OAuth refresh for cap_cli when the spec declares a
      // device_flow (so we know the token_endpoint + client_id) AND
      // the credential carries a refresh_token. Without this, an
      // expired cap_cli token returns 401 every turn and the user
      // has to manually re-run `cap login` — same problem
      // mcp_oauth had pre-fix. Persistence writes back to
      // `auth.token` (cap_cli's field name), not `auth.access_token`.
      const deviceFlow = capSpec.oauth?.device_flow;
      if (auth.refresh_token && deviceFlow?.token_url) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: deviceFlow.token_url,
          clientId: deviceFlow.client_id,
          credentialId: (best.c as { id: string }).id,
          vaultId: best.vaultId,
          tokenField: "token",
        };
      }
      return target;
    }
  }

  // Second pass: legacy mcp_oauth / static_bearer matched by mcp_server_url.
  // Kept for MCP server credentials (Linear / Slack / Notion etc.) that
  // aren't routed through cap — those are MCP-OAuth, not CLI.
  // Same skip-archived + pick-newest rule as the cap_cli pass above.
  let bestMcp: {
    c: typeof grouped[number]["credentials"][number];
    vaultId: string;
    ts: number;
  } | null = null;
  for (const g of grouped) {
    for (const c of g.credentials) {
      const credential = c as unknown as {
        vaultId?: string;
        vault_id?: string;
        archivedAt?: string | null;
        archived_at?: string | null;
        updatedAt?: string | number;
        updated_at?: string | number;
        createdAt?: string | number;
        created_at?: string | number;
      };
      if (credential.archived_at || credential.archivedAt) continue;
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            mcpServerUrl?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            accessToken?: string;
          }
        | undefined;
      if (!auth) continue;
      const mcpServerUrl = auth.mcp_server_url ?? auth.mcpServerUrl;
      if (!mcpServerUrl) continue;
      let credUrl: URL;
      try {
        credUrl = new URL(mcpServerUrl);
      } catch {
        continue;
      }
      if (credUrl.hostname !== hostname) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken;
      if (!token) continue;
      const tsRaw = credential.updated_at
        ?? credential.updatedAt
        ?? credential.created_at
        ?? credential.createdAt
        ?? 0;
      const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
      if (!bestMcp || ts > bestMcp.ts) {
        bestMcp = {
          c,
          vaultId: credential.vaultId ?? credential.vault_id ?? g.vault_id,
          ts,
        };
      }
    }
  }
  if (bestMcp) {
    const auth = (bestMcp.c as unknown as CredentialConfig).auth as {
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
        tokenEndpointAuth?: { clientSecret?: string | null };
      } | null;
    };
    const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken!;
    const mcpServerUrl = auth.mcp_server_url ?? auth.mcpServerUrl!;
    // upstreamUrl on this target is just for forward bookkeeping; the
    // outbound RPC caller passes the actual destination URL it wants
    // hit. We thread the cred's mcp_server_url through so log messages
    // / refresh persistence can correlate, but it's not used by
    // forwardWithRefresh's fetch (which uses caller's URL).
    const target: ProxyTarget = { upstreamUrl: mcpServerUrl, upstreamToken: token };
    if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
      target.refresh = {
        refreshToken: auth.refresh_token,
        tokenEndpoint: auth.token_endpoint,
        clientId: auth.client_id,
        clientSecret: auth.client_secret,
        credentialId: (bestMcp.c as { id: string }).id,
        vaultId: bestMcp.vaultId,
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
        credentialId: (bestMcp.c as { id: string }).id,
        vaultId: bestMcp.vaultId,
        credentialSource,
      };
    }
    return target;
  }
  return null;
}


// HTTP endpoint — used by local-runtime ACP via API key and by an official
// self-hosted Work/harness-in-sandbox via its current sessions_token. Cloud
// host-side agents may instead use the WorkerEntrypoint RPC (see McpProxyRpc).
export async function forwardHttpMcpProxyRequest(
  input: ForwardHttpMcpProxyRequestInput,
): Promise<Response> {
  const target = await resolveProxyTargetByTenant(
    // `env` dropped: the extracted helper is platform-neutral and never
    // used it (it was an unused parameter upstream too).
    input.services,
    input.tenantId,
    input.sessionId,
    input.serverName,
    input.sessionSource,
    input.credentialSource,
  );
  if (!target) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Buffer the body so forwardWithRefresh can replay it after rotating an
  // expired upstream credential.  The caller's Work/API bearer is always
  // overwritten by forwardToUpstream and therefore never leaves OpenMA.
  const method = input.request.method;
  const body = ["GET", "HEAD"].includes(method)
    ? null
    : await input.request.text();
  return forwardWithRefresh(
    input.services,
    input.tenantId,
    target,
    method,
    input.request.headers,
    body,
    {
      sessionId: input.sessionId,
      serverName: input.serverName,
      callerKind: "http",
    },
  );
}

app.all("/:sid/:server", async (c) => {
  const sid = c.req.param("sid");
  const serverName = c.req.param("server");
  // authMiddleware resolves both a workspace API key (local bridge) and a
  // current sealed Work sessions_token (sandbox worker) before this route.
  // Keep the legacy fallback for isolated route tests/embedders which mount
  // this sub-app without the top-level middleware.
  let tenantId = (c.var as { tenant_id?: string }).tenant_id;
  if (!tenantId) {
    const auth = c.req.header("authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (!apiKey) return c.json({ error: "missing bearer" }, 401);
    tenantId = await apiKeyToTenantId(c.var.services.kv, apiKey) ?? undefined;
    if (!tenantId) return c.json({ error: "forbidden" }, 403);
  }
  const services = c.get("services");
  const sessionSource = new SqlSessionSource(new CfD1SqlClient(c.get("tenantDb")));
  const credentialSource = createManagedMcpProxyCredentialSource(c.env, c.get("tenantDb"));
  return forwardHttpMcpProxyRequest({
    env: c.env,
    services,
    sessionSource,
    credentialSource,
    tenantId,
    sessionId: sid,
    serverName,
    request: c.req.raw,
  });
});

export default app;
