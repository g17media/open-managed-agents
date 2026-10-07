import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema } from "ai";
import { APICallError } from "@ai-sdk/provider";
import { ModelError, type SessionEvent } from "@open-managed-agents/shared";
import { SessionStateMachine, type RuntimeAdapter } from "@open-managed-agents/session-runtime";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { eventsToMessages } from "../src/runtime/history";
import { createScriptedLanguageModel, requestErrorStep, streamStep, textChunks, toolCallChunks, finishChunk } from "../../../test/fakes/scripted-language-model";

function rejection(statusCode = 529, options: { message?: string; isRetryable?: boolean; responseHeaders?: Record<string, string> } = {}) {
  return new APICallError({
    message: options.message ?? "Overloaded", url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {}, statusCode, isRetryable: options.isRetryable ?? false,
    responseBody: JSON.stringify({ type: "error", error: { type: statusCode === 529 ? "overloaded_error" : "invalid_request_error", message: options.message ?? "Overloaded" }, request_id: "req_test" }),
    responseHeaders: options.responseHeaders,
  });
}
const answer = () => streamStep([...textChunks("answer", ["Done"]), finishChunk("stop")]);
const toolStep = () => streamStep([...toolCallChunks({ id: "read-once", toolName: "read", inputDeltas: ["{}"] }), finishChunk("tool-calls")]);

function context(model: HarnessContext["model"]): HarnessContext {
  const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "Read and finish" }] }];
  const runtime = {
    history: { getEvents: () => events, getMessages: () => eventsToMessages(events) },
    sandbox: {}, broadcast: (event: SessionEvent) => events.push(event),
    ...Object.fromEntries(["broadcastStreamStart", "broadcastChunk", "broadcastStreamEnd", "broadcastThinkingStart", "broadcastThinkingChunk", "broadcastThinkingEnd", "broadcastToolInputStart", "broadcastToolInputChunk", "broadcastToolInputEnd", "reportUsage"].map(name => [name, vi.fn(async () => undefined)])),
  } as unknown as HarnessRuntime;
  return {
    agent: { id: "agent-test", model: "test" }, userMessage: events[0], model, tools: {},
    systemPrompt: "Be helpful", env: { OMA_MODEL_RETRY_ATTEMPTS: "4", OMA_MODEL_RETRY_BACKOFF_MS: "0" }, runtime,
  } as unknown as HarnessContext;
}

// Exercise the deployed session lifecycle around the real harness, using only
// in-memory persistence/publishing ports; provider errors must not end a turn.
function session(ctx: HarnessContext) {
  const events = ctx.runtime.history.getEvents();
  const begin = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const published: SessionEvent[] = [];
  const machine = new SessionStateMachine({
    sessionId: "session-test", tenantId: "tenant-test", sandbox: ctx.runtime.sandbox,
    adapter: { beginTurn: begin, endTurn: end, eventLog: { append: async (event: SessionEvent) => { events.push(event); } } } as unknown as RuntimeAdapter,
    loadAgent: async () => ctx.agent, buildTools: async () => ctx.tools, buildModel: () => ctx.model,
    buildHarness: () => ({ run: input => new DefaultHarness().run(input as HarnessContext) }),
    buildHarnessContext: async input => { ctx.runtime.abortSignal = input.abortSignal; return ctx; },
    publish: event => published.push(event), logger: { log: vi.fn(), warn: vi.fn() },
  });
  return { machine, begin, end, events, published, run: () => machine.runHarnessTurn("agent-test", ctx.userMessage) };
}

function expectPairedSpans(events: SessionEvent[], count: number) {
  const starts = events.filter(event => event.type === "span.model_request_start");
  const ends = events.filter(event => event.type === "span.model_request_end");
  expect(starts).toHaveLength(count);
  expect(ends).toHaveLength(count);
  for (const start of starts) {
    expect(ends.filter(event => event.type === "span.model_request_end" && event.model_request_start_id === start.id)).toHaveLength(1);
  }
}

describe("DefaultHarness in-turn provider retries", () => {
  // Follow context-request-errors.test.ts: suppress only workerd's broken
  // diagnostics_channel promise telemetry; real AI SDK execution stays intact.
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  let builtins: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    builtins = vi.spyOn(process, "getBuiltinModule").mockImplementation(id =>
      id === "node:diagnostics_channel" ? undefined : getBuiltinModule(id));
  });
  afterAll(() => builtins.mockRestore());
  afterEach(() => { vi.useRealTimers(); });

  it("continues after a completed tool and two 529s with one error-free session outcome", async () => {
    const scripted = createScriptedLanguageModel([toolStep(), requestErrorStep(rejection()), requestErrorStep(rejection()), answer()]);
    const ctx = context(scripted.model);
    const execute = vi.fn(async () => "completed read result");
    ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    const fx = session(ctx);
    await fx.run();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scripted.calls).toHaveLength(4);
    // Crucial: request zero of each NEW attempt contains the prior completed
    // tool call/result, rather than the original user-only turn prompt.
    for (const call of scripted.calls.slice(2)) {
      expect(JSON.stringify(call)).toContain("completed read result");
      expect(JSON.stringify(call)).toContain("read-once");
    }
    expect(fx.events.filter(event => event.type === "agent.tool_use")).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "agent.tool_result")).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "session.error")).toHaveLength(0);
    expect(fx.events.filter(event => event.type === "session.status_idle")).toHaveLength(1);
    expect(fx.published.filter(event => event.type === "session.status_idle")).toHaveLength(1);
    expect(fx.begin).toHaveBeenCalledTimes(1);
    expect(fx.end).toHaveBeenCalledTimes(1);
    expectPairedSpans(fx.events, 4);
  });

  it("retries errors delivered inside a stream and resets the diagnostic per attempt", async () => {
    const scripted = createScriptedLanguageModel([
      streamStep([{ type: "stream-start", warnings: [] }], { errorAfterChunks: 1, error: rejection() }),
      streamStep([{ type: "stream-start", warnings: [] }, finishChunk("error")]),
      answer(),
    ]);
    const ctx = context(scripted.model);
    await new DefaultHarness().run(ctx);
    expect(scripted.calls).toHaveLength(3);
    expectPairedSpans(ctx.runtime.history.getEvents(), 3);
    expect(ctx.runtime.history.getEvents().filter(event => event.type === "agent.message")).toHaveLength(1);
  });

  it("finds the original status and retry-after through AI SDK retry exhaustion", async () => {
    const error = rejection(529, { isRetryable: true, responseHeaders: { "retry-after": "0" } });
    const scripted = createScriptedLanguageModel([requestErrorStep(error), requestErrorStep(error), requestErrorStep(error), answer()]);
    const ctx = context(scripted.model);
    ctx.env.OMA_MODEL_RETRY_BACKOFF_MS = "90000"; // Must use the original header instead.
    await new DefaultHarness().run(ctx);
    expect(scripted.calls).toHaveLength(4);
    expectPairedSpans(ctx.runtime.history.getEvents(), 2); // SDK retries share a per-step span.
  });

  it("does not retry a 400 and produces the existing terminal error", async () => {
    const scripted = createScriptedLanguageModel([requestErrorStep(rejection(400, { message: "bad request" })), answer()]);
    const fx = session(context(scripted.model));
    await expect(fx.run()).rejects.toThrow(/bad request.*\[400\]/);
    expect(scripted.calls).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "session.error")).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "session.status_idle")).toHaveLength(1);
  });

  it("rethrows the final diagnostic after the configured extra attempts, once", async () => {
    const final = rejection(529, { message: "last failure" });
    const scripted = createScriptedLanguageModel([requestErrorStep(rejection()), requestErrorStep(rejection()), requestErrorStep(final)]);
    const ctx = context(scripted.model);
    ctx.env.OMA_MODEL_RETRY_ATTEMPTS = "2";
    const fx = session(ctx);
    const run = fx.run();
    await expect(run).rejects.toThrow(/last failure.*\[529\]/);
    await expect(run).rejects.toMatchObject({ cause: final });
    expect(scripted.calls).toHaveLength(3);
    expect(fx.events.filter(event => event.type === "session.error")).toHaveLength(1);
    expectPairedSpans(fx.events, 3);
  });

  it("zero extra attempts preserves immediate failure", async () => {
    const scripted = createScriptedLanguageModel([requestErrorStep(rejection()), answer()]);
    const ctx = context(scripted.model);
    ctx.env.OMA_MODEL_RETRY_ATTEMPTS = "0";
    await expect(new DefaultHarness().run(ctx)).rejects.toThrow("Overloaded");
    expect(scripted.calls).toHaveLength(1);
  });

  it("a user interrupt during backoff ends the same turn without session.error", async () => {
    const scripted = createScriptedLanguageModel([requestErrorStep(rejection()), answer()]);
    const ctx = context(scripted.model);
    ctx.env.OMA_MODEL_RETRY_BACKOFF_MS = "90000";
    const fx = session(ctx);
    let enteredBackoff!: () => void;
    const backoff = new Promise<void>(resolve => { enteredBackoff = resolve; });
    const warn = vi.spyOn(console, "warn").mockImplementation(message => {
      if (String(message).includes("transient provider error")) enteredBackoff();
    });
    try {
      const run = fx.run();
      await backoff;
      fx.machine.interrupt();
      await run;
    } finally { warn.mockRestore(); }
    expect(scripted.calls).toHaveLength(1);
    expect(fx.events.filter(event => event.type === "session.error")).toHaveLength(0);
    expect(fx.events.filter(event => event.type === "session.status_idle")).toHaveLength(1);
    expect(fx.end).toHaveBeenCalledTimes(1);
  });

  it("context-length recovery remains inside provider recovery, with rebuilt tool context", async () => {
    const scripted = createScriptedLanguageModel([
      toolStep(), requestErrorStep(rejection()),
      requestErrorStep(rejection(400, { message: "prompt is too long" })), answer(),
    ]);
    const ctx = context(scripted.model);
    const execute = vi.fn(async () => "completed read result");
    ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    await new DefaultHarness().run(ctx);
    expect(scripted.calls).toHaveLength(4);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(scripted.calls[3])).toContain("completed read result");
  });

  it("provider recovery also handles a transient failure of the inner context retry", async () => {
    const scripted = createScriptedLanguageModel([
      requestErrorStep(rejection(400, { message: "prompt is too long" })),
      requestErrorStep(rejection()), answer(),
    ]);
    const ctx = context(scripted.model);
    await new DefaultHarness().run(ctx);
    expect(scripted.calls).toHaveLength(3);
  });

  it("repeated context-length failure still throws the reset instruction", async () => {
    const scripted = createScriptedLanguageModel([
      requestErrorStep(rejection(400, { message: "prompt is too long" })),
      requestErrorStep(rejection(400, { message: "prompt is too long" })),
    ]);
    const ctx = context(scripted.model);
    await expect(new DefaultHarness().run(ctx)).rejects.toThrow(/context exceeded the model window.*session must be reset/);
    expect(scripted.calls).toHaveLength(2);
  });

  it("does not retry silent stops even after a transient failure", async () => {
    const scripted = createScriptedLanguageModel([requestErrorStep(rejection()), streamStep([{ type: "stream-start", warnings: [] }, finishChunk("stop")]), answer()]);
    const ctx = context(scripted.model);
    const run = new DefaultHarness().run(ctx);
    await expect(run).rejects.toBeInstanceOf(ModelError);
    await expect(run).rejects.toThrow("silent_stop");
    expect(scripted.calls).toHaveLength(2);
  });
});
