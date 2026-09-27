import { describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema } from "ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness, resolveContextWindowTokens } from "../src/harness/default-loop";
import { emergencyCompact, estimateMessagesTokens } from "../src/harness/compaction";
import { eventsToMessages, eventsToMessagesAsync } from "../src/runtime/history";
import { mcpToModelOutput, capMcpResult } from "../src/harness/tools";
import { createScriptedLanguageModel, streamStep, textChunks, toolCallChunks, finishChunk } from "../../../test/fakes/scripted-language-model";

function history(): SessionEvent[] {
  return [
    { type: "user.message", content: [{ type: "text", text: "Read the files and doc" }] },
    { type: "agent.tool_use", id: "bash", name: "bash", input: {} },
    { type: "agent.tool_result", tool_use_id: "bash", content: "b".repeat(6_000) },
    { type: "agent.tool_use", id: "read", name: "read", input: {} },
    { type: "agent.tool_result", tool_use_id: "read", content: "r".repeat(12_000) },
    { type: "agent.mcp_tool_use", id: "doc", name: "mcp__docs__get", mcp_server_name: "docs", input: {} },
    { type: "agent.mcp_tool_result", mcp_tool_use_id: "doc", content: "d".repeat(30_000) },
    { type: "user.message", content: [{ type: "text", text: "Continue with the findings" }] },
    { type: "agent.tool_use", id: "recent", name: "read", input: {} },
    { type: "agent.tool_result", tool_use_id: "recent", content: "protected recent result" },
  ];
}

function context(events: SessionEvent[], model: HarnessContext["model"]): HarnessContext {
  const runtime = {
    history: { getEvents: () => events, getMessages: () => eventsToMessages(events) },
    sandbox: {}, broadcast: (event: SessionEvent) => events.push(event),
    ...Object.fromEntries(["broadcastStreamStart", "broadcastChunk", "broadcastStreamEnd", "broadcastThinkingStart", "broadcastThinkingChunk", "broadcastThinkingEnd", "broadcastToolInputStart", "broadcastToolInputChunk", "broadcastToolInputEnd", "reportUsage"].map(name => [name, vi.fn(async () => undefined)])),
  } as unknown as HarnessRuntime;
  return { agent: { model: "test" }, userMessage: events[0], model, tools: {}, systemPrompt: "Be helpful", env: {}, runtime } as unknown as HarnessContext;
}

describe("context safety", () => {
  it("caps MCP text per block and overall, preserving small outputs", () => {
    const small = { content: [{ type: "text", text: "hello" }], structuredContent: { answer: 42 } };
    expect(capMcpResult(small)).toEqual(small);
    const big = { content: [{ type: "text", text: "x".repeat(300_000) }] };
    const output = mcpToModelOutput({ output: big });
    expect(output.value).toEqual([{ type: "text", text: "x".repeat(50_000) + "\n...(truncated, total 300000 chars)" }]);
    const multiple = mcpToModelOutput({ output: { content: Array.from({ length: 10 }, () => ({ type: "text", text: "y".repeat(30_000) })) } });
    expect(multiple.value.reduce((n, b) => n + ("text" in b ? b.text.length : 0), 0)).toBeLessThanOrEqual(50_050);
    expect(JSON.stringify(capMcpResult({ ...big, structuredContent: { duplicate: "x".repeat(300_000) } })).length).toBeLessThan(50_200);
    expect(mcpToModelOutput({ output: { content: [{ type: "text", text: "x".repeat(50_000) }, { type: "text", text: "tail" }] } }).value).toEqual([
      { type: "text", text: "x".repeat(50_000) + "\n...(truncated, total 50004 chars)" },
    ]);
  });

  it("preserves bounded MCP images and refuses excessive binary data", () => {
    const image = { type: "image", mimeType: "image/png", data: "abcd" };
    expect(mcpToModelOutput({ output: { content: [image] } }).value[0]).toMatchObject({ type: "file", data: { data: "abcd" } });
    expect(JSON.stringify(capMcpResult({ content: [{ ...image, data: "b".repeat(2_000_001) }] }))).not.toContain("b".repeat(100));
    const multiple = capMcpResult({ content: [{ ...image, data: "a".repeat(1_200_000) }, { ...image, data: "b".repeat(1_200_000) }] });
    expect(JSON.stringify(multiple)).toContain("exceeds binary size limit");
    expect(JSON.stringify(multiple).length).toBeLessThan(1_201_000);
  });

  it("prefers the card limit and respects a smaller provider capacity", () => {
    expect(resolveContextWindowTokens({ modelId: "claude-opus-5-5", maxInputTokens: 80_000 } as never)).toBe(80_000);
    expect(resolveContextWindowTokens({ modelId: "claude-opus-5-5", maxInputTokens: 300_000, contextWindow: 128_000 } as never)).toBe(128_000);
    expect(resolveContextWindowTokens({ modelId: "claude-opus-5-5", maxInputTokens: null } as never)).toBe(200_000);
  });

  it("persists largest-first elisions outside the protected tail and replays them identically", async () => {
    const events = history();
    const original = JSON.stringify(events);
    const boundary = emergencyCompact(events, { contextWindowTokens: 5_000 });
    expect(boundary).not.toBeNull();
    expect(JSON.stringify(events)).toBe(original);
    events.push(boundary!);
    const messages = eventsToMessages(events);
    expect(estimateMessagesTokens(messages)).toBeLessThan(3_750);
    const served = JSON.stringify(messages);
    expect(served).toContain("[tool result elided during compaction: 30000 chars; re-run the tool if needed]");
    expect(served).toContain("[tool result elided during compaction: 12000 chars; re-run the tool if needed]");
    expect(served).toContain("b".repeat(6_000));
    expect(served).toContain("protected recent result");
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(messages);
    expect(emergencyCompact(events, { contextWindowTokens: 5_000 })).toBeNull();
  });

  it("recovers an empty length response once using durable emergency compaction", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([finishChunk("length")]),
      streamStep([...textChunks("answer", ["Recovered"]), finishChunk("stop")]),
    ]);
    const events = history();
    Object.assign(scripted.model, { contextWindow: 20_000 });
    await new DefaultHarness().run(context(events, scripted.model));
    expect(scripted.calls).toHaveLength(2);
    expect(JSON.stringify(scripted.calls[1])).toContain("tool result elided during compaction");
    expect(events.some(e => e.type === "agent.thread_context_compacted")).toBe(true);
    expect(events.some(e => e.type === "agent.message" && JSON.stringify(e).includes("Recovered"))).toBe(true);
  });

  it("gives an actionable terminal error after the single length retry", async () => {
    const scripted = createScriptedLanguageModel([streamStep([finishChunk("length")]), streamStep([finishChunk("length")])]);
    await expect(new DefaultHarness().run(context(history(), scripted.model))).rejects.toThrow(/context exceeded the model window.*session must be reset/);
    expect(scripted.calls).toHaveLength(2);
  });

  it("checks compaction after tools and stores capped MCP event content", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([...toolCallChunks({ id: "call", toolName: "mcp__docs__get", inputDeltas: ["{}"] }), finishChunk("tool-calls")]),
      streamStep([...textChunks("answer", ["Done"]), finishChunk("stop")]),
    ]);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "Get doc" }] }];
    const ctx = context(events, scripted.model);
    ctx.tools = { mcp__docs__get: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ({ content: [{ type: "text", text: "x".repeat(300_000) }] }), toModelOutput: mcpToModelOutput }) };
    const harness = new DefaultHarness();
    const checkedResults: boolean[] = [];
    const shouldCompact = harness.shouldCompact.bind(harness);
    vi.spyOn(harness, "shouldCompact").mockImplementation((es, opts) => {
      checkedResults.push(es.some(e => e.type === "agent.mcp_tool_result"));
      return shouldCompact(es, opts);
    });
    await harness.run(ctx);
    expect(checkedResults).toEqual([false, true]);
    const event = events.find(e => e.type === "agent.mcp_tool_result")!;
    expect(JSON.stringify(event).length).toBeLessThan(50_300);
    expect(JSON.stringify(event)).toContain("...(truncated, total 300000 chars)");
    expect(JSON.stringify(scripted.calls[1]).length).toBeLessThan(52_000);
    const replay = eventsToMessages(events).filter(message => message.role === "tool");
    expect(JSON.stringify(replay).length).toBeLessThan(51_000);
    expect(JSON.stringify(replay)).toContain("...(truncated, total 300000 chars)");
  });

  it("compacts mid-turn and keeps subsequent SDK steps on the reduced context", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([...toolCallChunks({ id: "one", toolName: "read", inputDeltas: ["{}"] }), finishChunk("tool-calls")]),
      streamStep([...toolCallChunks({ id: "two", toolName: "read", inputDeltas: ["{}"] }), finishChunk("tool-calls")]),
      streamStep([...textChunks("answer", ["Finished"]), finishChunk("stop")]),
    ]);
    Object.assign(scripted.model, { contextWindow: 5_000 });
    let summaries = 0;
    scripted.model.doGenerate = async () => {
      summaries++;
      return { content: [{ type: "text", text: "Read the document; continue." }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] } as never;
    };
    const events: SessionEvent[] = [
      ...history().slice(0, 1),
      { type: "agent.message", content: [{ type: "text", text: "Ready" }] },
      { type: "user.message", content: [{ type: "text", text: "Proceed" }] },
    ];
    const ctx = context(events, scripted.model);
    let executions = 0;
    ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ++executions === 1 ? "z".repeat(16_000) : "small result" }) };
    await new DefaultHarness().run(ctx);
    expect(summaries).toBe(1);
    expect(scripted.calls).toHaveLength(3);
    for (const call of scripted.calls.slice(1)) {
      expect(JSON.stringify(call).includes("z".repeat(100))).toBe(false);
      expect(JSON.stringify(call)).toContain("Read the document; continue.");
    }
  });

  it.each(["prompt is too long", "finish_reason=length with empty output"])("elides durably when summarization fails: %s", async failure => {
    const scripted = createScriptedLanguageModel([streamStep([...textChunks("answer", ["Recovered"]), finishChunk("stop")])]);
    Object.assign(scripted.model, { contextWindow: 15_000 });
    let summaries = 0;
    scripted.model.doGenerate = async () => {
      summaries++;
      if (summaries === 1 && !failure.startsWith("prompt")) {
        return { content: [], finishReason: { unified: "length", raw: "length" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] } as never;
      }
      return { content: [{ type: "text", text: "Summary after elision" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] } as never;
    };
    const events = history();
    const harness = new DefaultHarness();
    // Inject request rejection at the compaction boundary. The empty-length
    // variant above exercises the real generateText result path as well.
    if (failure.startsWith("prompt")) vi.spyOn(harness, "compact").mockRejectedValueOnce(new Error(failure));
    await harness.run(context(events, scripted.model));
    expect(summaries).toBe(failure.startsWith("prompt") ? 1 : 2);
    expect(events.some(e => e.metadata?.kind === "tool_result_elision")).toBe(true);
    expect(JSON.stringify(scripted.calls[0]).includes("d".repeat(100))).toBe(false);
  });

  it("elides an overflow before asking the summarizer to process it", async () => {
    const scripted = createScriptedLanguageModel([streamStep([...textChunks("answer", ["Alive"]), finishChunk("stop")])]);
    Object.assign(scripted.model, { contextWindow: 5_000 });
    const events = history();
    let calls = 0;
    scripted.model.doGenerate = async options => {
      calls++;
      expect(JSON.stringify(options.prompt).length / 4).toBeLessThan(5_000);
      expect(events.some(e => e.metadata?.kind === "tool_result_elision")).toBe(true);
      return { content: [{ type: "text", text: "Recovered summary" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] } as never;
    };
    await new DefaultHarness().run(context(events, scripted.model));
    expect(calls).toBe(1);
    expect(JSON.stringify(scripted.calls[0]).length / 4).toBeLessThan(5_000);
  });

  it("does not summarize twice on a retry without new context events", async () => {
    const scripted = createScriptedLanguageModel([streamStep([finishChunk("length")]), streamStep([...textChunks("answer", ["Alive"]), finishChunk("stop")])]);
    const ctx = context(history().slice(0, 1), scripted.model);
    const getEvents = ctx.runtime.history.getEvents;
    // Both durable implementations deserialize fresh objects on reads.
    ctx.runtime.history.getEvents = () => structuredClone(getEvents());
    const harness = new DefaultHarness();
    vi.spyOn(harness, "shouldCompact").mockReturnValue(true);
    const compact = vi.spyOn(harness, "compact").mockResolvedValue(undefined);
    await harness.run(ctx);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(scripted.calls).toHaveLength(2);
  });

  it("protects the active user interaction even when its result exceeds the tail budget", () => {
    const events = history().slice(0, 3);
    expect(emergencyCompact(events, { contextWindowTokens: 1_000, force: true })).toBeNull();
  });

  it("does not resurrect summarized results when an elision shrinks a historical tail", async () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "Old request" }] },
      { type: "agent.tool_use", id: "discarded", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "discarded", content: "discarded data".repeat(2_000) },
      { type: "user.message", content: [{ type: "text", text: "Recent request" }] },
      { type: "agent.tool_use", id: "retained", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "retained", content: "r".repeat(5_000) },
      { type: "agent.thread_context_compacted", original_message_count: 6, compacted_message_count: 4,
        summary: [{ type: "text", text: "Earlier work summary" }],
        metadata: { preserved_tail: { minTokens: 0, maxTokens: 2_000, minMessages: 1 } } },
      { type: "user.message", content: [{ type: "text", text: "Continue now" }] },
    ];
    expect(JSON.stringify(eventsToMessages(events))).not.toContain("discarded data");
    const boundary = emergencyCompact(events, { contextWindowTokens: 1_000 });
    expect(boundary).not.toBeNull();
    events.push(boundary!);
    const served = eventsToMessages(events);
    expect(JSON.stringify(served)).not.toContain("discarded data");
    expect(estimateMessagesTokens(served)).toBeLessThan(750);
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(served);
  });
});
