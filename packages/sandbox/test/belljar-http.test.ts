import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { BelljarSandbox } from "../src/adapters/belljar";

// Shorten only the clocks, never fetch: exercise Node's bundled fetch with
// the adapter's real dispatcher, abort signal, body reader and recovery.
const clocks = vi.hoisted(() => ({ total: 5_000, headers: 5_000, body: 5_000 }));
vi.mock("../src/runtime-timeout", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime-timeout")>(),
  runtimeRequestTimeoutMs: () => clocks.total,
}));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, Agent: class extends actual.Agent {
    constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
      super({ ...options, headersTimeout: clocks.headers, bodyTimeout: clocks.body });
    }
  } };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  Object.assign(clocks, { total: 5_000, headers: 5_000, body: 5_000 });
});
const result = { success: true, exitCode: 0, stdout: "ok", stderr: "" };
async function fixture(execute: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => { timers.add(setTimeout(fn, ms)); };
  const server = createServer(async (request: IncomingMessage, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}");
    const path = request.url!;
    requests.push({ path, method: request.method!, body });
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/api/execute")) return execute(body, response);
    if (path.endsWith("/api/process/start")) return response.end(JSON.stringify({ processId: "background", pid: 42 }));
    if (path.endsWith("/api/process/background/logs")) return response.end(JSON.stringify({ stdout: "still alive", stderr: "" }));
    if (path.endsWith("/api/process/background")) return response.end(JSON.stringify({ process: { status: "running" } }));
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address() as { port: number };
  const adapter = new BelljarSandbox({ baseUrl: `http://127.0.0.1:${address.port}`, sessionId: "http-test", logger: { log() {}, warn() {} } });
  return { adapter, requests, later };
}

it.each(["headers", "body"])("real fetch enforces dispatcher %s timeout before the total deadline", async (phase) => {
  clocks[phase as "headers" | "body"] = 100;
  const { adapter, later } = await fixture((_body, response) => {
    if (phase === "body") response.write('{"success":');
    later(() => response.end(JSON.stringify(result)), 3_000);
  });
  const error = await adapter.exec("sleep 1", 1_000).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("MAY STILL BE RUNNING");
  const transport = (error as Error).cause as Error & { cause?: { code?: string } };
  expect(transport.cause?.code).toBe(phase === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT");
}, 10_000);

it("real fetch accepts delayed headers and body within dispatcher deadlines", async () => {
  const { adapter, requests, later } = await fixture((_body, response) => {
    later(() => {
      response.write('{"success":true,');
      later(() => response.end('"exitCode":0,"stdout":"ok","stderr":""}'), 150);
    }, 150);
  });
  await expect(adapter.exec("echo ok", 600_000)).resolves.toBe("ok");
  expect(requests.at(-1)).toMatchObject({ method: "POST", body: { timeoutMs: 600_000, cwd: "/workspace" } });
});

it.each(["headers", "body", "runtime"])("real %s timeout rotates shells, preserves env/cwd and leaves background processes alone", async (phase) => {
  clocks.total = 250;
  let stuck: unknown;
  const { adapter, requests } = await fixture((body, response) => {
    if (!stuck) {
      stuck = body.sessionId;
      if (phase === "body") response.write('{"success":');
      if (phase === "runtime") {
        response.statusCode = 500;
        response.end(JSON.stringify({ code: "COMMAND_EXECUTION_ERROR", message: "execution failed" }));
      }
      return;
    }
    if (body.sessionId === stuck) return; // Emulate the wedged session queue.
    response.end(JSON.stringify(result));
  });
  await adapter.setEnvVars({ TEST_SETTING: "configured" });
  const process = await adapter.startProcess("sleep 999");
  await expect(adapter.execResult("sleep 999", 100)).rejects.toThrow(/MAY STILL BE RUNNING/);
  await expect(adapter.exec("echo ok", 100)).resolves.toBe("ok");
  const executions = requests.filter((request) => request.path.endsWith("/api/execute"));
  expect(executions).toHaveLength(2);
  expect(executions[1]!.body.sessionId).not.toBe(stuck);
  expect(executions[1]!.body).toMatchObject({ cwd: "/workspace", env: { TEST_SETTING: "configured" }, timeoutMs: 100 });
  expect(process).not.toBeNull();
  await expect(process!.getStatus()).resolves.toBe("running");
  await expect(process!.getLogs()).resolves.toEqual({ stdout: "still alive", stderr: "" });
  expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  expect(requests.find((request) => request.path.endsWith("/api/process/start"))!.body).not.toHaveProperty("sessionId");
});
