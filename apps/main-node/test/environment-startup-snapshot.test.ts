import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createSqliteEnvironmentService } from "@open-managed-agents/environments-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { buildSessionRoutes, type SessionRoutesDeps } from "@open-managed-agents/http-routes";
import { createEnvironmentSnapshotLoader } from "../src/lib/environment-snapshot";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";

let db: TestDb | undefined;
afterEach(() => { db?.cleanup(); db = undefined; });

async function fixture() {
  db = await bootstrapTestDb();
  const environments = createSqliteEnvironmentService({ db: db.db });
  const sessions = createSqliteSessionService({ db: db.db });
  const environment = await environments.create({ tenantId: "tenant-1", name: "Project",
    config: { type: "cloud", startup: { script: "echo first", triggers: ["wake"], timeout_seconds: 45 } } });
  const deps: SessionRoutesDeps = {
    supportsStartupScripts: true,
    loadEnvironment: createEnvironmentSnapshotLoader(environments),
    services: { sessions, agents: { get: async () => ({ id: "agent-1", tenant_id: "tenant-1", name: "Agent", model: "test", system: "" }) } } as unknown as SessionRoutesDeps["services"],
    router: { init: vi.fn(async () => {}) } as unknown as SessionRoutesDeps["router"],
  };
  const request = (supported = true) => {
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", "tenant-1"); await next(); });
    app.route("/sessions", buildSessionRoutes({ ...deps, supportsStartupScripts: supported }));
    return app.request("/sessions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-1", environment: environment.id }) });
  };
  return { environments, sessions, environment, request, load: deps.loadEnvironment! };
}

describe("Node environment startup snapshots", () => {
  it("persists the configured script and selections at session creation; edits affect later sessions", async () => {
    const f = await fixture();
    const first = await f.request();
    expect(first.status).toBe(201);
    const { id } = await first.json() as { id: string };
    await f.environments.update({ tenantId: "tenant-1", environmentId: f.environment.id,
      config: { type: "cloud", startup: { script: "echo updated", triggers: ["create", "revive"] } } });
    expect((await f.sessions.getById({ sessionId: id }))?.environment_snapshot?.config.startup)
      .toEqual({ script: "echo first", triggers: ["wake"], timeout_seconds: 45 });
    const next = await f.request();
    expect(next.status).toBe(201);
    const later = await next.json() as { id: string };
    expect((await f.sessions.getById({ sessionId: later.id }))?.environment_snapshot?.config.startup?.script).toBe("echo updated");
  });

  it("rejects an active script for a provider that cannot run it", async () => {
    const f = await fixture();
    const response = await f.request(false);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Belljar") });
  });

  it("does not copy another tenant's script into a legacy environment fallback", async () => {
    const f = await fixture();
    const snapshot = await f.load({ tenantId: "tenant-2", environmentId: f.environment.id });
    expect(snapshot?.config.startup).toBeUndefined();
    expect(snapshot?.config.type).toBe("local");
  });
});
