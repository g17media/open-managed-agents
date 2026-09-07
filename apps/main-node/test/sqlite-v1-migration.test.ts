import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { detachedProcessOptions, killProcessTree } from "./helpers/process-tree";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { unzipSync } from "fflate";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { planMigration, canonical, sha, sourceTables, tableExists } from "../src/migrations/v0-data-plan";
import { applyMigration, assertV0DataMigrated, completedMigration, migrateV0AtStartup } from "../src/migrations/v0-data";

const time = Date.parse("2026-08-01T10:00:00Z");
const rootSecret = "fixture-root-secret-not-production";
const binary = Buffer.from([0, 255, 7, 128, 0]);

describe("SQLite v0 to v1 migration", () => {
  let dataDir: string;
  let db: Database.Database;
  const options = () => ({ dataDir, rootSecret });
  const add = (table: string, row: Record<string, unknown>) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  const json = (table: string, id: string) => JSON.parse((db.prepare(`SELECT document FROM ${table} WHERE id=?`).get(id) as { document: string }).document);
  function schema(all = false) {
    db.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
    const migrations = readMigrationFiles({ migrationsFolder: new URL("../migrations-sqlite", import.meta.url).pathname });
    const last = (db.prepare("SELECT MAX(created_at) t FROM __drizzle_migrations").get() as { t: number }).t ?? 0;
    for (const migration of all ? migrations : migrations.slice(0, 5)) {
      if (migration.folderMillis <= last) continue;
      for (const sql of migration.sql) db.exec(sql);
      db.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)").run(migration.hash, migration.folderMillis);
    }
  }
  beforeEach(async () => {
    dataDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "oma-v1-migration-")));
    db = new Database(join(dataDir, "oma.db"));
    schema();
    db.exec("CREATE TABLE session_events(session_id TEXT,seq INTEGER,type TEXT,data TEXT,ts INTEGER,processed_at INTEGER,cancelled_at INTEGER,session_thread_id TEXT,PRIMARY KEY(session_id,seq))");
    const config = { name: "Original agent", model: "fixture-model", system: "Keep this prompt", tools: [{ type: "agent_toolset_20260401" }], skills: [{ type: "anthropic", skill_id: "notes" }] };
    for (const workspace of ["alpha", "beta"]) {
      add("agents", { id: `agent-${workspace}`, tenant_id: workspace, config: JSON.stringify(config), version: 2, created_at: time, updated_at: time });
      add("environments", { id: `env-${workspace}`, tenant_id: workspace, name: "Environment", status: "ready", config: JSON.stringify({ type: "cloud", context: "existing context" }), created_at: time });
      const manifest = { version: "100", created_at: new Date(time).toISOString(), files: [
        { filename: "SKILL.md", content: "---\nname: notes\ndescription: Keep notes\n---\nOriginal skill", encoding: "utf8" },
        { filename: "asset.bin", content: binary.toString("base64"), encoding: "base64" },
      ] };
      for (const [key, value] of [
        [`t:${workspace}:skill:skill-${workspace}`, { id: `skill-${workspace}`, name: "notes", source: "custom", latest_version: "100", created_at: new Date(time).toISOString() }],
        [`t:${workspace}:skillver:skill-${workspace}:100`, manifest],
      ] as const) add("kv_entries", { tenant_id: "default", key, value: JSON.stringify(value) });
    }
    add("vaults", { id: "vault-1", tenant_id: "alpha", name: "Original vault", created_at: time });
    const auth = { type: "mcp_oauth", mcp_server_url: "https://mcp.example.test", access_token: "access-fixture", refresh_token: "refresh-fixture", token_endpoint: "https://auth.example.test/token", client_id: "client-fixture", expires_at: time + 3600000 };
    add("credentials", { id: "credential-1", tenant_id: "alpha", vault_id: "vault-1", display_name: "MCP login", auth_type: "mcp_oauth", auth: await new WebCryptoAesGcm(rootSecret, "credentials.auth").encrypt(JSON.stringify(auth)), created_at: time });
    add("sessions", { id: "sess-1", tenant_id: "alpha", agent_id: "agent-alpha", environment_id: "env-alpha", title: "Original conversation", status: "idle", vault_ids: '["vault-1"]', agent_snapshot: JSON.stringify({ ...config, version: 1, name: "Frozen agent" }), metadata: '{"deployment_id":"dpl-1"}', created_at: time, updated_at: time });
    const events = [
      { type: "user.message", content: [{ type: "text", text: "Original question" }] },
      { type: "span.model_request_start", id: "start-1", model: "fixture-model" },
      { type: "agent.thinking", thinking_id: "0", text: "Original thinking", providerOptions: { anthropic: { signature: "fixture-signature", nested_key: "unchanged" } } },
      { type: "span.model_first_token", model_request_start_id: "start-1", model: "fixture-model" },
      { type: "agent.tool_use", id: "tool-1", name: "bash", input: { snake_key: "same", camelKey: { nested_key: true } } },
      { type: "agent.tool_result", tool_use_id: "tool-1", content: "Original output" },
      { type: "span.model_request_end", model_request_start_id: "start-1", model_usage: { input_tokens: 5, output_tokens: 7 } },
      { type: "agent.thinking", thinking_id: "0", text: "Another turn" },
      { type: "session.error", error: { type: "harness_error", message: "Historical failure" } },
    ];
    events.forEach((event, seq) => add("session_events", { session_id: "sess-1", seq, type: event.type, data: JSON.stringify(event), ts: time, processed_at: time }));
    add("session_events", { session_id: "previously-deleted", seq: 0, type: "user.message", data: JSON.stringify(events[0]), ts: time });
    await fs.mkdir(join(dataDir, "files-blobs", "old"), { recursive: true });
    await fs.writeFile(join(dataDir, "files-blobs", "old", "file-1"), binary);
    add("files", { id: "file-1", tenant_id: "alpha", scope: "tenant", filename: "original.bin", media_type: "application/octet-stream", size_bytes: binary.length, downloadable: 1, r2_key: "old/file-1", created_at: time });
    add("session_resources", { id: "resource-1", session_id: "sess-1", type: "file", config: '{"file_id":"file-1","mount_path":"/workspace/input.bin"}', created_at: time });
    add("memory_stores", { id: "store-1", tenant_id: "alpha", name: "notes", created_at: time, updated_at: time });
    await fs.mkdir(join(dataDir, "memory-blobs", "store-1"), { recursive: true });
    await fs.writeFile(join(dataDir, "memory-blobs", "store-1", "note.md"), "original memory");
    add("memories", { id: "memory-1", store_id: "store-1", path: "/note.md", content_sha256: sha("original memory"), size_bytes: 15, created_at: time, updated_at: time });
    add("memory_versions", { id: "version-1", memory_id: "memory-1", store_id: "store-1", operation: "created", path: "/note.md", content: "original memory", content_sha256: sha("original memory"), size_bytes: 15, actor_type: "agent_session", actor_id: "sess-1", created_at: time, redacted: 0 });
    add("session_resources", { id: "resource-2", session_id: "sess-1", type: "memory_store", config: '{"memory_store_id":"store-1","access":"read_only","instructions":"Keep these instructions"}', created_at: time });
    add("session_memory_stores", { session_id: "sess-1", store_id: "store-1", access: "read_only", created_at: time });
    add("memory_stores", { id: "store-legacy", tenant_id: "alpha", name: "legacy-notes", created_at: time, updated_at: time });
    add("session_memory_stores", { session_id: "sess-1", store_id: "store-legacy", access: "read_only", created_at: time });
    add("deployments", { id: "dpl-1", tenant_id: "alpha", name: "Original schedule", agent_id: "agent-alpha", environment_id: "env-alpha", initial_message: "Original launch", vault_ids: '["vault-1"]', memory_store_ids: '["store-1"]', trigger_type: "schedule", cron: "0 9 * * *", last_run_at: time, last_session_id: "sess-1", created_at: time, updated_at: time });
    await fs.mkdir(join(dataDir, "sandboxes", "sess-1"), { recursive: true });
    await fs.writeFile(join(dataDir, "sandboxes", "sess-1", "work.txt"), "Uncommitted work");
  });
  afterEach(async () => { db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });

  it("preserves entities, frozen configuration, secrets, histories, skills and bytes; reruns leave subsequent edits alone", async () => {
    const original = canonical(sourceTables(db));
    expect(() => assertV0DataMigrated(db)).toThrow("needs the v0-to-v1 migration");
    const plan = await planMigration(db, options());
    expect(plan.report.retainedOrphanEvents).toBe(1);
    expect(JSON.stringify(plan.report)).not.toContain("refresh-fixture");
    expect(tableExists(db, "managed_sessions")).toBe(false);
    const applied = await applyMigration({ ...options(), expected: plan.report, maintenance: true });
    expect(applied.type).toBe("applied");
    expect(canonical(sourceTables(db))).toBe(original);
    expect(assertV0DataMigrated(db)).toBe(true);
    expect(json("managed_sessions", "sess-1").agent.name).toBe("Frozen agent");
    expect(json("managed_sessions", "sess-1").agent.skills).toEqual([{ type: "custom", skillId: "skill-alpha", version: "100" }]);
    expect(json("managed_sessions", "sess-1").resources[1].access).toBe("read_only");
    expect(json("managed_sessions", "sess-1").resources[2]).toMatchObject({ type: "memory_store", memoryStoreId: "store-legacy", access: "read_only" });
    expect((db.prepare("SELECT COUNT(*) n FROM managed_session_memory_stores").get() as { n: number }).n).toBe(2);
    expect(json("managed_vaults", "vault-1").displayName).toBe("Original vault");
    const sealed = (db.prepare("SELECT sealed_document FROM managed_credentials").get() as { sealed_document: string }).sealed_document;
    expect(sealed).not.toContain("access-fixture");
    const credential = JSON.parse(await new WebCryptoAesGcm(rootSecret, "managed.vault.credentials").decrypt(sealed));
    expect(credential.auth.refresh.refreshToken).toBe("refresh-fixture");
    const events = (db.prepare("SELECT document FROM managed_session_events ORDER BY processed_at,id").all() as { document: string }[]).map((row) => JSON.parse(row.document));
    expect(events).toHaveLength(9);
    expect(events[5].toolUseId).toBe(events[4].id);
    expect(events[6].modelRequestStartId).toBe(events[1].id);
    expect(events[2].text).toBe("Original thinking");
    expect(encodeRuntimeHistoryEvent(events[4])).toMatchObject({ input: { snake_key: "same", camelKey: { nested_key: true } } });
    expect(encodeRuntimeHistoryEvent(events[2])).toMatchObject({ providerOptions: { anthropic: { signature: "fixture-signature", nested_key: "unchanged" } } });
    expect(await fs.readFile(join(dataDir, "files-blobs/managed-files/alpha/file-1"))).toEqual(binary);
    const archive = (db.prepare("SELECT archive FROM managed_skill_versions WHERE workspace_id='alpha'").get() as { archive: Buffer }).archive;
    expect(Buffer.from(Object.values(unzipSync(archive)).find((value) => Buffer.from(value).equals(binary))!)).toEqual(binary);
    expect(json("managed_memories", "memory-1").memoryVersionId).toBe("version-1");
    expect(json("managed_deployments", "dpl-1").schedule.upcomingRunsAt[0] > plan.report.createdAt).toBe(true);
    expect(JSON.parse((db.prepare("SELECT document FROM managed_deployment_runs").get() as { document: string }).document).sessionId).toBe("sess-1");
    expect(await fs.readFile(join(dataDir, "sandboxes/alpha/sess-1/work.txt"), "utf8")).toBe("Uncommitted work");
    expect(await fs.stat(join(applied.report.backupDirectory, "manifest.json"))).toBeTruthy();
    db.prepare("UPDATE managed_sessions SET document=json_set(document,'$.title','New edit') WHERE id='sess-1'").run();
    expect((await applyMigration({ ...options(), expected: plan.report, maintenance: true })).type).toBe("already_applied");
    expect(json("managed_sessions", "sess-1").title).toBe("New edit");
  });

  it("refuses stale plans, wrong keys, active sessions, missing blobs and cross-workspace references before writing", async () => {
    const plan = await planMigration(db, options());
    await expect(applyMigration({ ...options(), expected: plan.report, maintenance: false })).rejects.toThrow("Stop all");
    await expect(applyMigration({ ...options(), rootSecret: "wrong", expected: plan.report, maintenance: true })).rejects.toThrow();
    db.prepare("UPDATE sessions SET title='changed'").run();
    await expect(applyMigration({ ...options(), expected: plan.report, maintenance: true })).rejects.toThrow("stale");
    db.prepare("UPDATE sessions SET status='running'").run();
    await expect(planMigration(db, options())).rejects.toThrow("active");
    db.prepare("UPDATE sessions SET status='idle',agent_id='agent-beta'").run();
    await expect(planMigration(db, options())).rejects.toThrow("workspace");
    db.prepare("UPDATE sessions SET agent_id='agent-alpha'").run();
    await fs.unlink(join(dataDir, "files-blobs/old/file-1"));
    await expect(planMigration(db, options())).rejects.toThrow("ENOENT");
    expect(completedMigration(db)).toBeNull();
  });

  it("rolls back every SQL insert on failure and refuses existing destination IDs", async () => {
    schema(true);
    db.exec("CREATE TRIGGER migration_failure BEFORE INSERT ON managed_sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const plan = await planMigration(db, options());
    await expect(applyMigration({ ...options(), expected: plan.report, maintenance: true })).rejects.toThrow("SQL changes rolled back");
    expect((db.prepare("SELECT COUNT(*) n FROM managed_agents").get() as { n: number }).n).toBe(0);
    expect(completedMigration(db)).toBeNull();
    add("managed_agents", { id: "agent-alpha", workspace_id: "another-workspace", document: "{}", version: 1, created_at: time, updated_at: time });
    await expect(planMigration(db, options())).rejects.toThrow("refusing to overwrite");
  });

  it("automatically migrates once across concurrent starts and leaves new edits intact on restart", async () => {
    const progress: string[] = [];
    const results = await Promise.all([0, 1].map(() => migrateV0AtStartup({ ...options(), onProgress: ({ phase }) => progress.push(phase) })));
    expect(results[0]?.planSha256).toBe(results[1]?.planSha256);
    expect(progress.filter((phase) => phase === "backup")).toHaveLength(1);
    expect(progress.filter((phase) => phase === "completed")).toHaveLength(1);
    db.prepare("UPDATE managed_sessions SET document=json_set(document,'$.title','After upgrade')").run();
    const backups = await fs.readdir(join(dataDir, ".backups"));
    await migrateV0AtStartup(options());
    expect(await fs.readdir(join(dataDir, ".backups"))).toEqual(backups);
    expect(json("managed_sessions", "sess-1").title).toBe("After upgrade");
  });

  it("starts the real application on an old database with no manual migration command", async () => {
    const repo = resolve(__dirname, "../../..");
    const port = await new Promise<number>((done, reject) => {
      const listener = createServer();
      listener.on("error", reject);
      listener.listen(0, "127.0.0.1", () => { const port = (listener.address() as { port: number }).port; listener.close(() => done(port)); });
    });
    const apiKey = "fixture-upgrade-api-key";
    add("api_keys", { id: "key-1", tenant_id: "alpha", name: "Upgrade test", prefix: "fixture", hash: sha(apiKey), created_at: time });
    const logs: string[] = [];
    const child = spawn(join(repo, "apps/main-node/node_modules/.bin/tsx"), [join(repo, "apps/main-node/src/index.ts")], {
      ...detachedProcessOptions, cwd: repo,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: "", OMA_AUTO_MIGRATE: "1",
        DATABASE_PATH: join(dataDir, "oma.db"), AUTH_DATABASE_PATH: join(dataDir, "auth.db"),
        FILES_BLOB_DIR: join(dataDir, "files-blobs"), MEMORY_BLOB_DIR: join(dataDir, "memory-blobs"),
        SESSION_OUTPUTS_DIR: join(dataDir, "session-outputs"), SANDBOX_WORKDIR: join(dataDir, "sandboxes"),
        FILES_S3_ENDPOINT: "", MEMORY_S3_ENDPOINT: "", AUTH_DISABLED: "", PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        BETTER_AUTH_SECRET: "fixture-auth-secret-not-production", PLATFORM_ROOT_SECRET: rootSecret,
        ANTHROPIC_API_KEY: "", DREAM_CURATOR_MODE: "dedup", NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (bytes) => logs.push(String(bytes)));
    child.stderr?.on("data", (bytes) => logs.push(String(bytes)));
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 160; attempt++) {
        if (child.exitCode !== null) throw new Error(logs.join(""));
        try { healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* still migrating */ }
        if (healthy) break;
        await delay(200);
      }
      expect(healthy, logs.join("")).toBe(true);
      expect(completedMigration(db)).not.toBeNull();
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers: { "x-api-key": apiKey, "anthropic-beta": "managed-agents-2026-04-01" } });
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject([{ id: "sess-1", title: "Original conversation" }]);
      expect(logs.join("")).toContain("SQLite data migration: completed");
    } finally { await killProcessTree(child); }
  });
});
