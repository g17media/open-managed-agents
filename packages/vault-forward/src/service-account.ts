// Node-only JWT bearer exchange. Never import this entrypoint into the CF proxy.
import { createPrivateKey, sign } from "node:crypto";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";

export interface ServiceAccountAuth {
  type: "service_account_jwt";
  mcpServerUrl?: string;
  clientEmail: string;
  privateKey: string | null;
  privateKeyId?: string;
  tokenUri: string;
  scopes: string;
  subject?: string;
  audience?: string;
  accessToken?: string | null;
  expiresAt?: string | null;
}

export function createServiceAccountAssertion(auth: ServiceAccountAuth, now = Date.now()): string {
  try {
    if (!auth.privateKey || !auth.clientEmail || !auth.scopes.trim()) throw new Error();
    const key = createPrivateKey(auth.privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT", ...(auth.privateKeyId && { kid: auth.privateKeyId }) };
    const claims = { iss: auth.clientEmail, scope: auth.scopes, aud: auth.audience ?? auth.tokenUri, iat, exp: iat + 3600,
      ...(auth.subject && { sub: auth.subject }) };
    const content = [header, claims].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${content}.${Buffer.from(sign("RSA-SHA256", Buffer.from(content), key)).toString("base64url")}`;
  } catch { throw new Error("Invalid service account signing configuration"); }
}

export async function mintServiceAccountToken(auth: ServiceAccountAuth, request: typeof fetch = fetch) {
  try {
    const endpoint = new URL(auth.tokenUri);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error();
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: createServiceAccountAssertion(auth) });
    const response = await request(endpoint.href, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const tokens = await response.json() as { access_token?: unknown; expires_in?: unknown };
    // RFC 6750 b64token: reject unsafe header bytes before storage or transport.
    if (typeof tokens.access_token !== "string" || !/^[A-Za-z0-9._~+\/-]+=*$/.test(tokens.access_token) || /[\r\n]/.test(tokens.access_token)
      || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error();
    return { accessToken: tokens.access_token, expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() };
  } catch { throw new Error("Service account token exchange failed"); }
}

const states = new WeakMap<CredentialStore, { cache: Map<string, { accessToken: string; expiresAt: string }>; flights: Map<string, Promise<string>> }>();
const configurationFields = ["mcpServerUrl", "clientEmail", "privateKey", "privateKeyId", "tokenUri", "scopes", "subject", "audience"] as const;
const sameConfiguration = (left: ServiceAccountAuth, right: ServiceAccountAuth) => configurationFields.every((field) => left[field] === right[field]);
const fresh = (expiresAt?: string | null) => !!expiresAt && Date.parse(expiresAt) > Date.now() + 300_000;

/** Live reads and revision CAS prevent an in-flight exchange overwriting key/scopes edits.
 * Tokens persist encrypted, like managed OAuth, so other processes reuse them. Single
 * flight is per process/store; CAS handles cross-process races without stale writes. */
export async function getServiceAccountToken(store: CredentialStore, workspaceId: string, record: StoredCredential,
  options: { rejectedToken?: string; fetch?: typeof fetch } = {}): Promise<string> {
  const location = { workspaceId, vaultId: record.credential.vaultId, credentialId: record.credential.id };
  const current = await store.find(location);
  if (!current || current.credential.archivedAt || current.credential.auth.type !== "service_account_jwt") {
    throw new Error("Service account credential is no longer available");
  }
  const auth = current.credential.auth;
  if (record.credential.auth.type !== "service_account_jwt" || !sameConfiguration(auth, record.credential.auth)) {
    throw new Error("Service account credential changed during request resolution");
  }
  let state = states.get(store);
  if (!state) { state = { cache: new Map(), flights: new Map() }; states.set(store, state); }
  const cacheKey = JSON.stringify([workspaceId, location.vaultId, location.credentialId, current.revision]);
  const cached = state.cache.get(cacheKey);
  const token = cached ?? (auth.accessToken && auth.expiresAt ? { accessToken: auth.accessToken, expiresAt: auth.expiresAt } : undefined);
  if (token && fresh(token.expiresAt) && token.accessToken !== options.rejectedToken) return token.accessToken;
  const pending = state.flights.get(cacheKey);
  if (pending) return pending;
  const job = (async () => {
    const minted = await mintServiceAccountToken(auth, options.fetch);
    const result = await store.replace({ ...location, expectedRevision: current.revision, next: {
      ...current.credential, updatedAt: new Date().toISOString(), auth: { ...auth, ...minted },
    } });
    if (result.type !== "replaced") {
      // A concurrent process can win the mint; an operator edit clears token state.
      const latest = await store.find(location);
      const live = latest?.credential.auth;
      if (latest && !latest.credential.archivedAt && live?.type === "service_account_jwt" && sameConfiguration(auth, live) && live.accessToken && fresh(live.expiresAt)
        && live.accessToken !== options.rejectedToken) return live.accessToken;
      throw new Error("Service account credential changed during token exchange");
    }
    // Bound retained secrets/revisions in long-lived vault processes.
    for (const [key, value] of state.cache) if (!fresh(value.expiresAt)) state.cache.delete(key);
    if (state.cache.size >= 1000) state.cache.delete(state.cache.keys().next().value!);
    state.cache.set(JSON.stringify([workspaceId, location.vaultId, location.credentialId, result.record.revision]), minted);
    return minted.accessToken;
  })();
  state.flights.set(cacheKey, job);
  try { return await job; } finally { state.flights.delete(cacheKey); }
}
