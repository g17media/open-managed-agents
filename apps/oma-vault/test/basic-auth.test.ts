import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { CredentialsApplicationService } from "../../../packages/managed-agents-application/src/index";
import { buildCredentialRoutes } from "../../../packages/managed-agents-api/src/routes/credentials";
import { sessionVaultProxyUrl } from "@open-managed-agents/sandbox/vault-proxy";

// Dummy credentials only. The upstream returns status, never credential values.
const authorization = "Basic cHVibGljOnBhc3N3b3Jk";
const placeholder = "Basic cGxhY2Vob2xkZXI6cGxhY2Vob2xkZXI=";
let directory: string, upstream: Server, child: ChildProcess, sql: SqlClient;
let upstreamUrl: string, proxyPort: number;
let expectedAuth = authorization, reject = false, requests = 0;
let api: ReturnType<typeof buildCredentialRoutes>;
const seen: Array<{ matches: boolean; path: string }> = [];
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
function callProxy(managed: boolean, auth: string | undefined = placeholder, path = "/api/public/otel/v1/traces"): Promise<number> {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers.authorization = auth;
  if (managed) {
    const url = new URL(sessionVaultProxyUrl(`http://127.0.0.1:${proxyPort}`, { tenantId: "workspace", sessionId: "session" }, ""));
    headers["proxy-authorization"] = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: proxyPort, path: upstreamUrl + path, method: "POST", headers }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject); request.end("test trace body");
  });
}
function apiRequest(path: string, method: string, body?: unknown) {
  return api.request(`/vault/credentials${path}`, { method, headers: { "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "oma-basic-"));
  upstream = createServer((request, response) => {
    requests++;
    const matches = request.headers.authorization === expectedAuth;
    seen.push({ matches, path: request.url! });
    response.writeHead(matches && !reject ? 204 : 401); response.end();
  });
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
  const reserve = createServer(); proxyPort = await listen(reserve); await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const dbPath = join(directory, "vault.db");
  sql = await createBetterSqlite3SqlClient(dbPath);
  await sql.exec(`
    CREATE TABLE credentials (id TEXT, tenant_id TEXT, vault_id TEXT, auth TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE managed_credentials (workspace_id TEXT, vault_id TEXT, id TEXT, sealed_document TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, PRIMARY KEY(workspace_id, id));
    CREATE TABLE managed_vaults (workspace_id TEXT, id TEXT, archived_at INTEGER);
    CREATE TABLE managed_sessions (workspace_id TEXT, id TEXT, environment_id TEXT, document TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, revision INTEGER);
    CREATE TABLE managed_environments (workspace_id TEXT, id TEXT, document TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
  `);
  const environment = { id: "environment", config: { type: "cloud", networking: { type: "unrestricted" } } };
  await sql.prepare("INSERT INTO managed_environments VALUES (?, ?, ?, 0, 0, NULL)").bind("workspace", "environment", JSON.stringify(environment)).run();
  await sql.prepare("INSERT INTO managed_sessions VALUES (?, ?, ?, ?, 0, 0, NULL, 1)").bind("workspace", "session", "environment", JSON.stringify({ id: "session", vaultIds: ["vault"], resources: [] })).run();
  await sql.prepare("INSERT INTO managed_vaults VALUES (?, ?, NULL)").bind("workspace", "vault").run();
  const rootSecret = randomBytes(32).toString("hex");
  const crypto = new WebCryptoAesGcm(rootSecret, "managed.vault.credentials");
  const store = new SqlCredentialStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await crypto.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await crypto.decrypt(ciphertext) }) });
  let id = 0;
  api = buildCredentialRoutes(new CredentialsApplicationService({ workspaceId: "workspace", store,
    vaults: { find: async () => ({ id: "vault", archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), metadata: {} }) },
    validation: { validate: async () => ({ hasRefreshToken: false, mcpProbe: null, refresh: null, status: "indeterminate" }) },
    clock: { now: () => new Date() }, ids: { nextCredentialId: () => `credential-${++id}` },
  }));
  const auth = { type: "static_basic", username: "public", token: "password", mcp_server_url: upstreamUrl };
  expect((await apiRequest("", "POST", { auth })).status).toBe(201);
  await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)").bind("legacy-basic", "workspace", "vault", JSON.stringify(auth)).run();
  child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], { cwd: resolve(import.meta.dirname, ".."), detached: true, env: { ...process.env, DATABASE_URL: "", DATABASE_PATH: dbPath, OMA_VAULT_CA_DIR: join(directory, "ca"), OMA_VAULT_PORT: String(proxyPort), OMA_TENANT: "workspace", OMA_VAULT_PROXY_KEY: "", OMA_VAULT_UNATTRIBUTED_EGRESS: "allow", PLATFORM_ROOT_SECRET: rootSecret }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Proxy did not start within 20s")), 20_000);
    child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Proxy exited before readiness: ${code}`)); });
    child.stdout!.on("data", (chunk) => { if (String(chunk).includes("listening on")) { clearTimeout(timeout); resolve(); } });
    // Consume stderr without echoing any process environment or credentials.
    child.stderr!.resume();
  });
});
afterAll(async () => {
  if (child?.pid) { process.kill(-child.pid, "SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await sql?.close?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("real oma-vault Basic injection", () => {
  it.each([false, true])("replaces placeholders on REST and OTLP; managed=%s", async (managed) => {
    expect((await fetch(upstreamUrl, { headers: { authorization: placeholder } })).status).toBe(401);
    expect(await callProxy(managed)).toBe(204);
    expect(await callProxy(managed, placeholder, "/api/public/projects")).toBe(204);
    expect(seen.slice(-2)).toEqual([{ matches: true, path: "/api/public/otel/v1/traces" }, { matches: true, path: "/api/public/projects" }]);
  });
  it.each([false, true])("does not retry a Basic 401; managed=%s", async (managed) => {
    reject = true; const before = requests;
    try { expect(await callProxy(managed)).toBe(401); expect(requests - before).toBe(1); } finally { reject = false; }
  });
  it("masks list/get and immediately injects the rotated managed password", async () => {
    expect((await (await apiRequest("", "GET")).json()).data[0].auth).toEqual({ type: "static_basic", username: "public", mcp_server_url: upstreamUrl });
    expect((await (await apiRequest("/credential-1", "GET")).json()).auth).not.toHaveProperty("token");
    expect((await apiRequest("/credential-1", "POST", { auth: { type: "static_basic", token: "rotated" } })).status).toBe(200);
    expectedAuth = "Basic cHVibGljOnJvdGF0ZWQ=";
    expect(await callProxy(true)).toBe(204);
    await apiRequest("/credential-1", "POST", { auth: { type: "static_basic", token: "password" } });
    expectedAuth = authorization;
  });
  it.each([false, true])("preserves exact bearer handles and selects by incoming scheme; managed=%s", async (managed) => {
    for (const [id, handle] of [["bearer", undefined], ["handled", "brain"]] as const) {
      const auth = { type: "static_bearer", token: "pat", mcp_server_url: upstreamUrl, ...(handle && { handle }) };
      if (managed) expect((await apiRequest("", "POST", { auth })).status).toBe(201);
      else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)").bind(id, "workspace", "vault", JSON.stringify(auth)).run();
    }
    expect(await callProxy(managed)).toBe(204);
    expectedAuth = "Bearer pat";
    expect(await callProxy(managed, "Basic YnJhaW46cGxhY2Vob2xkZXI=")).toBe(204);
    expect(await callProxy(managed, "Bearer placeholder")).toBe(204);
    expectedAuth = authorization;
  });
});
