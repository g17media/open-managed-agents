// Belljar create-request assembly — the environment-level custom image
// and vault-resolved registry credentials must reach POST /v1/sandboxes
// (and only the create request; the pull credential never appears on
// runtime calls).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BelljarSandbox,
  sandboxFactory,
} from "@open-managed-agents/sandbox/adapters/belljar";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch: records every call, answers create with {} and runtime
 *  execute with a successful exec result. */
function stubBelljarFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/sandboxes")) return okJson({});
    return okJson({ success: true, exitCode: 0, stdout: "hi", stderr: "" });
  });
  return calls;
}

function createBody(calls: Array<{ url: string; init?: RequestInit }>) {
  const create = calls.find((c) => c.url.endsWith("/v1/sandboxes"));
  expect(create).toBeDefined();
  return JSON.parse(String(create!.init!.body)) as Record<string, unknown>;
}

describe("BelljarSandbox create options", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image + registryAuth on the create request", async () => {
    const calls = stubBelljarFetch();
    const sb = new BelljarSandbox({
      baseUrl: "http://belljar:8877",
      token: "tok",
      sessionId: "sess-reg",
      image: "ghcr.io/acme/sandbox:1",
      registryAuth: { username: "u", password: "p", serveraddress: "ghcr.io" },
    });
    await sb.exec("echo hi");
    const body = createBody(calls);
    expect(body.image).toBe("ghcr.io/acme/sandbox:1");
    expect(body.registryAuth).toEqual({
      username: "u",
      password: "p",
      serveraddress: "ghcr.io",
    });
    // The credential rides only on the create request — runtime calls
    // must not carry it.
    for (const c of calls.filter((c) => !c.url.endsWith("/v1/sandboxes"))) {
      expect(String(c.init?.body ?? "")).not.toContain('"registryAuth"');
    }
  });

  it("omits image and registryAuth when not configured", async () => {
    const calls = stubBelljarFetch();
    const sb = new BelljarSandbox({
      baseUrl: "http://belljar:8877",
      sessionId: "sess-plain",
    });
    await sb.exec("echo hi");
    const body = createBody(calls);
    expect(body).not.toHaveProperty("image");
    expect(body).not.toHaveProperty("registryAuth");
  });

  it("factory prefers ctx.image (environment override) over SANDBOX_IMAGE", async () => {
    const calls = stubBelljarFetch();
    const sb = await sandboxFactory(
      {
        sessionId: "sess-fac",
        workdir: "/tmp/wd",
        image: "ghcr.io/acme/custom:2",
        registryAuth: { identityToken: "idt" },
      },
      { BELLJAR_URL: "http://belljar:8877", SANDBOX_IMAGE: "docker.io/cloudflare/sandbox:0.12.4" },
    );
    await sb.exec("echo hi");
    const body = createBody(calls);
    expect(body.image).toBe("ghcr.io/acme/custom:2");
    expect(body.registryAuth).toEqual({ identityToken: "idt" });
  });

  it("factory falls back to SANDBOX_IMAGE without a ctx override", async () => {
    const calls = stubBelljarFetch();
    const sb = await sandboxFactory(
      { sessionId: "sess-fb", workdir: "/tmp/wd" },
      { BELLJAR_URL: "http://belljar:8877", SANDBOX_IMAGE: "docker.io/cloudflare/sandbox:0.12.4" },
    );
    await sb.exec("echo hi");
    const body = createBody(calls);
    expect(body.image).toBe("docker.io/cloudflare/sandbox:0.12.4");
    expect(body).not.toHaveProperty("registryAuth");
  });
});
