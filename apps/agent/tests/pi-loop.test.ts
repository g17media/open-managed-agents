import { describe, expect, it, vi } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { PiCompactionPolicy } from "../src/harness/pi-compaction";
import { PiSummaryCompactionPolicy } from "../src/harness/pi-compaction";
import { buildTools } from "../src/harness/tools";
import { TestSandbox } from "../src/runtime/sandbox";
import { PiHarness } from "../src/harness/pi-loop";
import { createPiModelRuntime } from "../src/harness/pi-provider";

function makeContext(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);

  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "echo hello" }] },
  ];
  const streamCalls = {
    messageStarts: [] as string[],
    messageChunks: [] as Array<[string, string]>,
    messageEnds: [] as string[],
    thinkingStarts: [] as string[],
    thinkingEnds: [] as string[],
    toolStarts: [] as string[],
    toolEnds: [] as string[],
  };

  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async (id: string) => void streamCalls.messageStarts.push(id)),
    broadcastChunk: vi.fn(async (id: string, delta: string) => void streamCalls.messageChunks.push([id, delta])),
    broadcastStreamEnd: vi.fn(async (id: string) => void streamCalls.messageEnds.push(id)),
    broadcastThinkingStart: vi.fn(async (id: string) => void streamCalls.thinkingStarts.push(id)),
    broadcastThinkingChunk: vi.fn(async () => undefined),
    broadcastThinkingEnd: vi.fn(async (id: string) => void streamCalls.thinkingEnds.push(id)),
    broadcastToolInputStart: vi.fn(async (id: string) => void streamCalls.toolStarts.push(id)),
    broadcastToolInputChunk: vi.fn(async () => undefined),
    broadcastToolInputEnd: vi.fn(async (id: string) => void streamCalls.toolEnds.push(id)),
    reportUsage: vi.fn(async () => undefined),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  const echo = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));
  const ctx = {
    agent: { id: "agent-test", model: faux.getModel().id },
    userMessage: events[0],
    session_id: "session-test",
    tools: {
      echo: {
        description: "Echo a value",
        inputSchema: z.object({ value: z.string() }),
        execute: echo,
      },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "You are concise.",
    env: { ANTHROPIC_API_KEY: "unused" },
    runtime,
  } as unknown as HarnessContext;

  return { ctx, events, streamCalls, echo, faux };
}

describe("PiHarness", () => {
  // The converter matrix covers input shapes; this catches a replay path
  // bypassing conversion or its aggregate binary budget before model delivery.
  it("replays mixed images in order and omits an image over the shared budget", async () => {
    const { ctx, events, faux } = makeContext([]);
    const data = "a".repeat(1_000_000);
    events.push(
      { type: "agent.tool_use", id: "images", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "images", content: [
        { type: "text", text: "before" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: "between" },
        { type: "image", source: { type: "base64", media_type: "image/webp", data } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "after" },
      ] },
    );
    let served: unknown;
    faux.setResponses([context => {
      served = context.messages.find(message => message.role === "toolResult");
      return fauxAssistantMessage("Done");
    }]);
    await new PiHarness({ compaction: { name: "replay-only", shouldCompact: () => false, compact: async () => null } }).run(ctx);
    expect(served).toMatchObject({ content: [
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/jpeg", data },
      { type: "text", text: "between" },
      { type: "image", mimeType: "image/webp", data },
      { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" },
      { type: "text", text: "after" },
    ] });
  });

  it("preserves client tools whose names begin with the MCP prefix", async () => {
    const name = "mcp__client__answer";
    const { ctx, events } = makeContext([fauxAssistantMessage(fauxToolCall(name, {}, { id: "client_mcp" }), { stopReason: "toolUse" })]);
    ctx.agent.tools = [{ type: "custom", name, description: "Client answer", input_schema: { type: "object" } }];
    ctx.tools = await buildTools(ctx.agent, new TestSandbox());
    await new PiHarness().run(ctx);
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.custom_tool_use", id: "client_mcp" }));
    expect(events.some(event => event.type === "agent.mcp_tool_use")).toBe(false);
    expect(ctx.runtime.pendingConfirmations).toEqual(["client_mcp"]);
  });

  it("reports an unknown MCP tool as a tool error without crashing event translation", async () => {
    const { ctx, events } = makeContext([
      fauxAssistantMessage(fauxToolCall("mcp__missing__tool", {}, { id: "missing" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("That tool is unavailable"),
    ]);
    await new PiHarness().run(ctx);
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.mcp_tool_result", mcp_tool_use_id: "missing", is_error: true }));
    expect(ctx.runtime.pendingConfirmations).toEqual([]);
  });

  it.each(["bash", "mcp__docs__create"])("reports pending permission for %s", async (name) => {
    const { ctx, events } = makeContext([fauxAssistantMessage(fauxToolCall(name, { value: "confirm" }, { id: "pending" }), { stopReason: "toolUse" })]);
    ctx.agent.tools = [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_ask" } } },
      { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "always_ask" } } },
    ];
    ctx.tools = { [name]: { inputSchema: z.object({ value: z.string() }) } };
    await new PiHarness().run(ctx);
    expect(events).toContainEqual(expect.objectContaining({
      type: name.startsWith("mcp__") ? "agent.mcp_tool_use" : "agent.tool_use",
      id: "pending", evaluated_permission: "ask", evaluation: { type: "always_ask" },
    }));
    expect(ctx.runtime.pendingConfirmations).toEqual(["pending"]);
  });

  it("lists every parallel pending tool and identifies client tools", async () => {
    const { ctx, events } = makeContext([fauxAssistantMessage([
      fauxToolCall("mcp__docs__create", { value: "one" }, { id: "mcp" }),
      fauxToolCall("bash", { value: "two" }, { id: "bash" }),
      fauxToolCall("client", { value: "three" }, { id: "client" }),
    ], { stopReason: "toolUse" })]);
    ctx.agent.tools = [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_ask" } } },
      { type: "custom", name: "client", description: "client tool", input_schema: { type: "object" } },
    ];
    ctx.tools = Object.fromEntries(["mcp__docs__create", "bash", "client"].map(name => [name, { inputSchema: z.object({ value: z.string() }) }]));
    await new PiHarness().run(ctx);
    expect(ctx.runtime.pendingConfirmations).toEqual(["mcp", "bash", "client"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.custom_tool_use", id: "client" }));
    expect(events.some(event => event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result")).toBe(false);
  });

  it.each([false, true])("bounds live Pi MCP results and errors: %s", async throws => {
    const name = "mcp__docs__get";
    const { ctx, events, faux } = makeContext([]);
    let served: unknown;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, {}, { id: "large" }), { stopReason: "toolUse" }),
      context => {
        served = context.messages.find(message => message.role === "toolResult");
        return fauxAssistantMessage("Done");
      },
    ]);
    ctx.tools = { [name]: { inputSchema: z.object({}), execute: async () => {
      if (throws) throw new Error("x".repeat(313_478));
      return { content: [
        { type: "text", text: "x".repeat(313_478) },
        { type: "image", mimeType: "image/png", data: "abcd" },
      ] };
    } } };
    await new PiHarness().run(ctx);
    expect(JSON.stringify(served).length).toBeLessThan(50_500);
    expect(JSON.stringify(served)).toContain("...(truncated, total 313478 chars)");
    if (!throws) expect(served).toMatchObject({ content: [expect.anything(), { type: "image", mimeType: "image/png", data: "abcd" }] });
    const event = events.find(event => event.type === "agent.mcp_tool_result");
    expect(JSON.stringify(event).length).toBeLessThan(50_500);
    expect(JSON.stringify(event)).toContain("...(truncated, total 313478 chars)");
  });

  it("bounds text produced when unsupported binary blocks become notices", async () => {
    const name = "mcp__docs__get";
    const { ctx, faux } = makeContext([]);
    let served: unknown;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, {}, { id: "many" }), { stopReason: "toolUse" }),
      context => { served = context.messages.find(message => message.role === "toolResult"); return fauxAssistantMessage("Done"); },
    ]);
    ctx.tools = { [name]: { inputSchema: z.object({}), execute: async () => ({ content: Array.from({ length: 1_000 }, () => ({ type: "audio", mimeType: "audio/wav", data: "abcd" })) }) } };
    await new PiHarness().run(ctx);
    const text = (served as { content: Array<{ text: string }> }).content.map(part => part.text).join("");
    expect(text.length).toBeLessThanOrEqual(50_050);
    expect(text).toContain("binary tool result omitted");
    expect(text).toContain("...(truncated, total");
  });

  it("does not expand replayed document blobs into oversized Pi JSON text", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.push(
      { type: "agent.mcp_tool_use", id: "docs", name: "mcp__docs__get", mcp_server_name: "docs", input: {} },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "docs", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "a".repeat(800_000) } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "b".repeat(800_000) } },
      ] },
    );
    let served: unknown;
    faux.setResponses([context => { served = context.messages.find(message => message.role === "toolResult"); return fauxAssistantMessage("Done"); }]);
    // Isolate replay conversion from Pi's unrelated pre-turn summarizer.
    await new PiHarness({ compaction: { name: "replay-only", shouldCompact: () => false, compact: async () => null } }).run(ctx);
    expect(JSON.stringify(served).length).toBeLessThan(1_000);
    expect(JSON.stringify(served)).toContain("binary tool result omitted");
    expect(JSON.stringify(served)).not.toContain("a".repeat(100));
  });

  it("preserves live read images within the binary budget", async () => {
    const { ctx, faux } = makeContext([]);
    let served: unknown;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", {}, { id: "image" }), { stopReason: "toolUse" }),
      context => { served = context.messages.find(message => message.role === "toolResult"); return fauxAssistantMessage("Done"); },
    ]);
    const data = "a".repeat(100_000);
    ctx.tools = { read: { inputSchema: z.object({}), execute: async () => ({ type: "image", source: { type: "base64", media_type: "image/png", data } }) } };
    await new PiHarness().run(ctx);
    expect(served).toMatchObject({ content: [{ type: "image", mimeType: "image/png", data }] });
  });

  it("replays a denied call as an error result to the model", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.push(
      { type: "agent.tool_use", id: "denied", name: "bash", input: {} },
      { type: "agent.tool_result", tool_use_id: "denied", content: "Denied: no shell", is_error: true },
    );
    let result: unknown;
    faux.setResponses([(context) => {
      result = context.messages.find(message => message.role === "toolResult");
      return fauxAssistantMessage("Understood");
    }]);
    await new PiHarness().run(ctx);
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Denied: no shell" }] });
  });

  it("keeps thinking off by default even when the model supports reasoning", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    let reasoning: unknown = "not-called";
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("thinking stayed off");
      },
    ]);

    await new PiHarness().run(ctx);

    // Pi encodes the portable "off" level by omitting provider reasoning.
    expect(reasoning).toBeUndefined();
  });

  it("projects an explicit Managed Agents effort into Pi's thinking level", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    ctx.agent.model = { id: ctx.pi!.model.id, effort: "high" };
    // Runtime construction owns normalization; the harness uses its result.
    ctx.pi!.thinkingLevel = createPiModelRuntime({
      model: ctx.agent.model.id,
      apiKey: "local-test-key",
      provider: "ant-compatible",
      baseURL: "https://model.example.test",
      piConfig: { reasoning: ctx.pi!.model.reasoning },
      thinkingLevel: ctx.agent.model.effort,
    }).thinkingLevel;
    let reasoning: unknown;
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("explicit effort applied");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(reasoning).toBe("high");
  });

  it("runs an injected compaction policy and persists its canonical boundary before the turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after compact")]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "older question" }] },
      { type: "agent.message", message_id: "older-answer", content: [{ type: "text", text: "older answer" }] },
      { type: "user.message", content: [{ type: "text", text: "follow-up" }] },
      { type: "agent.message", message_id: "follow-up-answer", content: [{ type: "text", text: "follow-up answer" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "custom compacted summary" }],
        pre_tokens: 123,
        original_message_count: 5,
        compacted_message_count: 1,
      })),
    };
    let requestText = "";
    faux.setResponses([
      (context) => {
        requestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("after compact");
      },
    ]);

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(policy.shouldCompact).toHaveBeenCalledOnce();
    expect(policy.compact).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "custom compacted summary" }],
      trigger: "auto",
      pre_tokens: 123,
    }));
    expect(requestText).toContain("<conversation-summary>");
    expect(requestText).toContain("custom compacted summary");
  });

  it("uses Pi itself for the built-in summary and keeps compaction best-effort", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "a".repeat(200) }] },
      { type: "agent.message", message_id: "a1", content: [{ type: "text", text: "b".repeat(200) }] },
      { type: "user.message", content: [{ type: "text", text: "c".repeat(200) }] },
      { type: "agent.message", message_id: "a2", content: [{ type: "text", text: "d".repeat(200) }] },
    );
    ctx.agent.metadata = { compaction_trigger_fraction: 0.01 };
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 100 };

    let summaryTools: unknown;
    let summaryReasoning: unknown;
    let finalRequestText = "";
    faux.setResponses([
      (context, options) => {
        summaryTools = context.tools;
        summaryReasoning = options?.reasoning;
        return fauxAssistantMessage("built-in Pi summary");
      },
      (context) => {
        finalRequestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("done after summary");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(summaryTools).toEqual([]);
    expect(summaryReasoning).toBeUndefined();
    expect(finalRequestText).toContain("<conversation-summary>");
    expect(finalRequestText).toContain("built-in Pi summary");
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "done after summary" }],
    }));
  });

  it("continues the turn when a compaction policy fails", async () => {
    const { ctx, events } = makeContext([fauxAssistantMessage("still answered")]);
    const policy: PiCompactionPolicy = {
      name: "broken-policy",
      shouldCompact: () => true,
      compact: async () => {
        throw new Error("summarizer unavailable");
      },
    };

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "still answered" }],
    }));
  });

  it("preserves fast speed and custom request options through a real Pi compaction request", async () => {
    const { ctx, events } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "first question" }] },
      { type: "agent.message", message_id: "first", content: [{ type: "text", text: "first answer" }] },
      { type: "user.message", content: [{ type: "text", text: "second question" }] },
      { type: "agent.message", message_id: "second", content: [{ type: "text", text: "second answer" }] },
    );
    ctx.pi = createPiModelRuntime({
      model: "claude-opus-5",
      provider: "ant-compatible",
      apiKey: "local-pi-compaction-key",
      baseURL: "https://tenant-model.example.test",
      speed: "fast",
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const text = requests.length === 1 ? "COMPACTION_DONE" : "TURN_DONE";
      const responseEvents = [
        { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", content: [], model: "claude-opus-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(responseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const summary = new PiSummaryCompactionPolicy();
    const policy: PiCompactionPolicy = {
      name: "custom-summary-transport",
      shouldCompact: () => true,
      compact: (history, input) => {
        const inherited = input.requestOptions;
        return summary.compact(history, {
          ...input,
          requestOptions: {
            ...inherited,
            fetch: (request, init) => {
              const forwarded = new Request(request, init);
              forwarded.headers.set("x-compaction-transport", "custom");
              return (inherited?.fetch ?? globalThis.fetch)(forwarded);
            },
            onPayload: async (payload, model) => {
              const projected = (await inherited?.onPayload?.(payload, model)) ?? payload;
              if (typeof projected !== "object" || projected === null) throw new Error("Expected a model request");
              return { ...projected, metadata: { user_id: "custom-compaction-payload" } };
            },
          },
        });
      },
    };

    try {
      await new PiHarness({ compaction: policy }).run(ctx);

      expect(requests).toHaveLength(2);
      const [compaction, turn] = await Promise.all(requests.map(request => request.json()));
      expect(compaction).toMatchObject({ speed: "fast", metadata: { user_id: "custom-compaction-payload" }, max_tokens: 2_000 });
      expect(turn).toMatchObject({ speed: "fast" });
      expect(requests[0]!.headers.get("x-compaction-transport")).toBe("custom");
      for (const request of requests) {
        expect(request.url).toBe("https://tenant-model.example.test/v1/messages");
        expect(request.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
      }
      expect(JSON.stringify(turn.messages)).toContain("COMPACTION_DONE");
      expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", content: [{ type: "text", text: "TURN_DONE" }] }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does one forced compact-and-retry when Pi classifies a context overflow", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage("overflow recovery summary"),
      fauxAssistantMessage("recovered answer"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(3);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered answer" }],
    }));
  });

  it("drives Pi's tool loop and emits canonical OpenMA events", async () => {
    const first = fauxAssistantMessage(
      [
        fauxThinking("I should call echo"),
        fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" }),
      ],
      { stopReason: "toolUse", responseId: "response-1" },
    );
    const second = fauxAssistantMessage("done", { responseId: "response-2" });
    const { ctx, events, streamCalls, echo } = makeContext([first, second]);

    await new PiHarness().run(ctx);

    expect(echo).toHaveBeenCalled();
    expect(echo.mock.calls[0]?.[0]).toEqual({ value: "hello" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "span.model_request_start",
        "agent.thinking",
        "agent.tool_use",
        "agent.tool_result",
        "agent.message",
        "span.model_request_end",
      ]),
    );
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent.tool_use")).toMatchObject({
      id: "tool-echo",
      name: "echo",
      input: { value: "hello" },
    });
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "tool-echo",
      content: [{ type: "text", text: '{"echoed":"hello"}' }],
    });
    expect(events.find((event) => event.type === "agent.message")).toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    expect(streamCalls.messageStarts).toEqual(streamCalls.messageEnds);
    expect(streamCalls.thinkingStarts).toEqual(streamCalls.thinkingEnds);
    expect(streamCalls.toolStarts).toEqual(streamCalls.toolEnds);
  });

  it("projects canonical history back into Pi on the next turn", async () => {
    const { ctx, events, faux } = makeContext([
      fauxAssistantMessage("first answer"),
    ]);
    await new PiHarness().run(ctx);
    events.push({
      type: "user.message",
      content: [{ type: "text", text: "second question" }],
    });

    let roles: string[] = [];
    faux.setResponses([
      (context) => {
        roles = context.messages.map((message) => message.role);
        return fauxAssistantMessage("second answer");
      },
    ]);
    await new PiHarness().run(ctx);

    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(
      events.filter((event) => event.type === "agent.message"),
    ).toHaveLength(2);
  });

  it("uses the runtime thinking level for every Pi agent turn", async () => {
    const { ctx } = makeContext([fauxAssistantMessage("careful answer")]);
    const streamSimple = vi.spyOn(ctx.pi!.models, "streamSimple");
    Reflect.set(ctx.pi!, "thinkingLevel", "high");

    await new PiHarness().run(ctx);

    expect(streamSimple).toHaveBeenCalledWith(
      ctx.pi!.model,
      expect.any(Object),
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  it("pauses non-executable tools for OpenMA confirmation", async () => {
    const call = fauxAssistantMessage(
      fauxToolCall("echo", { value: "confirm me" }, { id: "tool-confirm" }),
      { stopReason: "toolUse" },
    );
    const { ctx, events } = makeContext([call]);
    delete (ctx.tools.echo as { execute?: unknown }).execute;

    await new PiHarness().run(ctx);

    expect(ctx.runtime.pendingConfirmations).toEqual(["tool-confirm"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.tool_use",
      id: "tool-confirm",
    }));
    expect(events.some((event) => event.type === "agent.tool_result")).toBe(false);
  });
});
