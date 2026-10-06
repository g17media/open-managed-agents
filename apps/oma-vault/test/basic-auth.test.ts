import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, Agent } from "node:https";
import { connect } from "node:tls";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const proxyKey = "throwaway-review-signing-key";
describe.each(["http", "https"])("%s proxy", (protocol) => {
let directory: string, upstream: Server, child: ChildProcess, sql: SqlClient;
let upstreamUrl: string, proxyPort: number;
let expectedAuth: string | undefined = authorization, reject = false, requests = 0;
let logs = "";
let expectStripped = false;
let expectPassthrough: boolean | undefined;
let api: ReturnType<typeof buildCredentialRoutes>;
let store: SqlCredentialStore;
const seen: Array<{ matches: boolean; path: string }> = [];
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function callProxyResponse(managed: boolean, auth: string | null = placeholder, path = "/api/public/otel/v1/traces", unmatched = false, forged = false, targetUrl?: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  headers["x-review-marker"] = "preserved";
  headers["x-api-key"] = "placeholder";
  headers["x-goog-api-key"] = "placeholder";
  headers["xi-api-key"] = "placeholder";
  headers["x-agent-token"] = "placeholder";
  if (managed) {
    const url = new URL(sessionVaultProxyUrl(`http://127.0.0.1:${proxyPort}`, { tenantId: "workspace", sessionId: "session" }, forged ? "wrong-key" : proxyKey));
    headers["proxy-authorization"] = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`;
  }
  const target = new URL(targetUrl ?? upstreamUrl + path);
  if (unmatched) target.hostname = "127.0.0.1";
  let agent: Agent | undefined;
  if (target.protocol === "https:") {
    const ca = await readFile(join(directory, "ca", "ca.crt"));
    const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const tunnel = httpRequest({ hostname: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target.host,
        headers: headers["proxy-authorization"] ? { "proxy-authorization": headers["proxy-authorization"] } : {} });
      tunnel.once("connect", (response, socket) => response.statusCode === 200 ? resolve(socket) : reject(new Error("CONNECT failed")));
      tunnel.once("error", reject); tunnel.end();
    });
    const tlsSocket = connect({ socket, ca, servername: "localhost" });
    await new Promise<void>((resolve, reject) => { tlsSocket.once("secureConnect", resolve); tlsSocket.once("error", reject); });
    agent = new Agent();
    agent.createConnection = () => tlsSocket;
    delete headers["proxy-authorization"];
  }
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const options = target.protocol === "https:"
      ? { hostname: target.hostname, port: target.port, path: target.pathname + target.search, agent }
      : { hostname: "127.0.0.1", port: proxyPort, path: target.href };
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)({ ...options, method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end("test trace body");
  }).finally(() => agent?.destroy());
}
async function callProxy(...args: Parameters<typeof callProxyResponse>): Promise<number> {
  return (await callProxyResponse(...args)).status;
}
function apiRequest(path: string, method: string, body?: unknown) {
  return api.request(`/vault/credentials${path}`, { method, headers: { "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "oma-basic-"));
  const handler: import("node:http").RequestListener = (request, response) => {
    requests++;
    const authHeaders = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "authorization");
    const unmatched = request.headers.host?.startsWith("127.0.0.1:");
    const matches = request.headers.authorization === expectedAuth && authHeaders.length === (expectedAuth === undefined ? 0 : 1)
      && request.headers["x-review-marker"] === "preserved"
      && request.headers["x-api-key"] === ((expectPassthrough ?? (unmatched && !expectStripped)) ? "placeholder" : undefined)
      && request.headers["x-goog-api-key"] === ((expectPassthrough ?? (unmatched && !expectStripped)) ? "placeholder" : undefined)
      && request.headers["xi-api-key"] === ((expectPassthrough ?? (unmatched && !expectStripped)) ? "placeholder" : undefined)
      && request.headers["x-agent-token"] === ((expectPassthrough ?? (unmatched && !expectStripped)) ? "placeholder" : undefined)
      && request.headers["proxy-authorization"] === undefined;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ matches, path: request.url! });
      response.writeHead(matches && !reject && Buffer.concat(chunks).toString() === "test trace body" ? 204 : 401); response.end();
    });
  };
  const upstreamCa = join(directory, "upstream.crt");
  if (protocol === "https") {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(directory, "upstream.key"), "-out", upstreamCa], { stdio: "ignore" });
    upstream = createHttpsServer({ key: await readFile(join(directory, "upstream.key")), cert: await readFile(upstreamCa) }, handler);
  } else upstream = createServer(handler);
  upstreamUrl = `${protocol}://localhost:${await listen(upstream)}`;
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
  store = new SqlCredentialStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await crypto.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await crypto.decrypt(ciphertext) }) });
  let id = 0;
  api = buildCredentialRoutes(new CredentialsApplicationService({ workspaceId: "workspace", store,
    vaults: { find: async () => ({ id: "vault", archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), metadata: {} }) },
    validation: { validate: async () => ({ hasRefreshToken: false, mcpProbe: null, refresh: null, status: "indeterminate" }) },
    clock: { now: () => new Date() }, ids: { nextCredentialId: () => `credential-${++id}` },
  }));
  const auth = { type: "static_basic", username: "public", token: "password", mcp_server_url: upstreamUrl };
  expect((await apiRequest("", "POST", { auth })).status).toBe(201);
  await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)").bind("legacy-basic", "workspace", "vault", JSON.stringify(auth)).run();
  child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], { cwd: resolve(import.meta.dirname, ".."), detached: true, env: { ...process.env, LOG_LEVEL: "debug", ...(protocol === "https" && { NODE_EXTRA_CA_CERTS: upstreamCa }), CAP_OVERRIDE_FEEDFORWARD_ENDPOINTS: "localhost 127.0.0.1", DATABASE_URL: "", DATABASE_PATH: dbPath, OMA_VAULT_CA_DIR: join(directory, "ca"), OMA_VAULT_PORT: String(proxyPort), OMA_TENANT: "workspace", OMA_VAULT_PROXY_KEY: proxyKey, OMA_VAULT_UNATTRIBUTED_EGRESS: "allow", PLATFORM_ROOT_SECRET: rootSecret }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk) => { logs += String(chunk); });
  child.stderr!.on("data", (chunk) => { logs += String(chunk); });
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
    if (protocol === "http") expect((await fetch(upstreamUrl, { headers: { authorization: placeholder } })).status).toBe(401);
    expect(await callProxy(managed)).toBe(204);
    expect(await callProxy(managed, placeholder, "/api/public/projects")).toBe(204);
    expect(seen.slice(-2)).toEqual([{ matches: true, path: "/api/public/otel/v1/traces" }, { matches: true, path: "/api/public/projects" }]);
  });
  it.each([false, true])("injects sole Basic for absent and Bearer headers; managed=%s", async (managed) => {
    expect(await callProxy(managed, null)).toBe(204);
    expect(await callProxy(managed, "Bearer x")).toBe(204);
  });
  it.each([false, true])("preserves authorization on an unmatched host; managed=%s", async (managed) => {
    try {
      for (const auth of [placeholder, "Bearer x", null]) {
        expectedAuth = auth ?? undefined;
        expect(await callProxy(managed, auth, "/api/public/projects", true)).toBe(204);
      }
    } finally { expectedAuth = authorization; }
  });
  it.each([false, true])("does not retry a Basic 401; managed=%s", async (managed) => {
    reject = true; const before = requests;
    try { expect(await callProxy(managed)).toBe(401); expect(requests - before).toBe(1); } finally { reject = false; }
  });
  it("strips caller auth and injects nothing for forged attribution", async () => {
    expectedAuth = undefined;
    expectStripped = true;
    try {
      expect(await callProxy(true, placeholder, "/api/public/projects", true, true)).toBe(204);
      expect(await callProxy(true, placeholder, "/api/public/projects", false, true)).toBe(204);
    } finally { expectedAuth = authorization; expectStripped = false; }
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
  it.each(["static_bearer", "cap_cli"])("uses an edited %s host and handle on the next request", async (type) => {
    const created = await apiRequest("", "POST", { auth: { type, token: "editable-pat", handle: "before", mcp_server_url: upstreamUrl, ...(type === "cap_cli" && { cli_id: "git" }) } });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const selector = (handle: string) => `Basic ${Buffer.from(`${handle}:placeholder`).toString("base64")}`;
    const path = "/repo.git/info/refs?service=git-upload-pack";
    expectedAuth = `Basic ${Buffer.from("x-access-token:editable-pat").toString("base64")}`;
    const editedUrl = new URL(upstreamUrl); editedUrl.hostname = "127.0.0.1";
    const fallback = await apiRequest("", "POST", { auth: { type: "static_bearer", token: "fallback-pat", mcp_server_url: editedUrl.href } });
    const { id: fallbackId } = await fallback.json();
    try {
      expect(await callProxy(true, selector("before"), path)).toBe(204);
      const edited = await apiRequest(`/${id}`, "POST", { auth: { type, handle: "after", mcp_server_url: editedUrl.href } });
      expect(edited.status).toBe(200);
      expectStripped = true;
      expect(await callProxy(true, selector("after"), path, true)).toBe(204);
      expect(await callProxy(true, selector("before"), path, true)).toBe(401);
      expect(await callProxy(true, selector("after"), path)).toBe(401);
    } finally {
      await apiRequest(`/${id}`, "DELETE");
      await apiRequest(`/${fallbackId}`, "DELETE");
      expectedAuth = authorization; expectStripped = false;
    }
  });
  it.each([false, true])("preserves exact bearer handles and selects by incoming scheme; managed=%s", async (managed) => {
    for (const [id, handle] of [["bearer", undefined], ["handled", "brain"]] as const) {
      const auth = { type: "static_bearer", token: handle ? "handled-pat" : "pat", mcp_server_url: upstreamUrl, ...(handle && { handle }) };
      if (managed) expect((await apiRequest("", "POST", { auth })).status).toBe(201);
      else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)").bind(id, "workspace", "vault", JSON.stringify(auth)).run();
    }
    expect(await callProxy(managed)).toBe(204);
    expectedAuth = "Bearer handled-pat";
    expect(await callProxy(managed, "Basic YnJhaW46cGxhY2Vob2xkZXI=")).toBe(204);
    expectedAuth = "Bearer pat";
    expect(await callProxy(managed, "Bearer placeholder")).toBe(204);
    expect(await callProxy(managed, null)).toBe(204);
    expectedAuth = authorization;
  });
  it.each([[false, "unmapped.example.test"], [false, "api.elevenlabs.io"], [true, "unmapped.example.test"], [true, "api.elevenlabs.io"]] as const)("hides a stored CRLF token including provider Authorization fallback (managed=%s, host=%s)", async (managed, host) => {
    // Bypass API validation to represent credentials persisted before hardening.
    const token = "synthetic-crlf-secret\r\nsecond-secret-line";
    const targetUrl = `http://${host}/v1/test`;
    if (managed) await store.insert({ workspaceId: "workspace", credential: {
      id: "malformed", vaultId: "vault", auth: { type: "static_bearer", token, mcpServerUrl: targetUrl },
      metadata: {}, archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    } });
    else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)")
      .bind("malformed", "workspace", "vault", JSON.stringify({ type: "static_bearer", token, mcp_server_url: targetUrl })).run();
    const before = requests;
    try {
      const response = await callProxyResponse(managed, null, "", false, false, targetUrl);
      expect(response).toEqual({ status: 502, body: "oma-vault: upstream forward failed" });
      expect(requests).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logs).toContain('"error_class":"TypeError"');
      for (const secret of [token, "synthetic-crlf-secret", "second-secret-line"]) {
        expect(response.body).not.toContain(secret);
        expect(logs).not.toContain(secret);
      }
    } finally {
      if (managed) await store.delete({ workspaceId: "workspace", vaultId: "vault", credentialId: "malformed" });
      else await sql.prepare("DELETE FROM credentials WHERE id = ?").bind("malformed").run();
    }
  });
  it.each([false, true])("rejects plaintext before any upstream connection for HTTPS registrations (managed registration=%s)", async (managed) => {
    // Listen for TCP connections, not just HTTP requests: even a TLS/plaintext mismatch must not connect.
    const sink = createServer();
    let connections = 0;
    sink.on("connection", (socket) => { connections++; socket.destroy(); });
    const sinkPort = await listen(sink);
    const registeredUrl = "https://127.0.0.1"; // Different port must not bypass hostname protection.
    if (managed) {
      const response = await apiRequest("", "POST", { auth: { type: "static_bearer", token: "https-only-key", mcp_server_url: registeredUrl } });
      expect(response.status).toBe(201);
    } else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)")
      .bind("https-only", "workspace", "vault", JSON.stringify({ type: "static_bearer", token: "https-only-key", mcp_server_url: registeredUrl })).run();
    const page = await (await apiRequest("", "GET")).json();
    const credential = page.data.find((item: { auth: { mcp_server_url: string } }) => item.auth.mcp_server_url === registeredUrl);
    try {
      for (const [attributed, forged] of [[false, false], [true, false], [true, true]]) {
        const response = await callProxyResponse(attributed, null, "", false, forged, `http://127.0.0.1:${sinkPort}/sentinel-downgrade-path?q=sentinel-downgrade-query`);
        expect(response).toEqual({ status: 403, body: "oma-vault: plaintext egress denied" });
      }
      expect(connections).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logs).not.toContain("sentinel-downgrade");
      const entry = logs.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
        .find((item) => item.op === "oma_vault.plaintext_denied");
      expect(entry).toMatchObject({ method: "POST", scheme: "http", hostname: "127.0.0.1", status: 403 });
      expect(entry).not.toHaveProperty("url");
    } finally {
      if (managed) await apiRequest(`/${credential.id}`, "DELETE");
      else await sql.prepare("DELETE FROM credentials WHERE id = ?").bind("https-only").run();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
  it.each([false, true])("does not reintroduce HTTPS credentials through CAP hostname fallback (managed=%s)", async (managed) => {
    let receivedAuth: string | undefined;
    const sink = createServer((request, response) => {
      receivedAuth = request.headers.authorization;
      request.resume(); response.writeHead(204); response.end();
    });
    const sinkPort = await listen(sink);
    const targetUrl = `http://127.0.0.1:${sinkPort}/internal`;
    const registeredUrl = "https://other-registered.example.test";
    let credentialId = "https-cap";
    if (managed) {
      const response = await apiRequest("", "POST", { auth: { type: "cap_cli", cli_id: "feedforward", token: "https-cap-secret", mcp_server_url: registeredUrl } });
      expect(response.status).toBe(201);
      credentialId = (await response.json()).id;
    } else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)")
      .bind(credentialId, "workspace", "vault", JSON.stringify({ type: "cap_cli", cli_id: "feedforward", token: "https-cap-secret", mcp_server_url: registeredUrl })).run();
    try {
      expect(await callProxy(managed, "Bearer caller", "", false, false, targetUrl)).toBe(204);
      expect(receivedAuth).toBe("Bearer caller");
    } finally {
      if (managed) await apiRequest(`/${credentialId}`, "DELETE");
      else await sql.prepare("DELETE FROM credentials WHERE id = ?").bind(credentialId).run();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });
  it("omits URL member material from injection, passthrough, denial and failure logs", async () => {
    const sentinel = "/sentinel-private-path?q=sentinel-private-query";
    const start = logs.length;
    expect(await callProxy(true, placeholder, sentinel)).toBe(204);
    expectedAuth = placeholder;
    try { expect(await callProxy(true, placeholder, sentinel, true)).toBe(204); }
    finally { expectedAuth = authorization; }
    expect(await callProxy(true, placeholder, sentinel, false, true)).toBe(401);
    await sql.prepare("UPDATE managed_environments SET document = ? WHERE id = ?")
      .bind(JSON.stringify({ id: "environment", config: { type: "cloud", networking: { type: "limited", allowedHosts: [], allowMcpServers: false, allowPackageManagers: false } } }), "environment").run();
    try { expect(await callProxy(true, placeholder, sentinel)).toBe(403); }
    finally {
      await sql.prepare("UPDATE managed_environments SET document = ? WHERE id = ?")
        .bind(JSON.stringify({ id: "environment", config: { type: "cloud", networking: { type: "unrestricted" } } }), "environment").run();
    }
    // mockttp rejects userinfo before the callback; the helper also tests this URL shape directly.
    expect(await callProxy(false, null, "", false, false,
      `http://sentinel-private-user:sentinel-private-password@unmapped.example.test${sentinel}`)).toBe(400);
    await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)")
      .bind("sentinel-failure", "workspace", "vault", JSON.stringify({ type: "static_bearer", token: "invalid\r\nheader", mcp_server_url: "http://unmapped.example.test" })).run();
    try {
      expect(await callProxy(false, null, "", false, false, `http://unmapped.example.test${sentinel}`)).toBe(502);
    } finally { await sql.prepare("DELETE FROM credentials WHERE id = ?").bind("sentinel-failure").run(); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const captured = logs.slice(start);
    expect(captured).not.toContain("sentinel-private");
    const entries = captured.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    for (const op of ["inject", "passthrough", "bad_attribution", "egress_denied", "forward_failed"]) {
      const entry = entries.find((item) => item.op === `oma_vault.${op}`);
      expect(entry, op).toBeDefined();
      expect(entry).toMatchObject({ method: "POST", scheme: expect.any(String), hostname: expect.any(String) });
      expect(entry).not.toHaveProperty("url");
    }
  });
  it("keeps passwords and encoded credentials out of proxy logs", () => {
    expect(["password", "rotated", "cHVibGljOnBhc3N3b3Jk", "cHVibGljOnJvdGF0ZWQ="].some((secret) => logs.includes(secret))).toBe(false);
  });
  it.each([false, true])("preserves bearer-only behavior across selectors and git paths; managed=%s", async (managed) => {
    if (managed) {
      const page = await (await apiRequest("", "GET")).json();
      for (const credential of page.data) expect((await apiRequest(`/${credential.id}`, "DELETE")).status).toBe(200);
    } else await sql.prepare("DELETE FROM credentials").run();
    for (const [id, handle, token] of [["default", undefined, "pat"], ["selector", "brain", "handled-pat"]] as const) {
      const auth = { type: "static_bearer", token, mcp_server_url: upstreamUrl, ...(handle && { handle }) };
      if (managed) expect((await apiRequest("", "POST", { auth })).status).toBe(201);
      else await sql.prepare("INSERT INTO credentials VALUES (?, ?, ?, ?, 0, 0, NULL)").bind(id, "workspace", "vault", JSON.stringify(auth)).run();
    }
    try {
      for (const [incoming, expected] of [["Basic YnJhaW46cGxhY2Vob2xkZXI=", "Bearer handled-pat"], [placeholder, "Bearer pat"], [null, "Bearer pat"], ["Bearer x", "Bearer pat"]] as const) {
        expectedAuth = expected;
        expect(await callProxy(managed, incoming)).toBe(204);
      }
      expectedAuth = "Basic eC1hY2Nlc3MtdG9rZW46aGFuZGxlZC1wYXQ=";
      expect(await callProxy(managed, "Basic YnJhaW46cGxhY2Vob2xkZXI=", "/repo.git/info/refs?service=git-upload-pack")).toBe(204);
    } finally { expectedAuth = authorization; }
  });
  it.each(["static_bearer", "cap_cli", "static_basic"])("moves %s off a warmed host and changes selectors without changing its secret", async (type) => {
    const page = await (await apiRequest("", "GET")).json();
    for (const credential of page.data) expect((await apiRequest(`/${credential.id}`, "DELETE")).status).toBe(200);
    const token = " exact:synthetic-pat ";
    const basic = (username: string, password = "placeholder") => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const path = "/repo.git/info/refs?service=git-upload-pack";
    const created = await apiRequest("", "POST", { auth: { type, token, mcp_server_url: upstreamUrl, ...(type === "static_basic" ? { username: "before" } : { handle: "before" }), ...(type === "cap_cli" && { cli_id: "git" }) } });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const editedUrl = new URL(upstreamUrl); editedUrl.hostname = "127.0.0.1";
    try {
      expectedAuth = basic(type === "static_basic" ? "before" : "x-access-token", token);
      expectPassthrough = false;
      expect(await callProxy(true, basic("before"), path)).toBe(204);
      const update = await apiRequest(`/${id}`, "POST", { auth: { type, mcp_server_url: editedUrl.href } });
      expect(update.status).toBe(200);
      const publicAuth = (await update.json()).auth;
      expect(publicAuth).not.toHaveProperty("token");
      expect(publicAuth).not.toHaveProperty("password");
      expectedAuth = basic("before"); expectPassthrough = true;
      expect(await callProxy(true, basic("before"), path)).toBe(204);
      expectedAuth = basic(type === "static_basic" ? "before" : "x-access-token", token); expectPassthrough = false;
      expect(await callProxy(true, basic("before"), path, true)).toBe(204);
      if (type === "static_basic") {
        expect((await apiRequest(`/${id}`, "POST", { auth: { type, username: "after" } })).status).toBe(200);
        expectedAuth = basic("after", token);
        expect(await callProxy(true, basic("before"), path, true)).toBe(204);
      } else {
        const fallback = await apiRequest("", "POST", { auth: { type: "static_bearer", token: "fallback-pat", mcp_server_url: editedUrl.href } });
        expect(fallback.status).toBe(201);
        const { id: fallbackId } = await fallback.json();
        expect(await callProxy(true, basic("before"), path, true)).toBe(204);
        expect((await apiRequest(`/${id}`, "POST", { auth: { type, handle: "after" } })).status).toBe(200);
        expect(await callProxy(true, basic("after"), path, true)).toBe(204);
        expectedAuth = basic("x-access-token", "fallback-pat");
        for (const selector of ["before", "AFTER", "unknown"]) expect(await callProxy(true, basic(selector), path, true)).toBe(204);
        expect((await apiRequest(`/${fallbackId}`, "DELETE")).status).toBe(200);
        // A handle is a preference, not an access boundary: unmatched handled credentials are last fallback.
        expectedAuth = basic("x-access-token", token);
        expect(await callProxy(true, basic("unknown"), path, true)).toBe(204);
      }
    } finally {
      await apiRequest(`/${id}`, "DELETE");
      expectedAuth = authorization; expectPassthrough = undefined;
    }
  });
});
});
