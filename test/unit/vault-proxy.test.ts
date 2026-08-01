// Session attribution protocol for the self-host oma-vault proxy —
// packages/sandbox/src/vault-proxy.ts. The compose side runs in the
// sandbox adapters (proxy URL userinfo); the parse/verify side runs in
// apps/oma-vault against the tags mockttp surfaces per request.

import { describe, it, expect } from "vitest";
import {
  parseVaultProxyTags,
  sessionVaultProxyUrl,
  verifyVaultProxyAttribution,
} from "@open-managed-agents/sandbox/vault-proxy";

const OPTS = { tenantId: "tn_1", sessionId: "sess_1" };

/** Decode the metadata JSON the way mockttp does (base64url password with
 *  username "metadata") and re-surface tags with its `socket-metadata:`
 *  prefix, as they appear on CompletedRequest.tags. */
function mockttpTags(url: string): string[] {
  const u = new URL(url);
  expect(u.username).toBe("metadata");
  const json = JSON.parse(Buffer.from(u.password, "base64url").toString("utf8")) as {
    tags: string[];
  };
  return json.tags.map((t) => `socket-metadata:${t}`);
}

describe("vault-proxy session attribution", () => {
  it("round-trips tenant + session through the proxy URL userinfo", () => {
    const url = sessionVaultProxyUrl("http://vault:14322", OPTS, undefined);
    const attr = parseVaultProxyTags(mockttpTags(url));
    expect(attr).toEqual({ tenantId: "tn_1", sessionId: "sess_1" });
  });

  it("returns the base URL unchanged without session opts", () => {
    expect(sessionVaultProxyUrl("http://vault:14322", undefined, undefined)).toBe(
      "http://vault:14322",
    );
  });

  it("keeps the password base64url so mockttp's 'e'-prefix detection holds", () => {
    const url = sessionVaultProxyUrl("http://vault:14322", OPTS, undefined);
    expect(new URL(url).password.startsWith("ey")).toBe(true);
  });

  it("signs and verifies attribution with a shared key", () => {
    const url = sessionVaultProxyUrl("http://vault:14322", OPTS, "shh");
    const attr = parseVaultProxyTags(mockttpTags(url));
    expect(verifyVaultProxyAttribution(attr, "shh")).toBe(true);
    expect(verifyVaultProxyAttribution(attr, "other-key")).toBe(false);
    expect(verifyVaultProxyAttribution({ ...attr, sessionId: "sess_2" }, "shh")).toBe(false);
    expect(verifyVaultProxyAttribution({ ...attr, sig: undefined }, "shh")).toBe(false);
  });
});
