import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema } from "ai";
import { ModelError, type SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { eventsToMessages } from "../src/runtime/history";
import { createScriptedLanguageModel, requestErrorStep, streamStep, textChunks, toolCallChunks, finishChunk } from "../../../test/fakes/scripted-language-model";

// Reject before a complete step, which makes AI SDK's result promises reject
// with NoOutputGeneratedError while onError receives the provider diagnostic.
function contextRejection(message: string) {
  return requestErrorStep(new Error(message));
}

function context(model: HarnessContext["model"]): HarnessContext {
  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "Read previous data" }] },
    { type: "agent.tool_use", id: "old", name: "read", input: {} },
    { type: "agent.tool_result", tool_use_id: "old", content: "old result ".repeat(2_000) },
    { type: "user.message", content: [{ type: "text", text: "Continue" }] },
  ];
  const runtime = {
    history: { getEvents: () => events, getMessages: () => eventsToMessages(events) },
    sandbox: {}, broadcast: (event: SessionEvent) => events.push(event),
    ...Object.fromEntries(["broadcastStreamStart", "broadcastChunk", "broadcastStreamEnd", "broadcastThinkingStart", "broadcastThinkingChunk", "broadcastThinkingEnd", "broadcastToolInputStart", "broadcastToolInputChunk", "broadcastToolInputEnd", "reportUsage"].map(name => [name, vi.fn(async () => undefined)])),
  } as unknown as HarnessRuntime;
  return { agent: { model: "test" }, userMessage: events.at(-1), model, tools: {}, systemPrompt: "Be helpful", env: {}, runtime } as unknown as HarnessContext;
}

describe("context request rejection recovery", () => {
  // workerd's diagnostics_channel tracePromise emits an unrelated unhandled
  // rejection on failed provider calls. Disable just that telemetry adapter;
  // request execution, SDK error handling, and harness recovery stay real.
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  let builtins: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    builtins = vi.spyOn(process, "getBuiltinModule").mockImplementation((id) =>
      id === "node:diagnostics_channel" ? undefined : getBuiltinModule(id));
  });
  afterAll(() => builtins.mockRestore());

  it("recovers when the SDK hides a provider context rejection behind NoOutputGeneratedError", async () => {
    const scripted = createScriptedLanguageModel([
      contextRejection("prompt is too long: 246000 tokens > 200000 maximum"),
      streamStep([...textChunks("answer", ["Recovered"]), finishChunk("stop")]),
    ]);
    Object.assign(scripted.model, { contextWindow: 20_000 });
    const ctx = context(scripted.model);
    await new DefaultHarness().run(ctx);
    expect(scripted.calls).toHaveLength(2);
    expect(JSON.stringify(scripted.calls[1])).toContain("tool result elided during compaction");
    expect(JSON.stringify(scripted.calls[1])).not.toContain("old result ".repeat(100));
    expect(ctx.runtime.history.getEvents().some(event => event.type === "agent.message" && JSON.stringify(event).includes("Recovered"))).toBe(true);
  });

  it("limits rejected oversized requests to one retry and returns the reset instruction", async () => {
    const scripted = createScriptedLanguageModel([
      contextRejection("prompt is too long"),
      contextRejection("prompt is too long"),
    ]);
    const run = new DefaultHarness().run(context(scripted.model));
    await expect(run).rejects.toThrow(/context exceeded the model window.*session must be reset/);
    await expect(run).rejects.toBeInstanceOf(ModelError);
    expect(scripted.calls).toHaveLength(2);
  });

  it("caps injected MCP success without a toModelOutput hook before the next request", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([...toolCallChunks({ id: "large", toolName: "mcp__docs__get", inputDeltas: ["{}"] }), finishChunk("tool-calls")]),
      streamStep([...textChunks("answer", ["Done"]), finishChunk("stop")]),
    ]);
    const ctx = context(scripted.model);
    ctx.tools = { mcp__docs__get: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ({ content: [{ type: "text", text: "x".repeat(313_478) }] }) }) };
    await new DefaultHarness().run(ctx);
    expect(JSON.stringify(scripted.calls[1]).length).toBeLessThan(74_000);
    expect(JSON.stringify(scripted.calls[1])).toContain("...(truncated, total 313478 chars)");
  });

  it("caps thrown MCP errors in durable events and the next live request", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([...toolCallChunks({ id: "failure", toolName: "mcp__docs__get", inputDeltas: ["{}"] }), finishChunk("tool-calls")]),
      streamStep([...textChunks("answer", ["Reported error"]), finishChunk("stop")]),
    ]);
    const ctx = context(scripted.model);
    ctx.tools = { mcp__docs__get: dynamicTool({
      inputSchema: jsonSchema({ type: "object" }),
      execute: async () => { throw new Error("large diagnostic ".repeat(20_000)); },
    }) };
    await new DefaultHarness().run(ctx);
    const event = ctx.runtime.history.getEvents().find(event => event.type === "agent.mcp_tool_result");
    expect(JSON.stringify(event).length).toBeLessThan(50_300);
    expect(JSON.stringify(event)).toContain("...(truncated, total");
    expect(scripted.calls).toHaveLength(2);
    expect(JSON.stringify(scripted.calls[1]).length).toBeLessThan(74_000);
    expect(JSON.stringify(scripted.calls[1])).toContain("...(truncated, total");
  });
});
