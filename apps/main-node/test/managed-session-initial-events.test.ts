import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInitialEventsApplicationService, SessionRuntimeHistoryApplicationService,
  type Session, type Environment, type SessionBootstrapEvent } from "@open-managed-agents/managed-agents-application";
import { SqlSessionPersistence, SqlSessionEventPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import { SqlSessionRuntimeHistorySource } from "@open-managed-agents/session-runtime-sql";
import { ApplicationBackedNodeManagedSessionRuntimeEngine } from "../src/lib/node-managed-session-runtime";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";
import { recoverEmptyManagedSessions } from "../src/lib/recover-empty-managed-sessions";

const workspaceId = "workspace_initial";
const timestamp = "2026-09-08T00:00:00.000Z";
const environment: Environment = { id: "env_initial", name: "Test", config: { type: "cloud" },
  createdAt: timestamp, updatedAt: timestamp, archivedAt: null, description: null, metadata: {} };
const session: Session = { id: "session_Initial", agent: { id: "agent_initial", version: 1, name: "Test",
  model: { id: "test" }, system: null, description: null, multiagent: null, tools: [], skills: [], mcpServers: [] },
  environmentId: environment.id, environmentSnapshot: environment, title: "Initial message verification",
  createdAt: timestamp, updatedAt: timestamp, archivedAt: null, status: "running", metadata: {},
  resources: [], vaultIds: [], budget: null, stats: {}, usage: {}, outcomeEvaluations: [] };
const initialEvents: SessionBootstrapEvent[] = [
  { type: "system.message", content: [{ type: "text", text: "Context" }] },
  { type: "user.message", content: [{ type: "text", text: "Run the deployment" }] },
  { type: "user.define_outcome", description: "Complete the task", rubric: { type: "text", content: "Command succeeds" } },
];

describe("Node session initial events", () => {
  let db: TestDb;
  beforeEach(async () => { db = await bootstrapTestDb(); });
  afterEach(() => { db.cleanup(); vi.restoreAllMocks(); });

  async function fixture() {
    const sessions = new SqlSessionPersistence(db.sql, { seal: async (value) => value });
    const store = new SqlSessionEventPersistence(db.sql);
    await sessions.insert({ workspaceId, session, initialEvents, resourceSecrets: [] });
    const execution = { find: async (input: { workspaceId: string; sessionId: string }) => {
      const current = await sessions.findCurrent(input);
      return current ? { ...current, environment } : null;
    } };
    const source = new SqlSessionRuntimeHistorySource(db.sql);
    const history = new SessionRuntimeHistoryApplicationService({ workspaceId, source });
    return { sessions, store, execution, source, history };
  }

  it("starts the first turn and exposes each initial event once in history", async () => {
    const f = await fixture();
    const frames: unknown[] = [];
    const runner = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), archiveThread: vi.fn(async () => {}),
      accept: vi.fn(async (input) => { await input.output({ type: "agent.message", content: "done" }); }) };
    const engine = new ApplicationBackedNodeManagedSessionRuntimeEngine({ runner, historyFor: () => f.history,
      initializeSession: async (input) => initializer.initialize({ sessionId: input.sessionId, events: input.initialEvents }) });
    const initializer = new SessionInitialEventsApplicationService({ workspaceId, store: f.store, execution: f.execution,
      dispatch: { sessionEventsAccepted: (events) => engine.accept(events) } });
    await engine.start({ workspaceId, sessionId: session.id, session, environment, initialEvents }, async (frame) => { frames.push(frame); });
    expect(runner.accept).toHaveBeenCalledTimes(1);
    const turn = runner.accept.mock.calls[0]![0];
    expect(turn.initialEvents).toEqual([]);
    expect(turn.historyEvents.map((event) => event.type)).toEqual(initialEvents.map((event) => event.type));
    expect(turn.events).toEqual(turn.historyEvents);
    expect(frames).toEqual([{ type: "agent.message", content: "done" }]);
    const current = await f.sessions.findCurrent({ workspaceId, sessionId: session.id });
    expect(current?.session.outcomeEvaluations).toMatchObject([{ description: "Complete the task", result: "pending" }]);
    const originals = await db.sql.prepare("SELECT document FROM managed_session_initial_events ORDER BY sequence").all<{ document: string }>();
    expect(originals.results?.map((row) => JSON.parse(row.document))).toEqual(initialEvents);
  });

  it("admits initial events once across concurrent starts and later restarts", async () => {
    const f = await fixture();
    const dispatch = { sessionEventsAccepted: vi.fn(async () => {}) };
    const create = () => new SessionInitialEventsApplicationService({ workspaceId, store: f.store, execution: f.execution, dispatch });
    const input = { sessionId: session.id, events: initialEvents };
    await Promise.all([create().initialize(input), create().initialize(input)]);
    await create().initialize(input);
    expect(dispatch.sessionEventsAccepted).toHaveBeenCalledTimes(1);
    const history = await f.source.load({ workspaceId, sessionId: session.id });
    expect(history?.initialEvents).toEqual([]);
    expect(history?.events).toHaveLength(initialEvents.length);
  });

  it("retains the saved request when admission fails so initialization can be retried", async () => {
    const f = await fixture();
    const dispatch = { sessionEventsAccepted: vi.fn(async () => {}) };
    const initializer = new SessionInitialEventsApplicationService({ workspaceId, store: f.store, execution: f.execution, dispatch });
    vi.spyOn(f.store, "append").mockRejectedValueOnce(new Error("Storage unavailable"));
    const input = { sessionId: session.id, events: initialEvents };
    await expect(initializer.initialize(input)).rejects.toThrow("Storage unavailable");
    expect(dispatch.sessionEventsAccepted).not.toHaveBeenCalled();
    expect(await f.source.load({ workspaceId, sessionId: session.id })).toMatchObject({ initialEvents, events: [] });
    await initializer.initialize(input);
    expect(dispatch.sessionEventsAccepted).toHaveBeenCalledTimes(1);
  });

  it("recovers previously empty running sessions without changing sessions with pending input", async () => {
    const f = await fixture();
    const empty = { ...session, id: "session_empty" };
    await f.sessions.insert({ workspaceId, session: empty, initialEvents: [], resourceSecrets: [] });
    expect(await recoverEmptyManagedSessions(db.sql)).toBe(1);
    expect((await f.sessions.findCurrent({ workspaceId, sessionId: empty.id }))?.session).toEqual({ ...empty, status: "idle" });
    expect((await f.sessions.findCurrent({ workspaceId, sessionId: session.id }))?.session.status).toBe("running");
    expect(await recoverEmptyManagedSessions(db.sql)).toBe(0);
  });
});
