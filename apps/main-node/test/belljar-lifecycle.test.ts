import { afterEach, describe, expect, it, vi } from "vitest";
import { BelljarSandbox } from "@open-managed-agents/sandbox/adapters/belljar";
import { runStartupScript } from "@open-managed-agents/sandbox/startup";
import type { EnvironmentConfig, SandboxStartupEvent } from "@open-managed-agents/shared";
import { buildBelljarLifecycleRoutes, type BelljarLifecyclePayload } from "../src/lib/belljar-lifecycle";
import { validateEnvironmentLimits } from "../../../packages/http-routes/src/lib/limits";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const payload: BelljarLifecyclePayload = {
  ownerId: "sess_test", sandboxId: "oma-sess_test", bootId: "a".repeat(64),
  event: "create", initializationToken: "b".repeat(64),
};

function fixture() {
  const events: SandboxStartupEvent[] = [];
  const sandbox = {
    execResult: vi.fn(async () => ({ exitCode: 0, stdout: "configured", stderr: "" })),
    setEnvVars: vi.fn(async () => {}),
    writeFile: vi.fn(async () => "ok"),
  } as unknown as BelljarSandbox;
  const prepare = vi.fn(async () => {});
  const session: { id: string; tenant_id: string; status: string; environment_snapshot: EnvironmentConfig } = {
    id: payload.ownerId, tenant_id: "tenant_1", status: "idle", environment_snapshot: {
    id: "env_1", name: "test", created_at: "2026-09-07", config: { type: "cloud", startup: { script: "echo configured" } },
  } };
  const deps = {
    token: "callback-secret",
    getSession: vi.fn(async () => session),
    completed: vi.fn(async (_id: string, boot: string) => events.some((e) => e.boot_id === boot && ["succeeded", "skipped"].includes(e.status))),
    emit: vi.fn(async (_id: string, e: SandboxStartupEvent) => { events.push(e); }),
    buildSandbox: vi.fn(() => sandbox), prepare,
  };
  const app = buildBelljarLifecycleRoutes(deps);
  const send = (body = payload, token = "callback-secret") => app.request("/", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { deps, app, send, events, sandbox, prepare, session };
}

describe("OMA-managed startup", () => {
  it("prepares resources before execution and pins the script to the session snapshot", async () => {
    const f = fixture();
    const order: string[] = [];
    f.prepare.mockImplementation(async () => { order.push("prepare"); });
    vi.mocked(f.sandbox.execResult!).mockImplementation(async (command) => {
      order.push(command.startsWith("/bin/bash") ? "script" : "mkdir");
      return { exitCode: 0, stdout: "configured", stderr: "" };
    });
    expect((await f.send()).status).toBe(200);
    expect(order).toEqual(["prepare", "mkdir", "script"]);
    expect(f.sandbox.writeFile).toHaveBeenCalledWith(expect.any(String), "echo configured");
    expect(f.sandbox.setEnvVars).toHaveBeenCalledWith({ OMA_LIFECYCLE_EVENT: "create", OMA_BOOT_ID: payload.bootId });
    expect(f.events.map((e) => e.status)).toEqual(["running", "succeeded"]);
  });

  it("deduplicates concurrent callbacks and acknowledges completed boots after a service restart", async () => {
    const f = fixture();
    const responses = await Promise.all([f.send(), f.send()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    const restarted = buildBelljarLifecycleRoutes(f.deps);
    const response = await restarted.request("/", { method: "POST", headers: { authorization: "Bearer callback-secret" }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("blocks on a nonzero exit, records output and permits a later retry", async () => {
    const f = fixture();
    vi.mocked(f.sandbox.execResult!).mockImplementation(async (command) => ({
      exitCode: command.startsWith("/bin/bash") ? 7 : 0, stdout: "step one", stderr: "dependency unavailable",
    }));
    expect((await f.send()).status).toBe(503);
    expect(f.events.at(-1)).toMatchObject({ status: "failed", exit_code: 7, stdout: "step one", stderr: "dependency unavailable" });
    vi.mocked(f.sandbox.execResult!).mockResolvedValue({ exitCode: 0, stdout: "fixed", stderr: "" });
    expect((await f.send()).status).toBe(200);
    expect(f.events.at(-1)?.status).toBe("succeeded");
  });

  it("prepares the workspace but skips unchecked triggers", async () => {
    const f = fixture();
    f.session.environment_snapshot.config.startup = { script: "echo configured", triggers: ["wake"] };
    expect((await f.send()).status).toBe(200);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.sandbox.execResult).not.toHaveBeenCalled();
    expect(f.events.map((e) => e.status)).toEqual(["skipped"]);
    expect((await f.send({ ...payload, event: "wake", bootId: "c".repeat(64) })).status).toBe(200);
    expect(f.events.at(-1)?.status).toBe("succeeded");
  });

  it("requires callback auth and validates the sandbox/session binding", async () => {
    const f = fixture();
    expect((await f.send(payload, "wrong")).status).toBe(401);
    expect((await f.send({ ...payload, sandboxId: "another-sandbox" })).status).toBe(400);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("uses a scoped initialization adapter with the same proxy/CA command environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-startup-ca-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "ca.crt"), "public test certificate");
    vi.stubEnv("OMA_VAULT_PROXY_URL", "http://oma-vault:14322");
    vi.stubEnv("OMA_VAULT_CA_CERT", join(dir, "ca.crt"));
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return Response.json({ exitCode: 0, stdout: "", stderr: "" });
    }));
    const sandbox = new BelljarSandbox({ baseUrl: "http://belljar:8877", token: "control-secret", sessionId: payload.ownerId,
      initialization: { bootId: payload.bootId, token: payload.initializationToken } });
    await runStartupScript({ sandbox, config: { script: "curl https://example.com", timeout_seconds: 23 }, bootId: payload.bootId,
      trigger: "revive", prepare: () => sandbox.prepareInitialization({ tenantId: "tenant_1", sessionId: payload.ownerId }), emit: async () => {} });
    expect(requests.every((r) => !r.url.endsWith("/v1/sandboxes"))).toBe(true);
    expect(requests.every((r) => r.headers.get("x-belljar-initialization") === payload.initializationToken)).toBe(true);
    expect(requests[0].url).toContain("/api/write");
    const command = requests.at(-1)!.body;
    expect(command.timeoutMs).toBe(23000);
    expect(command.env).toMatchObject({ HTTPS_PROXY: expect.stringContaining("oma-vault:14322"), HTTP_PROXY: expect.any(String),
      NODE_EXTRA_CA_CERTS: "/workspace/.oma-vault-ca.crt", OMA_LIFECYCLE_EVENT: "revive" });
  });
});

describe("startup configuration validation", () => {
  it.each([
    null, { script: 1 }, { script: "\u0000" }, { script: "x".repeat(65537) },
    { script: "echo ok", triggers: ["boot"] }, { script: "echo ok", triggers: ["wake", "wake"] },
    { script: "echo ok", timeout_seconds: 0 }, { script: "echo ok", timeout_seconds: 601 }, { script: "echo ok", timeout_seconds: 1.5 },
    { script: "", enabled: true }, { script: "echo ok", enabled: "yes" },
  ])("rejects invalid startup config %#", (startup) => {
    expect(validateEnvironmentLimits({ config: { startup } }).ok).toBe(false);
  });
  it("accepts a disabled draft and independent lifecycle selections", () => {
    expect(validateEnvironmentLimits({ config: { startup: { script: "", enabled: false } } }).ok).toBe(true);
    expect(validateEnvironmentLimits({ config: { startup: { script: "echo ok", triggers: ["wake", "revive"], timeout_seconds: 600 } } }).ok).toBe(true);
  });
});
