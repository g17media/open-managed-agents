import { afterEach, describe, expect, it, vi } from "vitest";
import { BelljarSandbox } from "../src/adapters/belljar";

afterEach(() => vi.unstubAllGlobals());

function belljar() {
  const created: Array<{ id: string; lifecycle: { ownerId: string } }> = [];
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/v1/sandboxes")) {
      const body = JSON.parse(String(init?.body));
      // Belljar's actual ID constraint; reject before provisioning a container.
      if (body.id.length > 63 || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(body.id)) {
        return Response.json({ code: "INVALID_SANDBOX_ID" }, { status: 400 });
      }
      created.push(body);
      return Response.json({ sandbox: { lifecycle: body.lifecycle } });
    }
    return Response.json({ success: true, exitCode: 0, stdout: "ok", stderr: "" });
  }));
  const adapter = (sessionId: string) => new BelljarSandbox({
    baseUrl: "http://belljar:8877", sessionId, startupManaged: true,
    logger: { log: () => {}, warn: () => {} },
  });
  return { created, requests, adapter };
}

describe("Belljar session identities", () => {
  it("supports upstream IDs and reattaches to the same sandbox after restarting OMA", async () => {
    const f = belljar();
    const sessionId = "session_MixedCase_0123";
    await expect(f.adapter(sessionId).exec("true")).resolves.toBe("ok");
    const restarted = f.adapter(sessionId);
    await restarted.exec("true");
    await restarted.retryStartup();
    await restarted.destroy();
    expect(f.created).toHaveLength(2);
    expect(f.created[1]?.id).toBe(f.created[0]?.id);
    expect(f.created.every((body) => body.lifecycle.ownerId === sessionId)).toBe(true);
    expect(f.requests.filter((url) => !url.endsWith("/v1/sandboxes")))
      .toEqual(expect.arrayContaining([
        `http://belljar:8877/v1/sandboxes/${f.created[0]!.id}/api/execute`,
        `http://belljar:8877/v1/sandboxes/${f.created[0]!.id}/initialization/retry`,
        `http://belljar:8877/v1/sandboxes/${f.created[0]!.id}`,
      ]));
  });

  it("preserves existing sandbox names so upgrades retain their workspaces", async () => {
    const f = belljar();
    await f.adapter("sess-existing_123").exec("true");
    expect(f.created[0]?.id).toBe("oma-sess-existing_123");
  });

  it("does not merge IDs that differ by case, a long suffix, or trailing punctuation", async () => {
    const f = belljar();
    for (const id of ["session_ABC", "session_abc", "session_abc_", "session_abc-",
      `${"a".repeat(40)}x`, `${"a".repeat(40)}y`]) {
      await f.adapter(id).exec("true");
    }
    expect(new Set(f.created.map((body) => body.id)).size).toBe(6);
  });
});
