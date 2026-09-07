/** Real Docker + Belljar + OMA startup handshake. Creates only a uniquely scoped test sandbox.
 * BELLJAR_SOURCE_DIR=/path/to/belljar pnpm --filter @open-managed-agents/main-node exec tsx test/belljar-startup.smoke.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { BelljarSandbox } from "@open-managed-agents/sandbox/adapters/belljar";
import type { SandboxStartupEvent } from "@open-managed-agents/shared";
import { buildBelljarLifecycleRoutes } from "../src/lib/belljar-lifecycle";

const source = process.argv[2] ?? process.env.BELLJAR_SOURCE_DIR;
if (!source) throw new Error("Set BELLJAR_SOURCE_DIR to the Belljar checkout to test");
const moduleAt = (name: string) => import(pathToFileURL(resolve(source, "src", name)).href);
const [{ loadConfig }, { createServer }, { DockerEngine }, socket, { tarball }] = await Promise.all([
  moduleAt("config.ts"), moduleAt("server.ts"), moduleAt("docker/engine.ts"), moduleAt("docker/socket.ts"), moduleAt("docker/tar.ts"),
]);
const suffix = randomBytes(5).toString("hex");
const sessionId = `startup_${suffix}`;
const sandboxId = `oma-${sessionId}`;
const token = randomBytes(24).toString("hex");
const directory = await mkdtemp(join(tmpdir(), "oma-startup-smoke-"));
const events: SandboxStartupEvent[] = [];
let baseUrl = "";
const oldProxy = process.env.OMA_VAULT_PROXY_URL;
const oldCert = process.env.OMA_VAULT_CA_CERT;
process.env.OMA_VAULT_PROXY_URL = "http://test-proxy.invalid:14322";
process.env.OMA_VAULT_CA_CERT = join(directory, "ca.crt");
await writeFile(process.env.OMA_VAULT_CA_CERT, "public test certificate\n");

const script = `test -n "$HTTP_PROXY"
test "$HTTP_PROXY" = "$HTTPS_PROXY"
test -f "$NODE_EXTRA_CA_CERTS"
if [ "$OMA_LIFECYCLE_EVENT" = wake ] && [ ! -f /workspace/allow-wake ]; then
  echo "simulated startup failure" >&2
  exit 9
fi
printf '%s|%s\\n' "$OMA_LIFECYCLE_EVENT" "$OMA_BOOT_ID" >> /workspace/startup-events
echo "startup completed: $OMA_LIFECYCLE_EVENT"
`;
const callback = buildBelljarLifecycleRoutes({
  token,
  getSession: async () => ({ id: sessionId, tenant_id: "smoke", status: "idle", environment_snapshot: {
    id: "smoke", name: "smoke", created_at: new Date().toISOString(), config: { type: "cloud", startup: { script, timeout_seconds: 30 } },
  } }),
  completed: async (_sid, boot) => events.some((e) => e.boot_id === boot && ["succeeded", "skipped"].includes(e.status)),
  emit: async (_sid, event) => { events.push(event); console.log(JSON.stringify({ trigger: event.trigger, status: event.status, duration_ms: event.duration_ms, exit_code: event.exit_code })); },
  buildSandbox: (payload) => new BelljarSandbox({ baseUrl, token, sessionId,
    initialization: { bootId: payload.bootId, token: payload.initializationToken } }),
  prepare: async (_session, sandbox) => sandbox.prepareInitialization({ tenantId: "smoke", sessionId }),
});
const callbackServer = serve({ fetch: callback.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => { if (callbackServer.listening) resolve(); else callbackServer.once("listening", resolve); });
const callbackPort = (callbackServer.address() as { port: number }).port;
const config = loadConfig({ ...process.env, BELLJAR_TOKEN: token, BELLJAR_SCOPE: `oma-startup-${suffix}`,
  BELLJAR_LIFECYCLE_URL: `http://127.0.0.1:${callbackPort}/`, BELLJAR_PULL_POLICY: "missing",
  BELLJAR_SLEEP_AFTER: "0", BELLJAR_DESTROY_AFTER: "1h", BELLJAR_ISOLATION: "optional",
  BELLJAR_IMAGE: process.env.BELLJAR_SMOKE_IMAGE ?? "docker.io/cloudflare/sandbox:0.12.4",
});
const endpoint = socket.resolveEngineEndpoint(process.env.BELLJAR_DOCKER_SOCKET);
const engine = new DockerEngine(endpoint);
let belljar = createServer(config, engine);
async function listen(port = 0) {
  await new Promise<void>((resolve) => belljar.server.listen(port, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${belljar.server.address().port}`;
}
await listen();
const request = (path: string, method = "GET") => fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${token}` } });
try {
  let adapter = new BelljarSandbox({ baseUrl, token, sessionId, startupManaged: true });
  await adapter.setOutboundContext({ tenantId: "smoke", sessionId });
  const initial = await adapter.execResult("cat /workspace/startup-events");
  assert.equal(initial.exitCode, 0);
  assert.match(initial.stdout, /^create\|/);
  const info = (await (await request(`/v1/sandboxes/${sandboxId}`)).json()).sandbox;

  // A direct preview request, without an OMA tool call, must run the wake hook.
  assert.equal((await request(`/v1/sandboxes/${sandboxId}/stop`, "POST")).status, 204);
  const preview = await request(`/v1/sandboxes/${sandboxId}/ports/3000/api/ping`);
  assert.equal(preview.status, 503);
  assert.equal(events.at(-1)?.exit_code, 9);
  const failedCount = events.length;
  assert.equal((await request(`/v1/sandboxes/${sandboxId}/api/ping`)).status, 503);
  assert.equal(events.length, failedCount);

  // Simulate repairing an external prerequisite; the saved script stays unchanged.
  await engine.putArchive(info.containerId, "/workspace", tarball([{ path: "allow-wake", content: "yes" }]));
  await adapter.retryStartup();
  const afterWake = await adapter.execResult("cat /workspace/startup-events");
  assert.deepEqual(afterWake.stdout.trim().split("\n").map((line) => line.split("|")[0]), ["create", "wake"]);
  assert.equal((await request(`/v1/sandboxes/${sandboxId}/ports/3000/api/ping`)).status, 200);

  const beforeRestart = events.length;
  belljar.server.closeAllConnections();
  await new Promise<void>((resolve) => belljar.server.close(() => resolve()));
  belljar = createServer(config, engine);
  // Use a fresh listener/adapter so a deliberately closed pooled HTTP socket
  // cannot turn the persistence assertion into a transport-retry test.
  await listen();
  adapter = new BelljarSandbox({ baseUrl, token, sessionId, startupManaged: true });
  await adapter.setOutboundContext({ tenantId: "smoke", sessionId });
  await adapter.execResult("true");
  assert.equal(events.length, beforeRestart, "Belljar restart must preserve readiness");

  belljar.manager.lastActivity.set(sandboxId, Date.now() - 4_000_000);
  await belljar.manager.destroySandbox(sandboxId);
  const afterRevive = await adapter.execResult("cat /workspace/startup-events");
  assert.deepEqual(afterRevive.stdout.trim().split("\n").map((line) => line.split("|")[0]), ["create", "wake", "revive"]);
  console.log("PASS: real container create, preview-triggered wake, failure gate, retry, Belljar restart, and retained-workspace revival");
} finally {
  await belljar.manager.delete(sandboxId);
  belljar.server.closeAllConnections();
  callbackServer.closeAllConnections();
  await Promise.all([new Promise<void>((resolve) => belljar.server.close(() => resolve())),
    new Promise<void>((resolve) => callbackServer.close(() => resolve()))]);
  await engine.close();
  await rm(directory, { recursive: true, force: true });
  if (oldProxy === undefined) delete process.env.OMA_VAULT_PROXY_URL; else process.env.OMA_VAULT_PROXY_URL = oldProxy;
  if (oldCert === undefined) delete process.env.OMA_VAULT_CA_CERT; else process.env.OMA_VAULT_CA_CERT = oldCert;
}
