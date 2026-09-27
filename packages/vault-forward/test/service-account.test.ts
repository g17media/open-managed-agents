import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { createServiceAccountAssertion, getServiceAccountToken, mintServiceAccountToken, type ServiceAccountAuth } from "../src/service-account";
import { forwardManagedOutboundRequest, forwardManagedMcpRequest, matchManagedCredential } from "../src/managed";
import { forwardWithRefresh } from "../src/index";
import type { Session } from "@open-managed-agents/domain/sessions";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const auth: ServiceAccountAuth & { mcpServerUrl: string } = { type: "service_account_jwt", clientEmail: "bot@example.test", privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), tokenUri: "https://token.test/token", scopes: "drive docs", mcpServerUrl: "https://example.test/api" };
function assertion(jwt: string) {
  const [header, claims, signature] = jwt.split(".");
  expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), pair.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  return { header: JSON.parse(Buffer.from(header!, "base64url").toString()), claims: JSON.parse(Buffer.from(claims!, "base64url").toString()) };
}
async function setup() {
  const store = new MemoryCredentialStore();
  const record = await store.insert({ workspaceId: "workspace", credential: { id: "sa", vaultId: "vault", auth, metadata: {}, archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
  return { store, record };
}
function endpoint() {
  let count = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    assertion(body.get("assertion")!);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ access_token: `minted-${++count}`, expires_in: 3600 });
  });
}
describe("service account JWT bearer", () => {
  it("signs RS256 assertions with exact claims and omits unconfigured optional claims", () => {
    const decoded = assertion(createServiceAccountAssertion(auth, 1_000_000));
    expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decoded.claims).toEqual({ iss: auth.clientEmail, scope: "drive docs", aud: auth.tokenUri, iat: 1000, exp: 4600 });
    const configured = assertion(createServiceAccountAssertion({ ...auth, subject: "delegate@example.test", privateKeyId: "key-id", audience: "audience" }));
    expect(configured.header.kid).toBe("key-id");
    expect(configured.claims.sub).toBe("delegate@example.test");
    expect(configured.claims.aud).toBe("audience");
  });
  it("uses one mint for concurrent requests and persists/reuses encrypted-store token state", async () => {
    const { store, record } = await setup(); const request = endpoint();
    expect(await Promise.all(Array.from({ length: 12 }, () => getServiceAccountToken(store, "workspace", record, { fetch: request })))).toEqual(Array(12).fill("minted-1"));
    expect(request).toHaveBeenCalledTimes(1);
    const saved = await store.find({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa" });
    expect(saved?.credential.auth).toMatchObject({ accessToken: "minted-1" });
    const otherProcess = new MemoryCredentialStore();
    const copy = await otherProcess.insert({ workspaceId: "workspace", credential: saved!.credential });
    expect(await getServiceAccountToken(otherProcess, "workspace", copy, { fetch: request })).toBe("minted-1");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("renews within five minutes of expiry and single-flights concurrent 401s", async () => {
    const { store, record } = await setup(); const request = endpoint();
    expect(await getServiceAccountToken(store, "workspace", record, { fetch: request })).toBe("minted-1");
    expect(await Promise.all(Array.from({ length: 8 }, () => getServiceAccountToken(store, "workspace", record, { fetch: request, rejectedToken: "minted-1" })))).toEqual(Array(8).fill("minted-2"));
    expect(request).toHaveBeenCalledTimes(2);
    expect(await getServiceAccountToken(store, "workspace", record, { fetch: request, rejectedToken: "minted-1" })).toBe("minted-2");
    const saved = (await store.find({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa" }))!;
    await store.replace({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa", expectedRevision: saved.revision, next: { ...saved.credential, auth: { ...auth, accessToken: "minted-2", expiresAt: new Date(Date.now() + 299_000).toISOString() } } });
    expect(await getServiceAccountToken(store, "workspace", record, { fetch: request })).toBe("minted-3");
  });
  it("never revives a deleted credential or overwrites a concurrent operator edit", async () => {
    const { store, record } = await setup();
    const request = vi.fn<typeof fetch>(async () => {
      await store.replace({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa", expectedRevision: record.revision, next: { ...record.credential, auth: { ...auth, scopes: "new-scope" } } });
      return Response.json({ access_token: "stale-scope-token", expires_in: 3600 });
    });
    await expect(getServiceAccountToken(store, "workspace", record, { fetch: request })).rejects.toThrow("changed during token exchange");
    await store.delete({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa" });
    await expect(getServiceAccountToken(store, "workspace", record, { fetch: request })).rejects.toThrow("no longer available");
  });
  it.each(["http://token.test/token", "https://user:password@token.test/token"])("rejects unsafe token endpoint %s without fetching", async (tokenUri) => {
    const request = endpoint();
    await expect(mintServiceAccountToken({ ...auth, tokenUri }, request)).rejects.toThrow("Service account token exchange failed");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{}, { access_token: "secret", expires_in: -1 }, { access_token: "secret", expires_in: "3600" }, { access_token: "bad\r\ntoken", expires_in: 3600 }])("sanitizes invalid token replies", async (body) => {
    await expect(mintServiceAccountToken(auth, async () => Response.json(body))).rejects.toThrow("Service account token exchange failed");
  });
  it("aborts a hanging token exchange at the bound and releases single-flight for retry", async () => {
    const { store, record } = await setup();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let aborted = 0;
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) { reject(new Error("Expected bounded exchange")); return; }
        const onAbort = () => { aborted++; reject(signal.reason); };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }))
      .mockResolvedValueOnce(Response.json({ access_token: "recovered", expires_in: 3600 }));
    try {
      const outcomes = await Promise.allSettled([
        getServiceAccountToken(store, "workspace", record, { fetch: request }),
        getServiceAccountToken(store, "workspace", record, { fetch: request }),
      ]);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(aborted).toBe(1);
      expect(request).toHaveBeenCalledTimes(1);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason.message).toBe("Service account token exchange failed");
      }
      expect(await getServiceAccountToken(store, "workspace", record, { fetch: request })).toBe("recovered");
      expect(request).toHaveBeenCalledTimes(2);
      expect(await getServiceAccountToken(store, "workspace", record, { fetch: request })).toBe("recovered");
      expect(request).toHaveBeenCalledTimes(2);
    } finally { timeout.mockRestore(); }
  }, 15_000);
  it("sanitizes signing and transport failures", async () => {
    expect(() => createServiceAccountAssertion({ ...auth, privateKey: "SECRET INVALID PEM" })).toThrow("Invalid service account signing configuration");
    await expect(mintServiceAccountToken(auth, async () => { throw new Error("secret echoed by server"); })).rejects.toThrow(/^Service account token exchange failed$/);
  });
  it("retries an upstream 401 once and preserves its response on mint failure", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("denied", { status: 401 }));
    const refresh = vi.fn(async () => "fresh");
    const opts = { upstreamUrl: auth.mcpServerUrl, method: "POST", inboundHeaders: new Headers(), body: "payload", accessToken: "old", fetcher: transport, refreshAccessToken: refresh };
    expect((await forwardWithRefresh(opts)).status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRejectedValueOnce(new Error("failed"));
    const failed = await forwardWithRefresh(opts);
    expect(await failed.text()).toBe("denied"); expect(transport).toHaveBeenCalledTimes(3);
  });
  it("ranks alongside ordinary bearers, with first match winning ties and exact handles first", async () => {
    const { record } = await setup(); const sa = record.credential;
    const bearer = { ...sa, id: "bearer", auth: { type: "static_bearer" as const, mcpServerUrl: auth.mcpServerUrl, token: "static" } };
    expect(matchManagedCredential([sa, bearer], auth.mcpServerUrl)?.id).toBe("sa");
    expect(matchManagedCredential([bearer, sa], auth.mcpServerUrl)?.id).toBe("bearer");
    expect(matchManagedCredential([sa, { ...bearer, auth: { ...bearer.auth, handle: "chosen" } }], auth.mcpServerUrl, "chosen")?.id).toBe("bearer");
  });
  it("supports shared Node forwarding through an explicit token provider and never loops", async () => {
    const { store, record } = await setup();
    const session = { archivedAt: null, vaultIds: ["vault"], agent: { mcpServers: [{ type: "url", name: "mcp", url: auth.mcpServerUrl }] } } as Session;
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${upstream.mock.calls.length % 2 ? "first" : "second"}`);
      return new Response("denied", { status: 401 });
    });
    const mint = vi.fn(async (_record: typeof record, rejectedToken?: string) => rejectedToken ? "second" : "first");
    const input = { workspaceId: "workspace", session, credentials: store, fetch: upstream, serviceAccountToken: mint, request: new Request(auth.mcpServerUrl) };
    expect((await forwardManagedOutboundRequest(input)).status).toBe(401);
    expect((await forwardManagedMcpRequest({ ...input, serverName: "mcp" })).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(4); expect(mint).toHaveBeenCalledTimes(4);
    expect(mint.mock.calls[1]?.[1]).toBe("first");
  });
  it("refuses a stale host match after an operator edit", async () => {
    const { store, record } = await setup(); const request = endpoint();
    await store.replace({ workspaceId: "workspace", vaultId: "vault", credentialId: "sa", expectedRevision: record.revision,
      next: { ...record.credential, auth: { ...auth, mcpServerUrl: "https://other.test" } } });
    await expect(getServiceAccountToken(store, "workspace", record, { fetch: request })).rejects.toThrow("changed during request resolution");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects unsupported Cloudflare forwarding before network access, even without cached tokens", async () => {
    const { store } = await setup(); const upstream = vi.fn<typeof fetch>();
    const session = { archivedAt: null, vaultIds: ["vault"], agent: { mcpServers: [{ type: "url", name: "mcp", url: auth.mcpServerUrl }] } } as Session;
    const input = { workspaceId: "workspace", session, credentials: store, fetch: upstream, request: new Request(auth.mcpServerUrl) };
    expect((await forwardManagedOutboundRequest(input)).status).toBe(501);
    expect((await forwardManagedMcpRequest({ ...input, serverName: "mcp" })).status).toBe(501);
    expect(upstream).not.toHaveBeenCalled();
  });
});
