import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { sessionVaultProxyUrl } from "@open-managed-agents/sandbox/vault-proxy";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const proxyKey = "throwaway-jwt-proxy-signing-key";
let directory: string, child: ChildProcess, sql: SqlClient, store: SqlCredentialStore;
let upstream: Server, tokenServer: Server, upstreamUrl: string, tokenUri: string, proxyPort: number;
let mints = 0, upstreamRequests = 0, assertionsValid = true, rejectToken: string | undefined, alwaysReject = false, failMint = false;
let scopes = "drive docs", logs = "";
const tokens: string[] = [];
const location = { workspaceId: "workspace", vaultId: "vault", credentialId: "sa" };
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function callProxy(): Promise<number> {
  const proxy = new URL(sessionVaultProxyUrl(`http://127.0.0.1:${proxyPort}`, { tenantId: "workspace", sessionId: "session" }, proxyKey));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: proxyPort, path: `${upstreamUrl}/drive/v3/files`, method: "POST",
      headers: { authorization: "Bearer placeholder", "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject); request.end("request-body");
  });
}
async function expire() {
  const record = (await store.find(location))!;
  if (record.credential.auth.type !== "service_account_jwt") throw new Error("Wrong fixture type");
  await store.replace({ ...location, expectedRevision: record.revision, next: { ...record.credential, auth: { ...record.credential.auth, expiresAt: new Date(Date.now() - 1000).toISOString() } } });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "oma-service-account-"));
  const cert = join(directory, "token.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(directory, "token.key"), "-out", cert], { stdio: "ignore" });
  tokenServer = createHttpsServer({ key: await readFile(join(directory, "token.key")), cert: await readFile(cert) }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    let valid = false;
    try {
      const [header, payload, signature] = body.get("assertion")!.split(".");
      const h = JSON.parse(Buffer.from(header!, "base64url").toString());
      const c = JSON.parse(Buffer.from(payload!, "base64url").toString());
      valid = request.method === "POST" && body.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer"
        && h.alg === "RS256" && h.kid === "throwaway-key" && c.iss === "bot@example.test" && c.aud === tokenUri && c.scope === scopes
        && c.sub === "delegate@example.test" && c.exp - c.iat === 3600 && Math.abs(Date.now() / 1000 - c.iat) < 60
        && verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, "base64url"));
    } catch { /* mark assertion invalid without printing it */ }
    assertionsValid &&= valid;
    mints++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (!valid || failMint) { response.writeHead(400); response.end("exchange rejected"); return; }
    const token = randomBytes(24).toString("hex"); tokens.push(token);
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ access_token: token, expires_in: 3600 }));
  });
  tokenUri = `https://localhost:${await listen(tokenServer)}/token`;
  upstream = createServer(async (request, response) => {
    upstreamRequests++;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    const valid = token !== undefined && tokens.includes(token) && token !== rejectToken && !alwaysReject
      && request.headers["proxy-authorization"] === undefined && Buffer.concat(chunks).toString() === "request-body";
    response.writeHead(valid ? 204 : 401); response.end();
  });
  upstreamUrl = `http://localhost:${await listen(upstream)}`;
  const reserve = createServer(); proxyPort = await listen(reserve); await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const dbPath = join(directory, "vault.db"); sql = await createBetterSqlite3SqlClient(dbPath);
  await sql.exec(`
    CREATE TABLE credentials (id TEXT, tenant_id TEXT, vault_id TEXT, auth TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE managed_credentials (workspace_id TEXT, vault_id TEXT, id TEXT, sealed_document TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, PRIMARY KEY(workspace_id, id));
    CREATE TABLE managed_vaults (workspace_id TEXT, id TEXT, archived_at INTEGER);
    CREATE TABLE managed_sessions (workspace_id TEXT, id TEXT, environment_id TEXT, document TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, revision INTEGER);
    CREATE TABLE managed_environments (workspace_id TEXT, id TEXT, document TEXT, created_at INTEGER, updated_at INTEGER, archived_at INTEGER);
  `);
  await sql.prepare("INSERT INTO managed_environments VALUES (?, ?, ?, 0, 0, NULL)").bind("workspace", "environment", JSON.stringify({ id: "environment", config: { type: "cloud", networking: { type: "unrestricted" } } })).run();
  await sql.prepare("INSERT INTO managed_sessions VALUES (?, ?, ?, ?, 0, 0, NULL, 1)").bind("workspace", "session", "environment", JSON.stringify({ id: "session", vaultIds: ["vault"], resources: [] })).run();
  await sql.prepare("INSERT INTO managed_vaults VALUES (?, ?, NULL)").bind("workspace", "vault").run();
  const rootSecret = randomBytes(32).toString("hex"); const crypto = new WebCryptoAesGcm(rootSecret, "managed.vault.credentials");
  store = new SqlCredentialStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await crypto.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await crypto.decrypt(ciphertext) }) });
  await store.insert({ workspaceId: "workspace", credential: { id: "sa", vaultId: "vault", metadata: {}, archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auth: {
    type: "service_account_jwt", clientEmail: "bot@example.test", privateKey, privateKeyId: "throwaway-key", tokenUri, scopes, subject: "delegate@example.test", mcpServerUrl: upstreamUrl,
  } } });
  child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], { cwd: resolve(import.meta.dirname, ".."), detached: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, DATABASE_URL: "", DATABASE_PATH: dbPath, OMA_VAULT_CA_DIR: join(directory, "ca"), OMA_VAULT_PORT: String(proxyPort), OMA_TENANT: "workspace", OMA_VAULT_PROXY_KEY: proxyKey, PLATFORM_ROOT_SECRET: rootSecret }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk) => { logs += String(chunk); }); child.stderr!.on("data", (chunk) => { logs += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Proxy readiness timed out")), 20_000);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Proxy exited before readiness")); });
    child.stdout!.on("data", (chunk) => { if (String(chunk).includes("listening on")) { clearTimeout(timeout); resolve(); } });
  });
}, 30_000);
afterAll(async () => {
  if (child?.pid && child.exitCode === null) { process.kill(-child.pid, "SIGTERM"); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
  for (const server of [upstream, tokenServer]) if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql?.close?.(); if (directory) await rm(directory, { recursive: true, force: true });
});
describe("real service-account vault proxy", () => {
  it("mints a valid assertion and injects/caches its token across concurrent requests", async () => {
    expect(await Promise.all(Array.from({ length: 10 }, callProxy))).toEqual(Array(10).fill(204));
    expect(mints).toBe(1); expect(assertionsValid).toBe(true);
    expect(await callProxy()).toBe(204); expect(mints).toBe(1);
    const saved = (await store.find(location))!;
    expect(saved.credential.auth.type === "service_account_jwt" && !!saved.credential.auth.accessToken).toBe(true);
  });
  it("re-mints expired tokens once under concurrency", async () => {
    const before = mints; await expire();
    expect(await Promise.all(Array.from({ length: 8 }, callProxy))).toEqual(Array(8).fill(204));
    expect(mints - before).toBe(1);
  });
  it("re-mints a rejected token once under concurrent upstream 401s", async () => {
    const before = mints; rejectToken = tokens.at(-1);
    expect(await Promise.all(Array.from({ length: 8 }, callProxy))).toEqual(Array(8).fill(204));
    expect(mints - before).toBe(1); rejectToken = undefined;
  });
  it("never loops when the retried upstream still returns 401", async () => {
    const before = mints, requests = upstreamRequests; alwaysReject = true;
    try { expect(await callProxy()).toBe(401); expect(mints - before).toBe(1); expect(upstreamRequests - requests).toBe(2); }
    finally { alwaysReject = false; }
  });
  it("fails closed on an exchange error and retries on the next request", async () => {
    await expire(); const requests = upstreamRequests; failMint = true;
    try { expect(await callProxy()).toBe(502); expect(upstreamRequests).toBe(requests); } finally { failMint = false; }
    expect(await callProxy()).toBe(204);
  });
  it("invalidates cached tokens on scope edits and signs the new scope", async () => {
    const saved = (await store.find(location))!; if (saved.credential.auth.type !== "service_account_jwt") throw new Error("Wrong fixture type");
    scopes = "different-scope";
    await store.replace({ ...location, expectedRevision: saved.revision, next: { ...saved.credential, auth: { ...saved.credential.auth, scopes, accessToken: null, expiresAt: null } } });
    const before = mints; expect(await callProxy()).toBe(204); expect(mints - before).toBe(1); expect(assertionsValid).toBe(true);
  });
  it("never logs private keys or minted tokens", () => {
    expect(logs.includes("BEGIN PRIVATE KEY")).toBe(false);
    expect(tokens.some((token) => logs.includes(token))).toBe(false);
  });
});
