import { basicAuthorization, basicAuthSelector, credentialMatchRank } from "./index";
import type { Credential, CredentialAuth } from "@open-managed-agents/domain/credentials";
import type { Session } from "@open-managed-agents/domain/sessions";
import type { CredentialStore, StoredCredential } from "@open-managed-agents/credential-store";

export async function listManagedVaultCredentials(
  store: CredentialStore,
  workspaceId: string,
  vaultIds: string[],
): Promise<StoredCredential[]> {
  const result: StoredCredential[] = [];
  for (const vaultId of new Set(vaultIds)) {
    let position: { createdAt: string; credentialId: string } | undefined;
    for (;;) {
      const page = await store.list({ workspaceId, vaultId, limit: 100, includeArchived: false, position });
      result.push(...page);
      if (page.length < 100) break;
      const last = page[page.length - 1]!.credential;
      position = { createdAt: last.createdAt, credentialId: last.id };
    }
  }
  return result;
}

export function credentialBearer(auth: CredentialAuth): string | null {
  if (auth.type === "static_bearer" || auth.type === "cap_cli") return auth.token;
  return auth.type === "mcp_oauth" || auth.type === "service_account_jwt" ? auth.accessToken ?? null : null;
}

/** Full header; Basic passwords must never be consumed as bearer tokens. */
export function credentialAuthorization(auth: CredentialAuth): string | null {
  if (auth.type === "static_basic") return auth.token ? basicAuthorization(auth.username, auth.token) : null;
  const token = credentialBearer(auth);
  return token ? `Bearer ${token}` : null;
}

/** Resource credentials authorize the declared repository, including GitHub's repository API. */
export function matchManagedRepositoryResource(session: Session, url: string) {
  const request = new URL(url);
  return session.resources.find((resource) => {
    if (resource.type !== "github_repository") return false;
    const repository = new URL(resource.url);
    const path = repository.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    if (repository.host === "github.com" && request.host === "api.github.com") {
      return request.pathname === `/repos${path}` || request.pathname.startsWith(`/repos${path}/`);
    }
    const requestPath = request.pathname.replace(/\.git(?=\/)/, "");
    return repository.host === request.host && ["/info/refs", "/git-upload-pack", "/git-receive-pack"]
      .some((suffix) => requestPath === `${path}${suffix}`);
  });
}

export function matchManagedCredential(
  credentials: Credential[], url: string, selector?: string, incomingBasic = selector !== undefined,
): Credential | null {
  const request = new URL(url);
  let best: { rank: number; credential: Credential } | undefined;
  for (const credential of credentials) {
    const auth = credential.auth;
    if (credential.archivedAt || !("mcpServerUrl" in auth) || !auth.mcpServerUrl || (auth.type !== "service_account_jwt" && !credentialAuthorization(auth))) continue;
    try {
      const target = new URL(auth.mcpServerUrl);
      if (target.host !== request.host || (target.protocol === "https:" && request.protocol === "http:")) continue;
    } catch { continue; }
    const handle = "handle" in auth ? auth.handle : undefined;
    const rank = credentialMatchRank(auth.type, handle, selector, incomingBasic);
    if (best === undefined || rank < best.rank) best = { rank, credential };
  }
  return best?.credential ?? null;
}

/** Refresh against the native encrypted record, preserving scopes and guarding rotations with its revision. */
export async function refreshManagedCredential(
  store: CredentialStore, workspaceId: string, record: StoredCredential,
  request: typeof fetch = fetch,
): Promise<StoredCredential> {
  const location = { workspaceId, vaultId: record.credential.vaultId, credentialId: record.credential.id };
  const current = await store.find(location);
  if (!current || current.credential.archivedAt) throw new Error("Credential is no longer available");
  if (credentialBearer(current.credential.auth) !== credentialBearer(record.credential.auth)) return current;
  const auth = current.credential.auth;
  if (auth.type !== "mcp_oauth" || !auth.refresh?.refreshToken) return current;
  const refresh = auth.refresh;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh.refreshToken!, client_id: refresh.clientId });
  if (refresh.scope) body.set("scope", refresh.scope);
  if (refresh.resource) body.set("resource", refresh.resource);
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (refresh.tokenEndpointAuth.type === "client_secret_basic") {
    headers.set("authorization", `Basic ${btoa(`${encodeURIComponent(refresh.clientId)}:${encodeURIComponent(refresh.tokenEndpointAuth.clientSecret ?? "")}`)}`);
  } else if (refresh.tokenEndpointAuth.type === "client_secret_post" && refresh.tokenEndpointAuth.clientSecret) {
    body.set("client_secret", refresh.tokenEndpointAuth.clientSecret);
  }
  const response = await request(refresh.tokenEndpoint, { method: "POST", headers, body });
  if (!response.ok) return await store.find(location) ?? current;
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!tokens.access_token) return current;
  const result = await store.replace({ ...location, expectedRevision: current.revision, next: {
    ...current.credential,
    updatedAt: new Date().toISOString(),
    auth: { ...auth, accessToken: tokens.access_token,
      ...(tokens.scope !== undefined && { scope: tokens.scope }),
      ...(tokens.expires_in !== undefined && { expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }),
      refresh: { ...refresh, refreshToken: tokens.refresh_token ?? refresh.refreshToken,
        ...(tokens.scope !== undefined && { scope: tokens.scope }) },
    },
  } });
  return result.type === "replaced" ? result.record : await store.find(location) ?? current;
}

/**
 * cap_cli counterpart of refreshManagedCredential. The device flow stores the
 * refresh token in `extras.refresh_token`; the CLI's spec supplies the token
 * endpoint and public client id. Same revision guard, same "someone else
 * already rotated it" short-circuit.
 */
export async function refreshManagedCliCredential(
  store: CredentialStore, workspaceId: string, record: StoredCredential,
  tokenEndpoint: string, clientId: string,
  request: typeof fetch = fetch,
): Promise<StoredCredential> {
  const location = { workspaceId, vaultId: record.credential.vaultId, credentialId: record.credential.id };
  const current = await store.find(location);
  if (!current || current.credential.archivedAt) throw new Error("Credential is no longer available");
  if (credentialBearer(current.credential.auth) !== credentialBearer(record.credential.auth)) return current;
  const auth = current.credential.auth;
  if (auth.type !== "cap_cli" || !auth.extras?.refresh_token) return current;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.extras.refresh_token, client_id: clientId });
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const response = await request(tokenEndpoint, { method: "POST", headers, body });
  if (!response.ok) return await store.find(location) ?? current;
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token) return current;
  const result = await store.replace({ ...location, expectedRevision: current.revision, next: {
    ...current.credential,
    updatedAt: new Date().toISOString(),
    auth: { ...auth, token: tokens.access_token, extras: {
      ...auth.extras,
      refresh_token: tokens.refresh_token ?? auth.extras.refresh_token,
      ...(tokens.expires_in !== undefined && { expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }),
    } },
  } });
  return result.type === "replaced" ? result.record : await store.find(location) ?? current;
}

export async function forwardManagedMcpRequest(input: {
  request: Request;
  workspaceId: string;
  session: Session;
  serverName: string;
  credentials: CredentialStore;
  fetch?: typeof fetch;
  serviceAccountToken?: (record: StoredCredential, rejectedToken?: string) => Promise<string>;
}): Promise<Response> {
  const server = input.session.agent.mcpServers.find((server) => server.name.trim() === input.serverName.trim());
  // A stdio server has no URL to forward to — not proxyable over HTTP.
  if (input.session.archivedAt || !server || !("url" in server)) return new Response("Forbidden", { status: 403 });
  const credentials = await listManagedVaultCredentials(input.credentials, input.workspaceId, input.session.vaultIds);
  let record = credentials.find(({ credential }) => "mcpServerUrl" in credential.auth && credential.auth.mcpServerUrl === server.url && (credential.auth.type === "service_account_jwt" || credentialAuthorization(credential.auth)));
  const serviceAccount = record?.credential.auth.type === "service_account_jwt";
  if (serviceAccount && !input.serviceAccountToken) return new Response("service_account_jwt requires self-host oma-vault; Cloudflare forwarding is not supported", { status: 501 });
  let serviceAccountToken: string | undefined;
  if (serviceAccount) {
    try { serviceAccountToken = await input.serviceAccountToken!(record!); }
    catch { return new Response("Service account token exchange failed", { status: 502 }); }
  }
  const headers = new Headers(input.request.headers);
  for (const key of ["x-oma-tenant", "x-oma-session", "x-oma-mcp-server", "host", "authorization", "proxy-authorization", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]) headers.delete(key);
  const body = ["GET", "HEAD"].includes(input.request.method) ? undefined : await input.request.arrayBuffer();
  const request = input.fetch ?? fetch;
  const forward = () => {
    const authorization = serviceAccountToken ? `Bearer ${serviceAccountToken}` : record && credentialAuthorization(record.credential.auth);
    if (authorization) headers.set("authorization", authorization);
    return request(server.url, { method: input.request.method, headers, body, redirect: "manual" });
  };
  const first = await forward();
  if (serviceAccount) {
    if (first.status !== 401) return first;
    try { serviceAccountToken = await input.serviceAccountToken!(record!, serviceAccountToken); }
    catch { return first; }
    await first.body?.cancel().catch(() => {});
    return forward();
  }
  if ((first.status !== 401 && first.status !== 403) || record?.credential.auth.type !== "mcp_oauth" || !record.credential.auth.refresh?.refreshToken) return first;
  await first.body?.cancel();
  record = await refreshManagedCredential(input.credentials, input.workspaceId, record, request);
  return forward();
}

export async function forwardManagedOutboundRequest(input: {
  request: Request; workspaceId: string; session: Session; credentials: CredentialStore; fetch?: typeof fetch;
  serviceAccountToken?: (record: StoredCredential, rejectedToken?: string) => Promise<string>;
}): Promise<Response> {
  if (input.session.archivedAt) return new Response("Forbidden", { status: 403 });
  const records = await listManagedVaultCredentials(input.credentials, input.workspaceId, input.session.vaultIds);
  const inboundAuth = input.request.headers.get("authorization");
  const matched = matchManagedCredential(records.map((record) => record.credential), input.request.url, basicAuthSelector(inboundAuth), /^basic /i.test(inboundAuth ?? ""));
  let record = records.find((record) => record.credential.id === matched?.id && record.credential.vaultId === matched?.vaultId);
  const serviceAccount = record?.credential.auth.type === "service_account_jwt";
  if (serviceAccount && !input.serviceAccountToken) return new Response("service_account_jwt requires self-host oma-vault; Cloudflare forwarding is not supported", { status: 501 });
  let serviceAccountToken: string | undefined;
  if (serviceAccount) {
    try { serviceAccountToken = await input.serviceAccountToken!(record!); }
    catch { return new Response("Service account token exchange failed", { status: 502 }); }
  }
  const headers = new Headers(input.request.headers);
  for (const key of ["host", "proxy-authorization", "x-oma-tenant", "x-oma-session", "x-oma-mcp-server", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]) headers.delete(key);
  const body = ["GET", "HEAD"].includes(input.request.method) ? undefined : await input.request.arrayBuffer();
  const request = input.fetch ?? fetch;
  const forward = () => {
    const authorization = serviceAccountToken ? `Bearer ${serviceAccountToken}` : record && credentialAuthorization(record.credential.auth);
    if (authorization) headers.set("authorization", authorization);
    return request(input.request.url, { method: input.request.method, headers, body, redirect: "manual" });
  };
  const first = await forward();
  if (serviceAccount) {
    if (first.status !== 401) return first;
    try { serviceAccountToken = await input.serviceAccountToken!(record!, serviceAccountToken); }
    catch { return first; }
    await first.body?.cancel().catch(() => {});
    return forward();
  }
  if ((first.status !== 401 && first.status !== 403) || record?.credential.auth.type !== "mcp_oauth" || !record.credential.auth.refresh?.refreshToken) return first;
  await first.body?.cancel();
  record = await refreshManagedCredential(input.credentials, input.workspaceId, record, request);
  return forward();
}
