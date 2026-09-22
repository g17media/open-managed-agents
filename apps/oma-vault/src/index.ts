/**
 * apps/oma-vault — outbound credential injector for Self-host OMA.
 *
 * Architecture:
 *
 *   sandbox bash → curl https://api.github.com/user
 *       │
 *       │  HTTPS_PROXY=http://oma-vault:14322
 *       │  NODE_EXTRA_CA_CERTS=/var/oma-vault-ca.crt
 *       ▼
 *   oma-vault (this process)
 *     - mockttp HTTPS proxy with self-signed CA (regenerated per install)
 *     - on incoming request: attribute to a session via proxy-auth socket
 *       metadata (tags set by the sandbox adapters), then lookup
 *       credentials scoped to that session's live vault_ids — falling
 *       back to host-wide match for unattributed traffic
 *     - inject Authorization / x-api-key / etc. header
 *     - forward to upstream
 *       │
 *       ▼
 *   api.github.com  ← sees Authorization: Bearer ghp_xxx
 *
 * The agent never sees the credential value. main-node doesn't either at
 * request time — apps/oma-vault reads vault credentials directly from the
 * shared sqlite db.
 *
 * This is the self-host analog of @cloudflare/sandbox's outboundByHost +
 * MAIN_MCP.outboundForward pattern. Same security model: per-sandbox CA,
 * MITM proxy, credential matched on hostname, inject header, forward.
 */

import { promises as fs } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getLocal, generateCACertificate, type CompletedRequest } from "mockttp";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  parseVaultProxyTags,
  verifyVaultProxyAttribution,
  type VaultProxyAttribution,
} from "@open-managed-agents/sandbox/vault-proxy";
import type { CredentialAuth } from "@open-managed-agents/shared";
import type { Credential } from "@open-managed-agents/domain/credentials";
import {
  applyCapOverrides,
  builtinSpecs,
  createSpecRegistry,
  parseCapOverridesFromEnv,
} from "@open-managed-agents/cap";
import { createNodeLogger } from "@open-managed-agents/observability/logger/node";
import { setRootLogger, type Logger } from "@open-managed-agents/observability";
import { evaluateEgress, type NetworkingPolicy } from "./egress-policy";

import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { SqlSessionExecutionContextSource } from "@open-managed-agents/session-runtime-sql";
import {
  credentialBearer,
  listManagedVaultCredentials,
  matchManagedCredential,
  refreshManagedCliCredential,
} from "@open-managed-agents/vault-forward/managed";

const logger: Logger = await createNodeLogger({ bindings: { service: "oma-vault" } });
setRootLogger(logger);

// ─── Bootstrap ───────────────────────────────────────────────────────────

// Backend selection mirrors main-node: DATABASE_URL (postgres:// /
// postgresql://) wins, else fall back to better-sqlite3 with DATABASE_PATH.
// Vault credentials are written by main-node into the same store, so the
// two services MUST agree on the backend or oma-vault won't see the rows.
const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres =
  dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
const caDir = process.env.OMA_VAULT_CA_DIR ?? "./data/oma-vault-ca";
const port = Number(process.env.OMA_VAULT_PORT ?? 14322);
// Tenant scoping: default "*" means look across ALL tenants by host. Set to
// a specific `tn_xxx` id to lock the proxy to a single tenant — required
// for multi-user prod deploys, since cross-tenant matching can leak a
// credential between tenants when both register the same host.
const scopeTenantId = process.env.OMA_TENANT ?? "*";
// Optional HMAC key shared with main-node (same env var there). When set,
// session attribution tags must carry a valid signature — a sandbox can't
// claim another session's identity. When unset, tags are trusted as-is.
const proxyKey = process.env.OMA_VAULT_PROXY_KEY ?? "";
// Egress policy for requests with no (or forged) session attribution.
// "allow" (default) keeps operator curl and pre-upgrade sandboxes working;
// "deny" closes the strip-the-proxy-auth loophole around environment
// networking limits — pair it with OMA_VAULT_PROXY_KEY for a real lockdown.
const unattributedEgress =
  process.env.OMA_VAULT_UNATTRIBUTED_EGRESS === "deny" ? "deny" : "allow";
// cap_cli credentials issued by the device flow carry no mcp_server_url; the
// cap registry maps a request hostname back to their cli_id instead. Same
// CAP_OVERRIDE_<CLI_ID>_* env as main-node so both sides agree on endpoints.
const capRegistry = createSpecRegistry(applyCapOverrides(
  builtinSpecs,
  parseCapOverridesFromEnv(builtinSpecs.map((s) => s.cli_id), process.env),
));

mkdirSync(resolve(caDir), { recursive: true });

const sql: SqlClient = usePostgres
  ? await createPostgresSqlClient(dbUrl)
  : await createBetterSqlite3SqlClient(dbPath);
const managedSessions = new SqlSessionExecutionContextSource(sql);
const credentialCrypto = process.env.PLATFORM_ROOT_SECRET
  ? new WebCryptoAesGcm(process.env.PLATFORM_ROOT_SECRET, "managed.vault.credentials") : null;
const resourceCrypto = process.env.PLATFORM_ROOT_SECRET
  ? new WebCryptoAesGcm(process.env.PLATFORM_ROOT_SECRET, "managed.sessions.resources") : null;
const managedCredentials = new SqlCredentialStore(sql, {
  seal: async ({ plaintext }) => {
    if (!credentialCrypto) throw new Error("PLATFORM_ROOT_SECRET is required for vault credentials");
    return { ciphertext: await credentialCrypto.encrypt(plaintext) };
  },
  open: async ({ ciphertext }) => {
    if (!credentialCrypto) throw new Error("PLATFORM_ROOT_SECRET is required for vault credentials");
    return { plaintext: await credentialCrypto.decrypt(ciphertext) };
  },
});
logger.info(
  { op: "oma_vault.sql_backend", backend: usePostgres ? "postgres" : "sqlite", dsn: usePostgres ? new URL(dbUrl).host : dbPath },
  `sql backend: ${usePostgres ? `postgres ${new URL(dbUrl).host}` : `sqlite ${dbPath}`}`,
);

// ─── CA management ───────────────────────────────────────────────────────
//
// On first start we generate a self-signed CA + key, persist them at
// ${OMA_VAULT_CA_DIR}/{ca.crt,ca.key}. Subsequent starts reuse the same CA
// so sandboxes that already trust it don't need to be updated. Sandboxes
// install ca.crt at startup via NODE_EXTRA_CA_CERTS / equivalent.
//
// Multi-replica safety: when N vault replicas boot against a shared
// caDir (e.g. NFS / EFS / shared docker volume) we must avoid all N
// generating different CAs and racing to overwrite ca.key — sandboxes
// would only trust one of them. Strategy:
//   1. Try to read existing files (happy path on every start past first).
//   2. Otherwise, attempt an exclusive create (O_EXCL) on `ca.lock`. The
//      losing replicas wait+poll for ca.crt to appear, then read it.
//   3. The winner generates the CA, writes ca.crt + ca.key, then releases
//      the lock by removing ca.lock.

async function loadOrCreateCA(): Promise<{ cert: string; key: string }> {
  const certPath = resolve(caDir, "ca.crt");
  const keyPath = resolve(caDir, "ca.key");
  const lockPath = resolve(caDir, "ca.lock");

  // Happy path: cert + key already on disk.
  const existing = await tryReadCA(certPath, keyPath);
  if (existing) return existing;

  // Race-safe create. O_EXCL means exactly one replica succeeds; the
  // others fall through to the wait-and-read path.
  let lockFd: import("node:fs/promises").FileHandle | null = null;
  try {
    lockFd = await fs.open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another replica is generating; wait for ca.crt to appear.
    return waitForCA(certPath, keyPath);
  }

  try {
    // Re-check inside the lock — a third replica may have generated
    // between our initial read and our lock acquisition.
    const inLock = await tryReadCA(certPath, keyPath);
    if (inLock) return inLock;

    logger.info({ op: "oma_vault.ca_generate", ca_dir: caDir }, `generating new CA at ${caDir}`);
    const ca = await generateCACertificate({
      subject: { commonName: "OMA Vault Local CA" },
    });
    await fs.writeFile(certPath, ca.cert);
    await fs.writeFile(keyPath, ca.key, { mode: 0o600 });
    return ca;
  } finally {
    await lockFd.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function tryReadCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string } | null> {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    return { cert, key };
  } catch {
    return null;
  }
}

/** Poll until the winning replica finishes writing ca.crt + ca.key. The
 *  generator runs in <1s on commodity hardware; bound the wait at 30s
 *  to avoid wedging a deploy when the lock holder dies mid-generation. */
async function waitForCA(
  certPath: string,
  keyPath: string,
): Promise<{ cert: string; key: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const got = await tryReadCA(certPath, keyPath);
    if (got) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[oma-vault] timed out waiting for peer to generate CA at ${certPath}`,
  );
}

const ca = await loadOrCreateCA();

// ─── Credential matching ─────────────────────────────────────────────────

interface MatchedCred {
  vaultId: string;
  credentialId: string;
  injectHeader: { name: string; value: string };
  /**
   * True only for a plain `static_bearer` credential: the one kind whose token may be placed in a
   * provider's API-key header (see API_KEY_HEADER_BY_HOST). cap_cli, OAuth and repository
   * credentials always stay in `Authorization`, whatever the request carries.
   */
  apiKeyCapable?: boolean;
  /**
   * HTTP Basic form of a static_bearer / cap_cli token, used instead of injectHeader
   * for git smart-HTTP requests: GitHub's git endpoints answer 401 to
   * `Bearer <PAT>` and require Basic with the token as the password.
   */
  gitBasicHeader?: string;
  /**
   * Rotates the credential after the upstream answers 401. Resolves to the new
   * bearer token, or null when nothing changed. Set only for managed cap_cli
   * credentials that carry a refresh token and whose spec has a token endpoint.
   */
  refresh?: () => Promise<string | null>;
}

// git smart-HTTP: ref advertisement (GET .../info/refs?service=git-upload-pack)
// and the upload/receive-pack POSTs. Anything else on the host keeps Bearer.
const GIT_SMART_HTTP_RE = /\/info\/refs\?service=git-(upload|receive)-pack(&|$)|\/git-(upload|receive)-pack(\?|$)/;

/**
 * Find the active credential whose mcp_server_url host matches the request
 * host. Returns the header to inject, or null when no credential applies.
 *
 * Today's matcher: exact hostname match against
 * URL(credential.mcp_server_url).host, then — for cap_cli credentials that
 * have no mcp_server_url — the cap registry's hostname → cli_id mapping.
 * Wildcards / suffix match TBD when we hit a use case (e.g.
 * `*.googleapis.com` for google credentials).
 *
 * Session attribution: sandbox adapters embed `oma-tenant:` / `oma-session:`
 * tags in the proxy URL's userinfo (packages/sandbox/src/vault-proxy.ts);
 * mockttp surfaces them on every intercepted request. When present, the
 * lookup reads the session row's vault_ids LIVE and only credentials from
 * those vaults (in the session's tenant) are eligible — matching the CF
 * path's per-call resolve, so mid-session vault swaps apply on the next
 * outbound request. A session with no vaults gets no injection.
 *
 * Unattributed requests (operator curl, pre-upgrade sandboxes) fall back
 * to the legacy host-wide match. SECURITY LIMITATION on that path: if two
 * tenants both register a credential for the same host, the second
 * tenant's request can pick up the first tenant's token. Setting
 * OMA_TENANT to a specific tenant id locks all lookup to that tenant.
 * Set OMA_VAULT_PROXY_KEY (both processes) to make session attribution
 * unforgeable from inside the sandbox.
 */
async function findCredentialForUrl(
  url: string,
  attr: VaultProxyAttribution,
  selector?: string,
): Promise<MatchedCred | null> {
  let host: string;
  let hostname: string;
  try {
    ({ host, hostname } = new URL(url));
  } catch {
    return null;
  }

  if (attr.sessionId && attr.tenantId) {
    if (scopeTenantId !== "*" && attr.tenantId !== scopeTenantId) return null;
    const context = await managedSessions.find({ workspaceId: attr.tenantId, sessionId: attr.sessionId });
    if (context) {
      if (context.session.archivedAt) return null;
      // Repository resource tokens are sealed separately and only authorize that repository's git endpoints.
      if (resourceCrypto && GIT_SMART_HTTP_RE.test(url)) {
        const requestUrl = new URL(url);
        const repository = context.session.resources.find((resource) => {
          if (resource.type !== "github_repository") return false;
          const target = new URL(resource.url);
          const base = target.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
          const path = requestUrl.pathname.replace(/\.git(?=\/)/, "");
          return target.host === requestUrl.host && ["/info/refs", "/git-upload-pack", "/git-receive-pack"].some((suffix) => path === `${base}${suffix}`);
        });
        if (repository && repository.type === "github_repository") {
          const secret = await sql.prepare("SELECT sealed_value FROM managed_session_resource_secrets WHERE workspace_id = ? AND session_id = ? AND resource_id = ? AND secret_type = 'github_token'")
            .bind(attr.tenantId, attr.sessionId, repository.id).first<{ sealed_value: string }>();
          if (secret) {
            const token = await resourceCrypto.decrypt(secret.sealed_value);
            const value = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
            return { vaultId: "repository", credentialId: repository.id, injectHeader: { name: "authorization", value }, gitBasicHeader: value };
          }
        }
      }
      const activeVaults: string[] = [];
      for (const vaultId of context.session.vaultIds) {
        if (await sql.prepare("SELECT id FROM managed_vaults WHERE workspace_id = ? AND id = ? AND archived_at IS NULL").bind(attr.tenantId, vaultId).first()) activeVaults.push(vaultId);
      }
      const records = await listManagedVaultCredentials(managedCredentials, attr.tenantId, activeVaults);
      const credentials = records.map((record) => record.credential);
      const credential = matchManagedCredential(credentials, url, selector)
        ?? matchManagedCapCredential(credentials, hostname);
      if (!credential) return null;
      const token = credentialBearer(credential.auth)!;
      const workspaceId = attr.tenantId;
      const record = records.find((r) => r.credential.id === credential.id);
      const deviceFlow = credential.auth.type === "cap_cli" && credential.auth.extras?.refresh_token
        ? capRegistry.byCliId(credential.auth.cliId)?.oauth?.device_flow : undefined;
      return { credentialId: credential.id, vaultId: credential.vaultId,
        injectHeader: { name: "authorization", value: `Bearer ${token}` },
        apiKeyCapable: credential.auth.type === "static_bearer",
        ...((credential.auth.type === "static_bearer" || credential.auth.type === "cap_cli") && {
          gitBasicHeader: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }),
        ...(record && deviceFlow && {
          refresh: async () => {
            const next = await refreshManagedCliCredential(
              managedCredentials, workspaceId, record, deviceFlow.token_url, deviceFlow.client_id);
            const fresh = credentialBearer(next.credential.auth);
            return fresh && fresh !== token ? fresh : null;
          },
        }),
      };
    }
  }
  if (attr.sessionId) {
    // Session-scoped path: live vault_ids read → strictly that vault set.
    type SessRow = { tenant_id: string; vault_ids: string | null };
    const sess = await sql
      .prepare(`SELECT tenant_id, vault_ids FROM sessions WHERE id = ?`)
      .bind(attr.sessionId)
      .all<SessRow>();
    const row = (sess.results ?? [])[0];
    if (!row) {
      logger.debug(
        { op: "oma_vault.session_unknown", session_id: attr.sessionId },
        `no session row for ${attr.sessionId} — no injection`,
      );
      return null;
    }
    if (attr.tenantId && row.tenant_id !== attr.tenantId) return null;
    if (scopeTenantId !== "*" && row.tenant_id !== scopeTenantId) return null;
    let vaultIds: string[] = [];
    try {
      vaultIds = row.vault_ids ? (JSON.parse(row.vault_ids) as string[]) : [];
    } catch {
      /* malformed column — treat as no vaults */
    }
    if (vaultIds.length === 0) return null;
    const placeholders = vaultIds.map(() => "?").join(",");
    const result = await sql
      .prepare(
        `SELECT id, tenant_id, vault_id, auth, created_at, updated_at
           FROM credentials
          WHERE archived_at IS NULL
            AND tenant_id = ?
            AND vault_id IN (${placeholders})`,
      )
      .bind(row.tenant_id, ...vaultIds)
      .all<Row>();
    const rows = result.results ?? [];
    return matchRowsByHost(rows, host, selector) ?? matchRowsByCapSpec(rows, hostname);
  }

  // Legacy host-wide lookup. When OMA_TENANT="*" we accept any tenant;
  // when it's a specific tenant id we filter to that one (recommended for
  // multi-user prod deploys). Candidates are materialized by parsing
  // mcp_server_url — acceptable cost: typical deploys have O(10)
  // credentials.
  const result = await sql
    .prepare(
      `SELECT id, tenant_id, vault_id, auth, created_at, updated_at
         FROM credentials
        WHERE archived_at IS NULL
          AND ( ? = '*' OR tenant_id = ? )`,
    )
    .bind(scopeTenantId, scopeTenantId)
    .all<Row>();
  const rows = result.results ?? [];
  return matchRowsByHost(rows, host, selector) ?? matchRowsByCapSpec(rows, hostname);
}

type Row = {
  id: string;
  tenant_id: string;
  vault_id: string;
  auth: string;
  created_at: number;
  updated_at: number | null;
};

/**
 * Newest managed cap_cli credential for the CLI that cap maps `hostname` to.
 * Fallback for credentials the device flow wrote without an mcp_server_url.
 */
function matchManagedCapCredential(credentials: Credential[], hostname: string): Credential | null {
  const spec = capRegistry.byHostname(hostname);
  if (!spec) return null;
  let best: Credential | null = null;
  for (const credential of credentials) {
    const auth = credential.auth;
    if (credential.archivedAt || auth.type !== "cap_cli" || auth.cliId !== spec.cli_id || !auth.token) continue;
    if (best === null || Date.parse(credential.updatedAt) > Date.parse(best.updatedAt)) best = credential;
  }
  return best;
}

/** Legacy-row counterpart of matchManagedCapCredential. */
function matchRowsByCapSpec(rows: Row[], hostname: string): MatchedCred | null {
  const spec = capRegistry.byHostname(hostname);
  if (!spec) return null;
  let best: { ts: number; match: MatchedCred } | null = null;
  for (const row of rows) {
    let auth: CredentialAuth;
    try { auth = JSON.parse(row.auth) as CredentialAuth; } catch { continue; }
    if (auth.type !== "cap_cli" || auth.cli_id !== spec.cli_id) continue;
    const headerSpec = authToHeader(auth);
    if (!headerSpec) continue;
    const ts = row.updated_at ?? row.created_at;
    if (best !== null && ts <= best.ts) continue;
    best = { ts, match: toMatchedCred(row, auth, headerSpec) };
  }
  return best?.match ?? null;
}

/**
 * Pick the credential for `host`. When several credentials share a host
 * (two GitHub identities, say) the sandbox can choose one explicitly by
 * sending HTTP Basic auth whose *username* equals the credential's
 * `auth.handle` — services like GitHub ignore the username when the
 * password is a token, so it is a free selector field. The placeholder
 * password is discarded with the rest of the inbound Authorization header.
 *
 * Priority: handle match > host-only credential (no handle) > any handled
 * credential for the host (so tools that send other usernames, e.g. `gh`,
 * still work in a session whose only GitHub credential has a handle).
 */
function matchRowsByHost(rows: Row[], host: string, selector?: string): MatchedCred | null {
  let best: { rank: number; match: MatchedCred } | null = null;
  for (const row of rows) {
    let auth: CredentialAuth;
    try { auth = JSON.parse(row.auth) as CredentialAuth; } catch { continue; }
    if (!auth.mcp_server_url) continue;
    let credHost: string;
    try { credHost = new URL(auth.mcp_server_url).host; } catch { continue; }
    if (credHost !== host) continue;
    const headerSpec = authToHeader(auth);
    if (!headerSpec) continue;
    const handle = typeof auth.handle === "string" && auth.handle.length > 0 ? auth.handle : undefined;
    const rank = handle !== undefined && selector !== undefined && handle === selector ? 0 : handle === undefined ? 1 : 2;
    if (best !== null && rank >= best.rank) continue;
    best = { rank, match: toMatchedCred(row, auth, headerSpec) };
    if (rank === 0) break;
  }
  return best?.match ?? null;
}

function toMatchedCred(row: Row, auth: CredentialAuth, injectHeader: { name: string; value: string }): MatchedCred {
  return {
    vaultId: row.vault_id,
    credentialId: row.id,
    injectHeader,
    apiKeyCapable: auth.type === "static_bearer",
    gitBasicHeader:
      (auth.type === "static_bearer" || auth.type === "cap_cli") &&
      typeof auth.token === "string" && auth.token.length > 0
        ? `Basic ${Buffer.from(`x-access-token:${auth.token}`).toString("base64")}`
        : undefined,
  };
}

/** Username of an inbound `Authorization: Basic …` header, else undefined. */
function basicAuthUsername(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string" || !/^basic /i.test(raw)) return undefined;
  try {
    const decoded = Buffer.from(raw.slice(6).trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const user = i === -1 ? decoded : decoded.slice(0, i);
    return user.length > 0 ? user : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Providers whose static API key must travel in a header of their own instead of
 * `Authorization: Bearer`. The mapping is fixed here, per host, so a request can never choose
 * where a token lands: it can only send the provider's own header (with any placeholder value) to
 * ask for that provider's documented shape. A host absent from this map always gets Bearer.
 */
const API_KEY_HEADER_BY_HOST = new Map<string, "x-goog-api-key" | "x-api-key">([
  ["generativelanguage.googleapis.com", "x-goog-api-key"],
  ["api.anthropic.com", "x-api-key"],
]);

/** The token of an `Authorization: Bearer <token>` injection, or undefined for any other shape. */
function bearerToken(header: { name: string; value: string }): string | undefined {
  if (header.name !== "authorization") return undefined;
  const match = /^Bearer (.+)$/.exec(header.value);
  return match?.[1];
}

/**
 * The API-key header to inject into instead of `Authorization`, or undefined to keep Bearer.
 * Requires all three: the host is one whose key header is known, the client sent that header, and
 * the matched credential is a plain static_bearer. Everything else — other hosts, cap_cli/OAuth
 * credentials, git Basic — is untouched by this adaptation.
 */
function apiKeyHeaderFor(
  url: string,
  requestHeaders: Record<string, string | string[] | undefined>,
  matched: MatchedCred,
): "x-goog-api-key" | "x-api-key" | undefined {
  if (matched.apiKeyCapable !== true) return undefined;
  let host: string;
  try { host = new URL(url).hostname; } catch { return undefined; }
  const name = API_KEY_HEADER_BY_HOST.get(host);
  return name !== undefined && requestHeaders[name] !== undefined ? name : undefined;
}

function authToHeader(auth: CredentialAuth): { name: string; value: string } | null {
  switch (auth.type) {
    case "static_bearer":
      return { name: "authorization", value: `Bearer ${auth.token}` };
    case "cap_cli":
      // cap_cli credentials are injected via cap's spec-driven enforcement
      // (header_inject mode for most CLIs). The simple Bearer fallback
      // here works for header-mode CLIs whose spec just sets Authorization;
      // metadata_ep / exec_helper CLIs need richer routing — handled when
      // self-host oma-vault adopts cap.handleHttp directly (follow-up PR).
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "mcp_oauth":
      // OAuth would need refresh-token handling; not in PoC scope. Skip
      // until the oma-vault supports it; the credential just gets ignored.
      return null;
    default:
      return null;
  }
}

// ─── Environment networking limits ───────────────────────────────────────
//
// session → environment_id → environments.config.networking, enforced in
// the request handler below (see egress-policy.ts for semantics). A short
// TTL cache keeps parallel sandbox traffic from hammering sqlite; 10s of
// staleness on a policy edit is acceptable.

const NETWORKING_CACHE_TTL_MS = 10_000;
const networkingCache = new Map<
  string,
  { policy: NetworkingPolicy | null; expiresAt: number }
>();

async function networkingForSession(sessionId: string): Promise<NetworkingPolicy | null> {
  const cached = networkingCache.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;

  let policy: NetworkingPolicy | null = null;
  type SessRow = { tenant_id: string; environment_id: string | null };
  const sess = await sql
    .prepare(`SELECT tenant_id, environment_id FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .all<SessRow>();
  const row = (sess.results ?? [])[0];
  if (row?.environment_id && (scopeTenantId === "*" || row.tenant_id === scopeTenantId)) {
    type EnvRow = { config: string };
    const env = await sql
      .prepare(`SELECT config FROM environments WHERE id = ? AND tenant_id = ?`)
      .bind(row.environment_id, row.tenant_id)
      .all<EnvRow>();
    const envRow = (env.results ?? [])[0];
    if (envRow) {
      try {
        policy = (JSON.parse(envRow.config) as { networking?: NetworkingPolicy }).networking ?? null;
      } catch {
        /* malformed config — treat as no policy */
      }
    }
  }
  networkingCache.set(sessionId, { policy, expiresAt: Date.now() + NETWORKING_CACHE_TTL_MS });
  return policy;
}

/** null = allowed; otherwise the reason to 403 with. */
async function checkEgress(url: string, attr: VaultProxyAttribution): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `unparseable request URL`;
  }
  if (!attr.sessionId) {
    return unattributedEgress === "deny"
      ? "unattributed sandbox traffic is denied (OMA_VAULT_UNATTRIBUTED_EGRESS=deny)"
      : null;
  }
  if (attr.tenantId) {
    if (scopeTenantId !== "*" && attr.tenantId !== scopeTenantId) return "Session workspace is unavailable";
    const context = await managedSessions.find({ workspaceId: attr.tenantId, sessionId: attr.sessionId });
    if (context) {
      if (context.session.archivedAt) return "Session is archived";
      const config = context.environment.config;
      if (config.type !== "cloud") return null;
      const network = config.networking;
      return evaluateEgress(hostname, network.type === "unrestricted" ? network : {
        type: "limited", allowed_hosts: network.allowedHosts,
        allow_mcp_servers: network.allowMcpServers,
        allow_package_managers: network.allowPackageManagers,
      });
    }
  }
  return evaluateEgress(hostname, await networkingForSession(attr.sessionId));
}

// ─── mockttp proxy ───────────────────────────────────────────────────────

const proxy = getLocal({
  https: { cert: ca.cert, key: ca.key },
  // record traffic = false; we don't keep request bodies in memory
  recordTraffic: false,
});

// Match all proxied traffic. For each request: look up credentials, inject
// header, forward. Plain HTTP and HTTPS via CONNECT both flow through the
// same handler thanks to mockttp's TLS termination.
proxy.forAnyRequest().thenCallback(async (req: CompletedRequest) => {
  const url = req.url;
  // Session attribution rides in via mockttp socket metadata (proxy auth
  // set by the sandbox adapters). Invalid signature with a configured key
  // means someone inside a sandbox is forging attribution — fail closed:
  // no credential injection, and the forged identity is discarded so the
  // request faces the unattributed egress policy instead of the claimed
  // session's.
  const rawAttr = parseVaultProxyTags(req.tags ?? []);
  const forged = Boolean(rawAttr.sessionId && proxyKey && !verifyVaultProxyAttribution(rawAttr, proxyKey));
  if (forged) {
    logger.warn(
      { op: "oma_vault.bad_attribution", session_id: rawAttr.sessionId, url },
      `rejecting unverified session attribution for ${url}`,
    );
  }
  const attr: VaultProxyAttribution = forged ? {} : rawAttr;

  // Environment networking limits (config.networking type "limited") —
  // enforced before any forwarding, so sandbox-shell traffic is policed,
  // not just the web_fetch tool.
  const denial = await checkEgress(url, attr);
  if (denial) {
    logger.warn(
      { op: "oma_vault.egress_denied", session_id: attr.sessionId, url },
      `egress denied for ${url}: ${denial}`,
    );
    return {
      statusCode: 403,
      headers: { "content-type": "text/plain" },
      body: `oma-vault: ${denial}`,
    };
  }

  // The inbound Authorization header is stripped below, but its Basic-auth
  // username is read first: it lets the sandbox name which credential it
  // wants when several match the host (see matchRowsByHost).
  const selector = basicAuthUsername(req.headers["authorization"]);
  const matched: MatchedCred | null = forged ? null : await findCredentialForUrl(url, attr, selector);

  // Strip any incoming Authorization headers — the agent must not be able
  // to override the injected value or smuggle a stolen token. Mirrors the
  // Infisical Agent Vault + CF outboundByHost zero-trust behaviour.
  //
  // Also strip hop-by-hop / connection-level headers that would confuse
  // node:fetch's outbound — `host` (we let fetch infer from the URL),
  // `content-length` (fetch sets it), proxy-* headers, etc. Without this
  // strip, fetch() throws "fetch failed" when the inbound `host:
  // oma-vault:14322` clashes with the upstream URL's actual host.
  const STRIP = new Set([
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "host",
    "content-length",
    "connection",
    // curl adds `Expect: 100-continue` on large uploads; undici's fetch
    // refuses to forward it (NotSupportedError). The 100-continue dance
    // already happened between client and mockttp (body is fully
    // buffered here), so dropping it is semantically correct.
    "expect",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (STRIP.has(lower)) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }

  let refresh: MatchedCred["refresh"];
  if (matched) {
    const useGitBasic = matched.gitBasicHeader !== undefined && GIT_SMART_HTTP_RE.test(url);
    // Gemini reads a static key only from `x-goog-api-key` (Anthropic from `x-api-key`); for those
    // hosts a static_bearer token goes into that header when the client asked for it by sending
    // it. The inbound header itself was stripped above like every other credential header, so the
    // request supplies the shape only, never the value.
    const keyHeader = useGitBasic ? undefined : apiKeyHeaderFor(url, req.headers, matched);
    const bareToken = keyHeader !== undefined ? bearerToken(matched.injectHeader) : undefined;
    const injectName = bareToken !== undefined ? keyHeader! : matched.injectHeader.name;
    headers[injectName] = useGitBasic ? matched.gitBasicHeader! : bareToken ?? matched.injectHeader.value;
    // Only the plain Bearer shape is retried after a refresh; git Basic and API-key headers are not.
    if (!useGitBasic && bareToken === undefined) refresh = matched.refresh;
    logger.info(
      { op: "oma_vault.inject", header: injectName, url, credential_id: matched.credentialId, session_id: attr.sessionId },
      `inject ${injectName} for ${url}`,
    );
  } else {
    logger.debug({ op: "oma_vault.passthrough", method: req.method, url }, `passthrough ${req.method} ${url}`);
  }

  // Forward to upstream. Read body as buffer to handle binary uploads.
  const bodyBuf = req.body.buffer;
  const forward = () => fetch(url, {
    method: req.method,
    headers,
    body: bodyBuf.byteLength > 0 ? bodyBuf : undefined,
    redirect: "manual",
  });
  let upstream: Response;
  try {
    upstream = await forward();
    if (upstream.status === 401 && refresh) {
      const fresh = await refresh().catch((err: unknown) => {
        logger.warn({ err, op: "oma_vault.refresh_failed", url, credential_id: matched?.credentialId }, `refresh failed for ${url}`);
        return null;
      });
      if (fresh) {
        await upstream.body?.cancel().catch(() => {});
        headers.authorization = `Bearer ${fresh}`;
        upstream = await forward();
        logger.info(
          { op: "oma_vault.refreshed", url, credential_id: matched?.credentialId, session_id: attr.sessionId, status: upstream.status },
          `retried ${url} with a refreshed token`,
        );
      }
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, op: "oma_vault.forward_failed", url }, `forward failed for ${url}: ${msg}`);
    return {
      statusCode: 502,
      headers: { "content-type": "text/plain" },
      body: `oma-vault: upstream forward failed: ${msg}`,
    };
  }

  // Response headers. Two classes must not survive the hop:
  //  - content-encoding / content-length describe the UPSTREAM body; fetch
  //    already decoded it and we re-frame below from the buffer we hold.
  //  - hop-by-hop headers (RFC 9110 §7.6.1) describe the upstream
  //    connection, not this one. Forwarding `connection: Keep-Alive` +
  //    `keep-alive:` while dropping content-length leaves the response
  //    unframed on a persistent connection: lenient clients (curl) read to
  //    EOF, but apt truncates and reports "Clearsigned file isn't valid,
  //    got 'NOSPLIT'" — every apt-get update through the vault failed on
  //    this until we started re-framing.
  const DROP_RESPONSE = new Set([
    "content-encoding",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (DROP_RESPONSE.has(k.toLowerCase())) return;
    respHeaders[k] = v;
  });

  const respBody = Buffer.from(await upstream.arrayBuffer());
  // Re-frame with the true post-decode length. 204/304 carry no body and
  // must not advertise one.
  const bodyless = upstream.status === 204 || upstream.status === 304;
  if (!bodyless) respHeaders["content-length"] = String(respBody.byteLength);

  return {
    statusCode: upstream.status,
    headers: respHeaders,
    body: bodyless ? Buffer.alloc(0) : respBody,
  };
});

await proxy.start(port);

logger.info(
  {
    op: "oma_vault.listening",
    port,
    tenant_scope: scopeTenantId === "*" ? "all" : scopeTenantId,
    ca_cert: resolve(caDir, "ca.crt"),
  },
  `listening on http://0.0.0.0:${port}`,
);
// User-facing copy/paste env block — kept on stdout intentionally so first
// run shows operators what to configure for sandbox processes.
const caCert = resolve(caDir, "ca.crt");
process.stdout.write(`\n# OMA vault sandbox env (copy into sandbox process):\nHTTPS_PROXY=http://localhost:${port}\nHTTP_PROXY=http://localhost:${port}\nNODE_EXTRA_CA_CERTS=${caCert}\nSSL_CERT_FILE=${caCert}\n# Optional: set OMA_VAULT_PROXY_KEY (same value here and on main-node) to\n# make per-session vault attribution unforgeable from inside sandboxes.\n\n`);

const shutdown = (signal: string) => {
  logger.info({ op: "oma_vault.shutdown", signal }, `received ${signal}, stopping proxy`);
  proxy.stop().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
