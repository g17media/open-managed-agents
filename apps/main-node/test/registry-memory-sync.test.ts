// Mid-session memory store mounting (SessionRegistry.syncMemoryMounts).
//
// Regression coverage for the node gap where the mount path only read the
// node-only `session_memory_stores` table (so memory stores attached via
// the standard resources route never mounted) and only at provision time
// (so mid-session attaches did nothing until a process restart).
//
// Uses the real sqlite migrations + real SessionService so the resource
// round-trip goes through the same adapter the routes use (the sqlite
// `config` JSON blob vs pg flattened-columns divergence lives there).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { SessionRegistry } from "../src/registry.js";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db.js";

const TENANT = "tn_test";

interface MountCall {
  storeName: string;
  storeId: string;
  readOnly: boolean;
}

function stubSandbox(mounts: MountCall[]): SandboxExecutor {
  return {
    exec: async () => "exit=0\n",
    mountMemoryStore: async (m: MountCall) => {
      mounts.push(m);
    },
  } as unknown as SandboxExecutor;
}

async function buildRegistry(db: TestDb, mounts: MountCall[]) {
  const workdir = mkdtempSync(join(tmpdir(), "oma-registry-test-"));
  const sessionsService = createSqliteSessionService({ db: db.db });
  const registry = new SessionRegistry({
    sql: db.sql,
    hub: { publish: () => {}, attach: () => () => {} } as never,
    agentsService: { get: async () => null } as never,
    memoryService: {
      getStore: async ({ storeId }: { storeId: string }) => ({
        id: storeId,
        name: `name-of-${storeId}`,
      }),
    } as never,
    sessionsService,
    sandboxOrchestrator: new DefaultSandboxOrchestrator(),
    newEventLog: (() => ({
      appendAsync: async () => {},
      getEventsAsync: async () => [],
    })) as never,
    buildSandbox: async () => stubSandbox(mounts),
    buildModel: (() => {
      throw new Error("not used");
    }) as never,
    buildTools: (async () => ({})) as never,
    buildHarness: () => ({ run: async () => {} }),
    buildHarnessContext: (async () => ({})) as never,
    sandboxWorkdirRoot: workdir,
    sqlDialect: "sqlite",
  });
  return { registry, sessionsService, cleanup: () => rmSync(workdir, { recursive: true, force: true }) };
}

describe("SessionRegistry memory mounts", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("provisions mounts from both the legacy table and standard session resources", async () => {
    const db = await bootstrapTestDb();
    cleanups.push(db.cleanup);
    const mounts: MountCall[] = [];
    const { registry, sessionsService, cleanup } = await buildRegistry(db, mounts);
    cleanups.push(cleanup);

    const { session } = await sessionsService.create({
      tenantId: TENANT,
      agentId: "agent-1",
      environmentId: "env-local-runtime",
      resources: [
        { type: "memory_store", memory_store_id: "ms-standard", access: "read_only" } as never,
      ],
    });
    await db.sql
      .prepare(
        `INSERT INTO session_memory_stores (session_id, store_id, access, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(session.id, "ms-legacy", "read_write", Date.now())
      .run();

    await registry.getOrCreate(session.id, TENANT);
    expect(mounts.map((m) => m.storeId).sort()).toEqual(["ms-legacy", "ms-standard"]);
    expect(mounts.find((m) => m.storeId === "ms-standard")?.readOnly).toBe(true);
    expect(mounts.find((m) => m.storeId === "ms-standard")?.storeName).toBe(
      "name-of-ms-standard",
    );
  });

  it("syncMemoryMounts mounts stores attached after provision, exactly once", async () => {
    const db = await bootstrapTestDb();
    cleanups.push(db.cleanup);
    const mounts: MountCall[] = [];
    const { registry, sessionsService, cleanup } = await buildRegistry(db, mounts);
    cleanups.push(cleanup);

    const { session } = await sessionsService.create({
      tenantId: TENANT,
      agentId: "agent-1",
      environmentId: "env-local-runtime",
    });
    await registry.getOrCreate(session.id, TENANT);
    expect(mounts).toEqual([]);

    // Standard mid-session attach — same call POST /v1/sessions/:id/resources makes.
    await sessionsService.addResource({
      tenantId: TENANT,
      sessionId: session.id,
      resource: { type: "memory_store", memory_store_id: "ms-added", access: "read_write" } as never,
    });
    await registry.syncMemoryMounts(session.id, TENANT);
    expect(mounts.map((m) => m.storeId)).toEqual(["ms-added"]);

    // Re-sync is a no-op — already mounted.
    await registry.syncMemoryMounts(session.id, TENANT);
    expect(mounts.map((m) => m.storeId)).toEqual(["ms-added"]);
  });

  it("syncMemoryMounts is a no-op for sessions with no in-process entry", async () => {
    const db = await bootstrapTestDb();
    cleanups.push(db.cleanup);
    const mounts: MountCall[] = [];
    const { registry, cleanup } = await buildRegistry(db, mounts);
    cleanups.push(cleanup);

    await registry.syncMemoryMounts("sess-nonexistent", TENANT);
    expect(mounts).toEqual([]);
  });
});
