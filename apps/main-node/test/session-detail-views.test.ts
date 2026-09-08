import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes, type SessionRoutesDeps } from "@open-managed-agents/http-routes";
import { buildManagedSessionsApi } from "@open-managed-agents/managed-agents-api";
import { SqlManagedSessionsComposition, SqlSessionPersistence, SqlSessionEventPersistence, SqlSessionRuntimeProjectionPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { Environment, Session, SentSessionEvent } from "@open-managed-agents/managed-agents-application";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";

const workspaceId = "workspace_details";
const timestamp = "2026-09-08T00:00:00.000Z";
const environment: Environment = {
  id: "env_details", name: "Pinned environment", config: { type: "cloud", context: "Original context",
    networking: { type: "unrestricted" }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } },
  createdAt: timestamp, updatedAt: timestamp, archivedAt: null, description: null, metadata: {},
};
const session: Session = {
  id: "session_Details", agent: { id: "agent_details", name: "Pinned agent", version: 3,
    model: { id: "test" }, description: null, system: null, tools: [], skills: [], mcpServers: [], multiagent: null },
  environmentId: environment.id, environmentSnapshot: environment, status: "idle", title: "Conversation",
  createdAt: timestamp, updatedAt: timestamp, archivedAt: null, budget: null, vaultIds: ["vault_details"],
  metadata: { linear: JSON.stringify({ issue_identifier: "DEV-123" }), owner: "team", slack: "plain string" },
  resources: [], stats: {}, usage: { inputTokens: 123, outputTokens: 45 }, outcomeEvaluations: [],
};

describe("session detail requests against the managed session store", () => {
  let db: TestDb;
  beforeEach(async () => { db = await bootstrapTestDb(); });
  afterEach(() => { db.cleanup(); });

  async function fixture() {
    const sessions = new SqlSessionPersistence(db.sql, { seal: async (value) => value });
    await sessions.insert({ workspaceId, session, initialEvents: [], resourceSecrets: [] });
    const composition = new SqlManagedSessionsComposition({
      client: db.sql, environments: { find: async () => environment },
      lifecycle: { sessionStarted: async () => {}, sessionStopped: async () => {} },
      runtime: { sessionEventsAccepted: async () => {}, sessionThreadArchived: async () => {}, subscribe: () => (async function* () {})() },
      sealer: { seal: async (value) => value }, clock: { now: () => new Date(timestamp) },
      ids: { nextSessionId: () => "unused", nextEventId: () => "unused", nextOutcomeId: () => "unused", nextResourceId: () => "unused" },
    });
    const pending = { data: [{ id: "pending_1", type: "user.message", content: "Queued message" }], has_more: false };
    const getPending = vi.fn(async () => ({ status: 200, body: JSON.stringify(pending) }));
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const outputs = {
      list: vi.fn(async () => [{ filename: "result.bin", size_bytes: bytes.length, uploaded_at: timestamp, media_type: "application/octet-stream" }]),
      read: vi.fn(async () => ({ body: bytes.buffer, size: bytes.length, contentType: "application/octet-stream" })),
      deleteAll: vi.fn(async () => {}),
    };
    const retiredLookup = vi.fn(async () => { throw new Error("Retired session store was queried"); });
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-workspace") ?? workspaceId); await next(); });
    app.route("/v1/sessions", buildManagedSessionsApi({
      sessions: (c) => composition.portsFor(c.get("tenant_id")).sessions,
      sessionEvents: (c) => composition.portsFor(c.get("tenant_id")).sessionEvents,
    }));
    const retrieveEnvironment = vi.fn(async () => ({ type: "found" as const, environment: { ...environment, name: "Changed environment" } }));
    app.route("/v1/oma/sessions", buildSessionRoutes({
      application: (c) => ({ ...composition.portsFor(c.get("tenant_id")), environments: { retrieveEnvironment } }),
      services: { sessions: { get: retiredLookup } } as unknown as SessionRoutesDeps["services"],
      router: { getPending } as unknown as SessionRoutesDeps["router"], outputs,
    }));
    return { app, sessions, outputs, getPending, pending, bytes, retiredLookup, retrieveEnvironment };
  }

  it("serves the session page's additional reads for a session with no retired row", async () => {
    const f = await fixture();
    expect(await db.sql.prepare("SELECT count(*) AS count FROM sessions").first()).toEqual({ count: 0 });
    const response = await f.app.request(`/v1/sessions/${session.id}`, { headers: { "anthropic-beta": "managed-agents-2026-04-01" } });
    expect(response.status, await response.clone().text()).toBe(200);
    const native = await response.json();
    const details = await f.app.request(`/v1/oma/sessions/${session.id}`);
    expect(details.status).toBe(200);
    expect(await details.json()).toEqual({
      ...native, agent_id: session.agent.id,
      metadata: { ...session.metadata, linear: { issue_identifier: "DEV-123" } },
    });
    expect((await f.sessions.findCurrent({ workspaceId, sessionId: session.id }))?.session.metadata).toEqual(session.metadata);

    const pending = await f.app.request(`/v1/oma/sessions/${session.id}/pending?session_thread_id=thread_1&include_cancelled=true`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual(f.pending);
    expect(f.getPending).toHaveBeenCalledWith(session.id, {
      rawSearch: "?session_thread_id=thread_1&include_cancelled=true", environmentId: environment.id,
    });
    const listing = await f.app.request(`/v1/oma/sessions/${session.id}/outputs`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ data: [{ filename: "result.bin", size_bytes: 4 }], has_more: false });
    const download = await f.app.request(`/v1/oma/sessions/${session.id}/outputs/result.bin`);
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(f.bytes);
    expect(f.outputs.read).toHaveBeenCalledWith(workspaceId, session.id, "result.bin");
    expect(f.retiredLookup).not.toHaveBeenCalled();
  });

  it("exports all pages of native history with pinned snapshots", async () => {
    const f = await fixture();
    const events: SentSessionEvent[] = Array.from({ length: 205 }, (_, i) => ({
      id: `event_${String(i).padStart(4, "0")}`, type: "user.message", processedAt: timestamp,
      content: [{ type: "text", text: `Message ${i}` }],
    }));
    await new SqlSessionEventPersistence(db.sql).append({ workspaceId, sessionId: session.id, expectedRevision: 1, nextSession: session, events });
    const response = await f.app.request(`/v1/oma/sessions/${session.id}/trajectory`);
    expect(response.status, await response.clone().text()).toBe(200);
    const trajectory = await response.json();
    expect(trajectory).toMatchObject({ session_id: session.id, agent_config: { id: session.agent.id, version: 3 },
      environment_config: { name: environment.name, config: { context: "Original context" } },
      summary: { num_events: 205, token_usage: { input_tokens: 123, output_tokens: 45 } },
    });
    expect(trajectory.events.map((event: { data: string }) => JSON.parse(event.data).content[0].text)).toEqual(events.map((_, i) => `Message ${i}`));
    expect(f.retrieveEnvironment).not.toHaveBeenCalled();
    expect(f.retiredLookup).not.toHaveBeenCalled();
  });

  it("returns 404 across every view for another workspace or a deleted session", async () => {
    const f = await fixture();
    const paths = ["", "/trajectory", "/pending", "/outputs", "/outputs/result.bin", "/llm-calls/event_1"];
    for (const suffix of paths) {
      const response = await f.app.request(`/v1/oma/sessions/${session.id}${suffix}`, { headers: { "x-workspace": "workspace_other" } });
      expect(response.status, suffix).toBe(404);
    }
    const deleted = await f.app.request(`/v1/sessions/${session.id}`, { method: "DELETE", headers: { "anthropic-beta": "managed-agents-2026-04-01" } });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    for (const suffix of paths) {
      const response = await f.app.request(`/v1/oma/sessions/${session.id}${suffix}`);
      expect(response.status, suffix).toBe(404);
    }
    expect(f.getPending).not.toHaveBeenCalled();
    expect(f.outputs.list).not.toHaveBeenCalled();
    expect(f.outputs.read).not.toHaveBeenCalled();
  });

  it("retains an MCP setup warning in the persisted history served to the session page", async () => {
    const f = await fixture();
    const wire = { id: "warning_mcp", type: "session.warning", processed_at: timestamp,
      source: "mcp", message: "Dendrite authorization failed (HTTP 401). Check its vault credential." };
    const event = decodeRuntimeProducedSessionEvent(wire);
    if (!event) throw new Error("MCP warning was dropped");
    await new SqlSessionRuntimeProjectionPersistence(db.sql).project({
      workspaceId, sessionId: session.id, expectedRevision: 1, next: session, events: [event],
    });
    const response = await f.app.request(`/v1/sessions/${session.id}/events`, { headers: { "anthropic-beta": "managed-agents-2026-04-01" } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ data: [wire] });
  });
});
