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
 *                 ├── HTTP via Bearer oma_*  (local-runtime path)
 *                 │   /v1/mcp-proxy/<sid>/<server_name>
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
 *     keys created via /v1/api_keys use). Resolves to (tenant_id, user_id).
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
 * `resolveProxyTargetByTenant(env, services, tenantId, sid, serverName) →
 * ProxyTarget | null` isolates the lookup so a future KV cache layer can
 * drop in around it without changing call sites. We don't add the cache
 * yet — current scale runs sub-ms per call, KV round-trip would be slower.
 */

import { Hono } from "hono";
import type { Env, CredentialConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { KvStore } from "@open-managed-agents/kv-store";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import {
  type ProxyTarget,
  resolveProxyTargetByTenant,
  forwardToUpstream,
  forwardWithRefresh,
} from "@open-managed-agents/vault-forward/proxy";

export { resolveProxyTargetByTenant, forwardToUpstream, forwardWithRefresh };
export type { ProxyTarget };

// Module-level: the cap spec registry is pure data + immutable. Building
// once amortises validation across every outbound request.
const capRegistry = createSpecRegistry(builtinSpecs);

const app = new Hono<{ Bindings: Env; Variables: { services: Services } }>();

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
): Promise<ProxyTarget | null> {
  const session = await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const sessionAny = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
  };
  if (sessionAny.archived_at) return null;

  const vaultIds = sessionAny.vault_ids ?? [];
  if (vaultIds.length === 0) return null;
  const grouped = await services.credentials
    .listByVaults({ tenantId, vaultIds })
    .catch(() => []);

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
  const capSpec = capRegistry.byHostname(hostname);
  if (capSpec) {
    let best: { c: typeof grouped[number]["credentials"][number]; vaultId: string; ts: number } | null = null;
    for (const g of grouped) {
      for (const c of g.credentials) {
        if ((c as { archived_at?: string | null }).archived_at) continue;
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
      if ((c as { archived_at?: string | null }).archived_at) continue;
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
          }
        | undefined;
      if (!auth?.mcp_server_url) continue;
      let credUrl: URL;
      try {
        credUrl = new URL(auth.mcp_server_url);
      } catch {
        continue;
      }
      if (credUrl.hostname !== hostname) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token;
      if (!token) continue;
      const meta = c as { updated_at?: string | number; created_at?: string | number };
      const tsRaw = meta.updated_at ?? meta.created_at ?? 0;
      const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
      if (!bestMcp || ts > bestMcp.ts) bestMcp = { c, vaultId: g.vault_id, ts };
    }
  }
  if (bestMcp) {
    const auth = (bestMcp.c as unknown as CredentialConfig).auth as {
      type?: string;
      mcp_server_url: string;
      bearer_token?: string;
      token?: string;
      access_token?: string;
      refresh_token?: string;
      token_endpoint?: string;
      client_id?: string;
      client_secret?: string;
    };
    const token = auth.bearer_token ?? auth.token ?? auth.access_token!;
    // upstreamUrl on this target is just for forward bookkeeping; the
    // outbound RPC caller passes the actual destination URL it wants
    // hit. We thread the cred's mcp_server_url through so log messages
    // / refresh persistence can correlate, but it's not used by
    // forwardWithRefresh's fetch (which uses caller's URL).
    const target: ProxyTarget = { upstreamUrl: auth.mcp_server_url, upstreamToken: token };
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
    return target;
  }
  return null;
}

// HTTP endpoint — used by the local-runtime ACP child via apiKey auth.
// Cloud agent path uses the WorkerEntrypoint RPC instead (see McpProxyRpc
// in apps/main/src/index.ts).
app.all("/:sid/:server", async (c) => {
  const sid = c.req.param("sid");
  const serverName = c.req.param("server");
  const auth = c.req.header("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!apiKey) return c.json({ error: "missing bearer" }, 401);

  const tenantId = await apiKeyToTenantId(c.var.services.kv, apiKey);
  if (!tenantId) return c.json({ error: "forbidden" }, 403);

  const services = c.get("services");
  const target = await resolveProxyTargetByTenant(
    services,
    tenantId,
    sid,
    serverName,
  );
  if (!target) return c.json({ error: "forbidden" }, 403);

  // Buffer the body so forwardWithRefresh can replay it on a 401 retry.
  // For typical MCP clients body is a small JSON-RPC payload — fine to
  // hold in memory. Streamed uploads aren't a thing on this endpoint.
  const method = c.req.method;
  const body = ["GET", "HEAD"].includes(method) ? null : await c.req.text();

  return forwardWithRefresh(
    services,
    tenantId,
    target,
    method,
    c.req.raw.headers,
    body,
    { sessionId: sid, serverName: serverName, callerKind: "http" },
  );
});

export default app;
