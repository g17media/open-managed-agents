import { afterEach, describe, expect, it, vi } from "vitest";
import { BelljarSandbox } from "../src/adapters/belljar";

const agents = vi.hoisted(() => [] as Array<{ options: unknown; destroyed: boolean }>);
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, Agent: class extends actual.Agent {
    constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
      super(options);
      const record = { options, destroyed: false };
      agents.push(record);
      const destroy = this.destroy.bind(this);
      this.destroy = ((...args: Parameters<typeof destroy>) => {
        record.destroyed = true;
        return destroy(...args);
      }) as typeof this.destroy;
    }
  } };
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); agents.length = 0; });
const ok = () => Response.json({ success: true, exitCode: 0, stdout: "ok", stderr: "" });
function fixture(handler: (body: Record<string, unknown>, init: RequestInit) => Promise<Response> = async () => ok()) {
  const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit & { dispatcher?: unknown } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    calls.push({ url, body, init });
    return url.endsWith("/api/execute") ? handler(body, init) : ok();
  }));
  const adapter = new BelljarSandbox({ baseUrl: "http://belljar", sessionId: "test", logger: { log() {}, warn() {} } });
  return { adapter, calls };
}

describe("Belljar HTTP deadlines", () => {
  it.each([5_000, 60_000, 120_000, 600_000])("waits longer than a %i ms command, through headers and body", async (timeout) => {
    const { adapter, calls } = fixture();
    await expect(adapter.exec("echo ok", timeout)).resolves.toBe("ok");
    expect(calls.at(-1)!.body.timeoutMs).toBe(timeout);
    expect(calls.at(-1)!.init.dispatcher).toBeDefined();
    expect(calls.at(-1)!.init.signal).toBeInstanceOf(AbortSignal);
    expect(agents.at(-1)!.options).toMatchObject({ headersTimeout: timeout + 30_000, bodyTimeout: timeout + 30_000 });
    expect(agents.every((agent) => agent.destroyed)).toBe(true);
  });
  it("bounds other runtime calls and honours timeoutMs through runtimeFetch", async () => {
    const { adapter } = fixture();
    await adapter.readFile("/workspace/file");
    await adapter.writeFile("/workspace/file", "hello");
    await adapter.gitCheckout("https://example.com/repo", {});
    await adapter.startProcess("sleep 1");
    await adapter.renewActivityTimeout();
    await adapter.runtimeFetch("/api/process/id");
    expect(agents.every((agent) => JSON.stringify(agent.options).includes('"headersTimeout":120000'))).toBe(true);
    await adapter.runtimeFetch("/api/execute", { method: "POST", body: JSON.stringify({ timeoutMs: 600_000 }) });
    expect(agents.at(-1)!.options).toMatchObject({ headersTimeout: 630_000, bodyTimeout: 630_000 });
  });
  it.each(["headers", "body"])("enforces the total deadline while waiting for %s", async (phase) => {
    vi.useFakeTimers();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const { adapter } = fixture(async (_body, init) => {
      ready();
      if (phase === "headers") return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":'));
        init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      } }));
    });
    let settled = false;
    const execution = adapter.exec("sleep 999", 600_000).finally(() => { settled = true; });
    const rejection = expect(execution).rejects.toThrow(/HTTP wait expired after 630000ms.*MAY STILL BE RUNNING/);
    await started;
    await vi.advanceTimersByTimeAsync(629_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(agents.every((agent) => agent.destroyed)).toBe(true);
  });
});

describe("Belljar shell recovery", () => {
  it.each([
    ["runtime", () => Promise.resolve(Response.json({ code: "COMMAND_EXECUTION_ERROR", message: "Command timeout after 600000ms" }, { status: 500 }))],
    ["headers", () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) }))],
    ["deadline", () => Promise.reject(new DOMException("Timed out", "TimeoutError"))],
    ["body", () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("Timed out", "TimeoutError")); } })))],
  ] as const)("escapes a wedged session after a %s timeout without replaying the command", async (_kind, fail) => {
    let stuck: unknown;
    const { adapter, calls } = fixture(async (body) => {
      if (body.command === "(\nsleep 999\n)") { stuck = body.sessionId; return fail(); }
      if (body.sessionId === stuck) throw new Error("queued behind stuck command");
      return ok();
    });
    await expect(adapter.exec("sleep 999", 600_000)).rejects.toThrow(/MAY STILL BE RUNNING/);
    await expect(adapter.exec("echo ok")).resolves.toBe("ok");
    const executions = calls.filter((call) => call.url.endsWith("/api/execute"));
    expect(executions).toHaveLength(2);
    expect(executions[0]!.body.sessionId).toEqual(expect.any(String));
    expect(executions[1]!.body.sessionId).not.toBe(stuck);
    expect(executions[1]!.body).toMatchObject({ cwd: "/workspace", timeoutMs: 120_000 });
    expect(agents.every((agent) => agent.destroyed)).toBe(true);
  });
  it("keeps a healthy session for normal nonzero exits", async () => {
    const { adapter, calls } = fixture(async () => Response.json({ success: false, exitCode: 1, stdout: "", stderr: "failed" }));
    await adapter.exec("false");
    await adapter.exec("false");
    const executions = calls.filter((call) => call.url.endsWith("/api/execute"));
    expect(executions[0]!.body.sessionId).toBe(executions[1]!.body.sessionId);
  });
  it("restores configured env after recovery and avoids old shells after reattachment", async () => {
    let attempt = 0;
    const { adapter, calls } = fixture(async () => ++attempt === 1
      ? Response.json({ code: "COMMAND_EXECUTION_ERROR" }, { status: 500 }) : ok());
    await adapter.setEnvVars({ TEST_SETTING: "value" });
    await expect(adapter.exec("sleep 999")).rejects.toThrow(/fresh shell/);
    await adapter.exec("echo ok");
    const reattached = new BelljarSandbox({ baseUrl: "http://belljar", sessionId: "test", logger: { log() {}, warn() {} } });
    await reattached.exec("echo ok");
    const executions = calls.filter((call) => call.url.endsWith("/api/execute"));
    expect(executions[1]!.body.env).toEqual({ TEST_SETTING: "value" });
    expect(new Set(executions.map((call) => call.body.sessionId)).size).toBe(3);
  });
  it("does not rotate a healthy replacement shell when an old concurrent exec fails late", async () => {
    const pending: Array<(response: Response) => void> = [];
    const { adapter, calls } = fixture(async (body) => body.command === "(\nsleep 999\n)"
      ? new Promise<Response>((resolve) => pending.push(resolve)) : ok());
    const first = expect(adapter.exec("sleep 999")).rejects.toThrow(/fresh shell/);
    const second = expect(adapter.exec("sleep 999")).rejects.toThrow(/fresh shell/);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const failure = () => Response.json({ code: "COMMAND_EXECUTION_ERROR", message: "Command timeout" }, { status: 500 });
    pending[0]!(failure());
    await first;
    await adapter.exec("echo ok");
    pending[1]!(failure());
    await second;
    await adapter.exec("echo ok");
    const executions = calls.filter((call) => call.url.endsWith("/api/execute"));
    expect(executions[0]!.body.sessionId).toBe(executions[1]!.body.sessionId);
    expect(executions[2]!.body.sessionId).not.toBe(executions[0]!.body.sessionId);
    expect(executions[3]!.body.sessionId).toBe(executions[2]!.body.sessionId);
  });
});
