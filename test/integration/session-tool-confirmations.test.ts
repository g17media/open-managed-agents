// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteHistory } from "../../apps/agent/src/runtime/history";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";
import { createScriptedMcpServer } from "../fakes/scripted-mcp-server";
import { registerHarness } from "../../apps/agent/src/harness/registry";

registerHarness("pending-confirmations-regression", () => ({
  async run(ctx) {
    const prior = ctx.runtime.history.getEvents();
    if (prior.some(e => e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use" || e.type === "agent.custom_tool_use")) {
      ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "resumed" }] });
      return;
    }
    const custom = ctx.agent.name === "custom-confirmation";
    const calls = custom
      ? [{ type: "agent.custom_tool_use", id: "custom_1", name: "bash", input: {} }]
      : [{ type: "agent.tool_use", id: "builtin_1", name: "read", input: { file_path: "/tmp/test" }, evaluated_permission: "ask", evaluation: { type: "always_ask" } },
         { type: "agent.mcp_tool_use", id: "mcp_2", name: "mcp_test_echo", mcp_server_name: "test", input: {}, evaluated_permission: "ask", evaluation: { type: "always_ask" } }];
    for (const call of calls) ctx.runtime.broadcast(call);
    ctx.runtime.pendingConfirmations.push(...calls.map(e => e.id));
  },
}));
const headers = { "anthropic-beta": "managed-agents-2026-04-01", "x-api-key": "test-key", "Content-Type": "application/json" };
const api = (path, body) => exports.default.fetch(new Request(`http://localhost/v1${path}`, {
  headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
}));
async function fixture(custom = false) {
  const agent = await (await api("/agents", { name: custom ? "custom-confirmation" : "confirmation", model: "claude-sonnet-4-6", system: "" })).json();
  const environment = await (await api("/environments", { name: "confirm-test", config: { type: "cloud" } })).json();
  expect(agent.id, JSON.stringify(agent)).toBeTypeOf("string");
  expect(environment.id, JSON.stringify(environment)).toBeTypeOf("string");
  const session = await (await api("/sessions", { agent: agent.id, environment_id: environment.id })).json();
  expect(session.id, JSON.stringify(session)).toBeTypeOf("string");
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  // The public agent contract intentionally excludes the local test harness;
  // select it on the initialized DO snapshot before sending the real event.
  await runInDurableObject(stub, instance => {
    expect(instance.state.agent_snapshot).toBeDefined();
    instance.setState({ ...instance.state, agent_snapshot: { ...instance.state.agent_snapshot, harness: "pending-confirmations-regression" } });
  });
  const accepted = await api(`/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] });
  expect(accepted.status, await accepted.text()).toBe(200);
  await vi.waitFor(async () => {
    const pending = await runInDurableObject(stub, instance => instance.state.pending_tool_calls);
    expect(pending).toHaveLength(custom ? 1 : 2);
  }, { timeout: 10_000, interval: 50 });
  await vi.waitFor(async () => {
    const stored = await (await api(`/sessions/${session.id}`)).json();
    expect(stored.stop_reason?.type, JSON.stringify(stored)).toBe("requires_action");
  }, { timeout: 5000, interval: 50 }).catch(async error => {
    console.log("confirmation fixture events", await runInDurableObject(stub, (_i, state) => new SqliteHistory(state.storage.sql).getEvents().filter(e => e.type === "session.status_idle")));
    throw error;
  });
  return { stub, id: session.id };
}
const send = (stub, event) => stub.fetch(new Request("http://internal/event", { method: "POST", headers, body: JSON.stringify(event) }));

describe("DO pending confirmations", () => {
  it("restores MCP calls, rejects unknown IDs and waits for every answer", async () => {
    const { stub, id } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.processUserMessage({ type: "user.message", content: [{ type: "text", text: "additional context" }] });
      expect(instance.state.pending_tool_calls.map(p => p.toolCallId)).toEqual(["builtin_1", "mcp_2"]);
      expect(new SqliteHistory(state.storage.sql).getEvents().filter(e => e.type === "agent.message")).toEqual([]);
    });
    const invalid = await send(stub, { type: "user.tool_confirmation", tool_use_id: "unknown", result: "allow" });
    expect(invalid.status).toBe(400);
    expect((await api(`/sessions/${id}/events`, { events: [{ type: "user.tool_confirmation", tool_use_id: "unknown", result: "allow" }] })).status).toBe(400);
    const initial = await (await api(`/sessions/${id}`)).json();
    expect(initial.stop_reason).toEqual({ type: "requires_action", action_type: "tool_confirmation", event_ids: ["builtin_1", "mcp_2"] });
    expect((await send(stub, { type: "user.tool_confirmation", tool_use_id: "builtin_1", result: "deny", deny_message: "keep private" })).status).toBe(202);
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, i => i.state.pending_tool_calls.map(p => p.toolCallId))).toEqual(["mcp_2"]);
    });
    await vi.waitFor(async () => {
      const partial = await (await api(`/sessions/${id}`)).json();
      expect(partial.stop_reason).toEqual({ type: "requires_action", action_type: "tool_confirmation", event_ids: ["mcp_2"] });
    });
    await send(stub, { type: "user.tool_confirmation", tool_use_id: "mcp_2", result: "deny" });
    await vi.waitFor(async () => {
      const response = await (await api(`/sessions/${id}`)).json();
      expect(response.stop_reason).toEqual({ type: "end_turn" });
    }, { timeout: 5000 });
    const events = await (await api(`/sessions/${id}/events`)).json();
    expect(events.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent.tool_result", tool_use_id: "builtin_1", content: [{ type: "text", text: "Denied: keep private" }], is_error: true }),
      expect.objectContaining({ type: "agent.mcp_tool_result", mcp_tool_use_id: "mcp_2", is_error: true }),
    ]));
    expect(events.data.filter(e => e.type === "agent.message")).toHaveLength(1);
  }, 30_000);

  it("rejects duplicate queued answers and preserves the pending action on interrupt", async () => {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(`duplicate-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      instance.setState({ ...instance.state, pending_tool_calls: [{ eventType: "agent.tool_use", toolCallId: "queued_1", toolName: "read", args: {} }] });
      const drain = vi.spyOn(instance, "drainEventQueue").mockResolvedValue();
      const schedule = vi.spyOn(instance, "schedule").mockResolvedValue();
      try {
        const request = id => new Request("http://internal/event", { method: "POST", headers, body: JSON.stringify({ type: "user.tool_confirmation", id, tool_use_id: "queued_1", result: "allow" }) });
        expect((await instance.fetch(request("answer-1"))).status).toBe(202);
        expect((await instance.fetch(request("answer-2"))).status).toBe(400);
        expect((await instance.fetch(request("answer-1"))).status).toBe(202);
        await instance.fetch(new Request("http://internal/event", { method: "POST", headers, body: JSON.stringify({ type: "user.interrupt" }) }));
        const idle = new SqliteHistory(state.storage.sql).getEvents().filter(e => e.type === "session.status_idle").at(-1);
        expect(idle.stop_reason).toEqual({ type: "requires_action", action_type: "tool_confirmation", event_ids: ["queued_1"] });
      } finally { drain.mockRestore(); schedule.mockRestore(); }
    });
  });

  it("executes allowed built-in and MCP calls once, then resumes after both answers", async () => {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(`allow-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async instance => {
      const sandbox = new TestSandbox();
      const reads = vi.spyOn(sandbox, "readFile");
      const makeServer = () => createScriptedMcpServer({
        sessionId: "confirm-mcp", tools: [{ name: "echo", inputSchema: { type: "object" } }],
        callTool: () => ({ content: [{ type: "text", text: "confirmed echo" }] }),
      });
      let fake = makeServer();
      const agent = {
        id: "confirmation-agent", name: "confirm", model: "claude-sonnet-4-6", system: "",
        tools: [
          { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_ask" } } },
          { type: "mcp_toolset", mcp_server_name: "test", default_config: { enabled: true, permission_policy: { type: "always_ask" } } },
        ],
        mcp_servers: [{ name: "test", type: "url", url: "https://mcp.example.test/rpc" }],
      };
      const resume = vi.spyOn(instance, "processUserMessage").mockResolvedValue();
      vi.spyOn(instance, "getAgentConfig").mockResolvedValue(agent);
      vi.spyOn(instance, "getOrCreateSandbox").mockReturnValue(sandbox);
      vi.spyOn(instance, "warmUpSandbox").mockResolvedValue();
      vi.spyOn(instance, "broadcastEvent").mockImplementation(() => {});
      const originalEnv = instance.env;
      instance.env = { ...originalEnv, MAIN_MCP: { fetch: async request => {
        // The scripted server models one session; discovery after disposal
        // starts a fresh server session just as the remote endpoint would.
        if (request.method === "POST" && (await request.clone().json()).method === "initialize") fake = makeServer();
        return fake.fetch(request);
      } } };
      instance.setState({ ...instance.state, session_id: "confirm-session", tenant_id: "test", agent_id: agent.id, pending_tool_calls: [
        { eventType: "agent.tool_use", toolCallId: "read_1", toolName: "read", args: { file_path: "/tmp/test" } },
        { eventType: "agent.mcp_tool_use", toolCallId: "echo_2", toolName: "mcp__test__echo", args: {} },
      ] });
      const events = [];
      const history = { append: event => events.push(event) };
      try {
        await instance.handleToolConfirmation({ type: "user.tool_confirmation", tool_use_id: "read_1", result: "allow" }, history);
        expect(reads).toHaveBeenCalledTimes(1);
        expect(resume).not.toHaveBeenCalled();
        await instance.handleToolConfirmation({ type: "user.tool_confirmation", tool_use_id: "echo_2", result: "allow" }, history);
        expect(fake.state.counts["tools/call"]).toBe(1);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.mcp_tool_result", mcp_tool_use_id: "echo_2", content: expect.stringContaining("confirmed echo") })]));
        expect(resume).toHaveBeenCalledTimes(1);
        await instance.handleToolConfirmation({ type: "user.tool_confirmation", tool_use_id: "echo_2", result: "allow" }, history);
        expect(fake.state.counts["tools/call"]).toBe(1);
        expect(resume).toHaveBeenCalledTimes(1);
      } finally {
        instance.env = originalEnv;
        vi.restoreAllMocks();
      }
    });
  }, 30_000);

  it("uses event provenance for client tools with built-in names", async () => {
    const { stub, id } = await fixture(true);
    // Simulate a paused session persisted by an older DO version.
    await runInDurableObject(stub, instance => {
      instance.setState({ ...instance.state, pending_tool_calls: instance.state.pending_tool_calls.map(({ eventType, ...call }) => call) });
      expect(instance.pendingToolStopReason()).toEqual({ type: "requires_action", action_type: "custom_tool_result", event_ids: ["custom_1"] });
    });
    const session = await (await api(`/sessions/${id}`)).json();
    expect(session.stop_reason).toEqual({ type: "requires_action", action_type: "custom_tool_result", event_ids: ["custom_1"] });
    expect((await send(stub, { type: "user.tool_confirmation", tool_use_id: "custom_1", result: "allow" })).status).toBe(400);
    await send(stub, { type: "user.custom_tool_result", custom_tool_use_id: "custom_1", content: [{ type: "text", text: "client output" }] });
    await vi.waitFor(async () => expect(await runInDurableObject(stub, i => i.state.pending_tool_calls)).toEqual([]));
  }, 30_000);
});

it("accepts confirmation after the ask event is emitted while the harness is still running", async () => {
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(`early-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    // A real running turn has already passed the first-fetch recovery scan.
    instance.ensureSchema();
    await instance.recoverInterruptedState();
    instance._coldStartFlushDone = true;
    const history = new SqliteHistory(state.storage.sql);
    history.append({ type: "session.status_running" });
    history.append({ type: "agent.tool_use", id: "early_ask", name: "bash", input: {}, evaluated_permission: "ask", evaluation: { type: "always_ask" } });
    // This is the real state between broadcast(tool_use) and harness.run returning.
    expect(instance.state.pending_tool_calls).toEqual([]);
    const drain = vi.spyOn(instance, "drainEventQueue").mockResolvedValue();
    const schedule = vi.spyOn(instance, "schedule").mockResolvedValue();
    try {
      const response = await instance.fetch(new Request("http://internal/event", { method: "POST", headers, body: JSON.stringify({ type: "user.tool_confirmation", tool_use_id: "early_ask", result: "deny" }) }));
      expect(response.status, JSON.stringify({ body: await response.text(), events: history.getEvents(), pending: instance.state.pending_tool_calls })).toBe(202);
    } finally { drain.mockRestore(); schedule.mockRestore(); }
  });
});
