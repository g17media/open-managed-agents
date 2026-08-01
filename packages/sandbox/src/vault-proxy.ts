// Session attribution for the oma-vault outbound proxy (apps/oma-vault).
//
// mockttp supports "socket metadata via proxy auth": when a client connects
// with proxy credentials `metadata:<base64url JSON>`, the proxy captures the
// JSON off the CONNECT request's Proxy-Authorization header and surfaces
// `metadata.tags` on every intercepted request as `socket-metadata:<tag>`
// entries in `request.tags`. Standard clients (curl, git, undici fetch,
// python requests, package managers) all forward userinfo from the
// HTTP(S)_PROXY URL, so tagging the proxy URL at sandbox provision time is
// enough to attribute traffic to its session — no cooperation needed from
// the processes running inside the sandbox.
//
// Tags ride in-band from inside the sandbox, so on their own they are
// forgeable — a sandbox could claim another session's id. When
// OMA_VAULT_PROXY_KEY is set (same value for the main-node and oma-vault
// processes) the URL additionally carries an HMAC over tenant+session that
// oma-vault verifies, making the attribution unforgeable without the key.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VaultProxyAttribution {
  tenantId?: string;
  sessionId?: string;
  sig?: string;
}

export function signVaultProxyAttribution(
  tenantId: string,
  sessionId: string,
  key: string,
): string {
  return createHmac("sha256", key).update(`${tenantId}\n${sessionId}`).digest("hex");
}

/**
 * Tag a proxy base URL with session attribution. Returns the base URL
 * unchanged when there is nothing to attribute (no opts) or it doesn't
 * parse. The HMAC tag is added only when a key is configured.
 */
export function sessionVaultProxyUrl(
  baseUrl: string,
  opts?: { tenantId: string; sessionId: string },
  key: string | undefined = process.env.OMA_VAULT_PROXY_KEY,
): string {
  if (!opts?.sessionId) return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const tags = [`oma-tenant:${opts.tenantId}`, `oma-session:${opts.sessionId}`];
  if (key) {
    tags.push(`oma-sig:${signVaultProxyAttribution(opts.tenantId, opts.sessionId, key)}`);
  }
  url.username = "metadata";
  // base64url of JSON starts with "ey" — mockttp's metadata decoder keys
  // base64 detection off that leading 'e'.
  url.password = Buffer.from(JSON.stringify({ tags }), "utf8").toString("base64url");
  return url.toString();
}

/** Recover the attribution from mockttp request tags (each prefixed
 *  `socket-metadata:` by mockttp; bare tags are accepted too). */
export function parseVaultProxyTags(tags: string[]): VaultProxyAttribution {
  const out: VaultProxyAttribution = {};
  for (const raw of tags) {
    const tag = raw.startsWith("socket-metadata:")
      ? raw.slice("socket-metadata:".length)
      : raw;
    if (tag.startsWith("oma-tenant:")) out.tenantId = tag.slice("oma-tenant:".length);
    else if (tag.startsWith("oma-session:")) out.sessionId = tag.slice("oma-session:".length);
    else if (tag.startsWith("oma-sig:")) out.sig = tag.slice("oma-sig:".length);
  }
  return out;
}

export function verifyVaultProxyAttribution(
  attr: VaultProxyAttribution,
  key: string,
): boolean {
  if (!attr.tenantId || !attr.sessionId || !attr.sig) return false;
  const expected = Buffer.from(
    signVaultProxyAttribution(attr.tenantId, attr.sessionId, key),
    "utf8",
  );
  const actual = Buffer.from(attr.sig, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
