import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { buildTools } from "../src/harness/tools";
import { TestSandbox } from "../src/runtime/sandbox";
import { createScriptedLanguageModel, finishChunk, streamStep, textChunks, toolCallChunks } from "../../../test/fakes/scripted-language-model";

function setup(policy: "always_allow" | "always_ask" | "auto", names: string[]) {
  const scripted = createScriptedLanguageModel([
    streamStep([...names.flatMap((toolName, i) => toolCallChunks({ id: `call_${i}`, toolName, inputDeltas: ['{"value":"test"}'] })), finishChunk("tool-calls")]),
    streamStep([...textChunks("done", ["Done"]), finishChunk("stop")]),
  ]);
  const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "use tools" }] }];
  const runtime = {
    history: { getEvents: () => events, getMessages: () => [], append: (e: SessionEvent) => events.push(e) },
    sandbox: {}, broadcast: (e: SessionEvent) => events.push(e),
    ...Object.fromEntries(["broadcastStreamStart", "broadcastChunk", "broadcastStreamEnd", "broadcastThinkingStart", "broadcastThinkingChunk", "broadcastThinkingEnd", "broadcastToolInputStart", "broadcastToolInputChunk", "broadcastToolInputEnd"].map(k => [k, vi.fn(async () => {})])),
    // Deliberately absent: self-host runtimes need not initialize this optional field.
  } as unknown as HarnessRuntime;
  const ctx = {
    agent: { id: "agent", model: scripted.model.modelId, tools: [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: policy } } },
      { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: policy } } },
      { type: "custom", name: "client", input_schema: { type: "object" } },
    ] },
    tools: Object.fromEntries(names.map(name => [name, {
      inputSchema: z.object({ value: z.string() }),
      ...(policy !== "always_ask" && name !== "client" ? { execute: async () => "ok" } : {}),
    }])),
    runtime, model: scripted.model, systemPrompt: "Use tools", userMessage: events[0], env: {}, session_id: "session",
  } as unknown as HarnessContext;
  return { ctx, events };
}

describe("tool permission events", () => {
  it.each(["bash", "mcp__docs__create"])("reports ask and pending id for %s", async name => {
    const { ctx, events } = setup("always_ask", [name]);
    await new DefaultHarness().run(ctx);
    expect(events).toContainEqual(expect.objectContaining({ id: "call_0", name, evaluated_permission: "ask", evaluation: { type: "always_ask" } }));
    expect(ctx.runtime.pendingConfirmations).toEqual(["call_0"]);
    expect(events.some(e => e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result")).toBe(false);
  });
  it.each(["always_allow", "auto"] as const)("executes %s calls and reports allow", async policy => {
    const { ctx, events } = setup(policy, ["bash", "mcp__docs__create"]);
    await new DefaultHarness().run(ctx);
    const uses = events.filter(e => e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use");
    expect(uses).toHaveLength(2);
    for (const use of uses) expect(use).toMatchObject({ evaluated_permission: "allow", ...(policy === "always_allow" ? { evaluation: { type: policy } } : {}) });
    expect(ctx.runtime.pendingConfirmations ?? []).toEqual([]);
  });
  it("keeps parallel pending calls in issue order, including client tools", async () => {
    const { ctx, events } = setup("always_ask", ["mcp__docs__create", "bash", "client"]);
    await new DefaultHarness().run(ctx);
    expect(ctx.runtime.pendingConfirmations).toEqual(["call_0", "call_1", "call_2"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.custom_tool_use", id: "call_2" }));
  });
});


it("rebuilds executable confirmed tools without dropping pending tool metadata", async () => {
  const { ctx } = setup("always_ask", ["bash"]);
  const pending = await buildTools(ctx.agent, new TestSandbox());
  expect(pending.bash.execute).toBeUndefined();
  const confirmed = await buildTools(ctx.agent, new TestSandbox(), { skipPermissionCheck: true });
  expect(confirmed.bash.execute).toBeTypeOf("function");
});


it.each(["always_allow", "always_ask"] as const)("does not ask again after a %s tool error", async policy => {
  const { ctx, events } = setup(policy, ["bash"]);
  ctx.tools.bash = policy === "always_allow"
    ? { inputSchema: z.object({ value: z.string() }), execute: async () => { throw new Error("execution failed"); } }
    : { inputSchema: z.object({ value: z.number() }) };
  await new DefaultHarness().run(ctx);
  expect(events).toContainEqual(expect.objectContaining({ type: "agent.tool_result", tool_use_id: "call_0" }));
  expect(ctx.runtime.pendingConfirmations ?? []).toEqual([]);
});
