import { describe, expect, it, vi } from "vitest";
import type { Credential } from "@open-managed-agents/domain/credentials";
import { buildAuthHeader, refreshMetadataOf } from "../src/index";
import { matchManagedCredential, forwardManagedOutboundRequest, forwardManagedMcpRequest } from "../src/managed";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import type { Session } from "@open-managed-agents/domain/sessions";

const basic: Credential = { id: "basic", vaultId: "vault", archivedAt: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z", metadata: {}, auth: { type: "static_basic", username: "public", token: "password", mcpServerUrl: "https://example.test" } };
const bearer: Credential = { ...basic, id: "bearer", auth: { type: "static_bearer", token: "pat", mcpServerUrl: "https://example.test" } };
const handled: Credential = { ...bearer, id: "handled", auth: { ...bearer.auth, handle: "brain" } };

describe("static Basic vault forwarding", () => {
  it("builds Basic auth and never supplies refresh metadata", () => {
    const auth = { type: "static_basic" as const, username: "public", token: "password" };
    expect(buildAuthHeader(auth)).toEqual({ name: "authorization", value: "Basic cHVibGljOnBhc3N3b3Jk" });
    expect(refreshMetadataOf(auth)).toBeNull();
    expect(buildAuthHeader({ type: "static_basic", username: "ü", token: "pä:ss " })).toEqual({ name: "authorization", value: "Basic w7w6cMOkOnNzIA==" });
    expect(buildAuthHeader({ ...auth, token: undefined })).toBeNull();
  });
  it("matches exact hosts, including ports, and ignores archived credentials", () => {
    expect(matchManagedCredential([basic], "https://example.test/api/public/traces")?.id).toBe("basic");
    expect(matchManagedCredential([basic], "https://example.test.evil.test")).toBeNull();
    expect(matchManagedCredential([basic], "https://example.test:8443")).toBeNull();
    expect(matchManagedCredential([{ ...basic, archivedAt: basic.createdAt }], "https://example.test")).toBeNull();
  });
  it.each([basic, bearer, { ...bearer, auth: { type: "cap_cli" as const, cliId: "git", token: "pat", mcpServerUrl: "https://example.test" } }])("does not match an HTTPS credential to plaintext requests ($auth.type)", (credential) => {
    expect(matchManagedCredential([credential], "http://example.test/path")).toBeNull();
    const internal = { ...credential, auth: { ...credential.auth, mcpServerUrl: "http://example.test" } };
    expect(matchManagedCredential([internal], "http://example.test/path")?.id).toBe(credential.id);
    expect(matchManagedCredential([credential], "https://example.test/path")?.id).toBe(credential.id);
  });
  it.each([
    ["brain", true, "handled"], ["placeholder", true, "basic"],
    [undefined, true, "basic"], [undefined, false, "bearer"],
  ] as const)("selects %s with Basic=%s", (selector, incomingBasic, expected) => {
    for (const credentials of [[handled, bearer, basic], [basic, bearer, handled]]) {
      expect(matchManagedCredential(credentials, "https://example.test/path", selector, incomingBasic)?.id).toBe(expected);
    }
  });
  it.each(["outbound", "mcp"] as const)("replaces placeholder Basic and returns 401 without refresh or retry (%s)", async (mode) => {
    const credentials = new MemoryCredentialStore();
    await credentials.insert({ workspaceId: "workspace", credential: basic });
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic cHVibGljOnBhc3N3b3Jk");
      return new Response("rejected", { status: 401 });
    });
    const input = { request: new Request("https://example.test/api/public/otel/v1/traces", { headers: { authorization: "Basic cGxhY2Vob2xkZXI6cGxhY2Vob2xkZXI=" } }), workspaceId: "workspace", session: { archivedAt: null, vaultIds: ["vault"], agent: { mcpServers: [{ name: "basic", type: "url", url: "https://example.test" }] } } as Session, credentials, fetch: upstream };
    const response = mode === "outbound" ? await forwardManagedOutboundRequest(input) : await forwardManagedMcpRequest({ ...input, serverName: "basic" });
    expect(response.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

it("forwards Basic through the shared Node transport without retrying even if refresh metadata is supplied", async () => {
  const { forwardWithRefresh } = await import("../src/index");
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Basic cHVibGljOnBhc3N3b3Jk");
    return new Response("rejected", { status: 401 });
  });
  const response = await forwardWithRefresh({ upstreamUrl: "https://example.test", method: "GET", inboundHeaders: new Headers({ authorization: "Basic placeholder" }), body: null, accessToken: "password", basicUsername: "public", refresh: { refreshToken: "not-used", tokenEndpoint: "https://example.test/token" }, fetcher: upstream });
  expect(response.status).toBe(401);
  expect(upstream).toHaveBeenCalledTimes(1);
});
