import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema, streamText } from "ai";
import { APICallError } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { SessionEvent } from "@open-managed-agents/shared";
import { SessionStateMachine, type RuntimeAdapter } from "@open-managed-agents/session-runtime";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { NodeHarnessRuntime } from "../../main-node/src/lib/node-harness-runtime";
import { ManagedNodeHarnessRuntime } from "../../main-node/src/lib/node-managed-harness-runtime";
import {
  createScriptedLanguageModel, streamStep, textChunks, toolCallChunks, finishChunk,
} from "../../../test/fakes/scripted-language-model";

// Keep the real SDK pipeline while retaining callbacks to simulate a late flush.
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn(actual.streamText) };
});
afterEach(() => vi.clearAllMocks());

const userMessage: SessionEvent = {
  type: "user.message", content: [{ type: "text", text: "Read and finish" }],
};
const answer = () => streamStep([...textChunks("answer", ["Done"]), finishChunk("stop")]);
const toolStep = (id: string) => streamStep([
  ...toolCallChunks({ id, toolName: "read", inputDeltas: ["{}"] }), finishChunk("tool-calls"),
]);
function rejection() {
  return new APICallError({
    message: "Overloaded", url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {}, statusCode: 529, isRetryable: false,
    responseBody: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
  });
}

// Real production runtimes and turn lifecycle; only storage/publishing ports are fakes.
async function fixture(kind: "legacy" | "managed", model: HarnessContext["model"]) {
  const db: SessionEvent[] = [userMessage];
  const published: SessionEvent[] = [];
  const output: any[] = [];
  let seq = 0;
  let runtime: NodeHarnessRuntime | ManagedNodeHarnessRuntime;
  if (kind === "legacy") {
    runtime = new NodeHarnessRuntime({
      sessionId: "settled-tools", sandbox: {} as HarnessRuntime["sandbox"],
      log: {
        getEventsAsync: async () => [...db],
        appendAsync: async (event: SessionEvent) => { db.push({ ...event, seq: ++seq }); },
      } as any,
      hub: { publish: (_id: string, event: SessionEvent) => output.push(event) } as any,
    });
    await runtime.refreshHistory();
  } else {
    runtime = new ManagedNodeHarnessRuntime({
      initialEvents: [userMessage] as any, events: [], sandbox: {} as HarnessRuntime["sandbox"],
      output: async frame => { output.push(frame); },
      clock: { now: () => new Date() }, ids: { nextEventId: () => `evt-${++seq}` },
    });
  }
  const ctx = {
    agent: { id: "agent-test", model: "test" }, userMessage, model, tools: {},
    systemPrompt: "Be helpful", runtime,
    env: { OMA_MODEL_RETRY_ATTEMPTS: "4", OMA_MODEL_RETRY_BACKOFF_MS: "0" },
  } as unknown as HarnessContext;
  const end = vi.fn(async () => undefined);
  const machine = new SessionStateMachine({
    sessionId: "settled-tools", tenantId: "test", sandbox: runtime.sandbox,
    adapter: {
      beginTurn: async () => {}, endTurn: end,
      eventLog: { append: async (event: SessionEvent) => { db.push(event); } },
    } as unknown as RuntimeAdapter,
    loadAgent: async () => ctx.agent, buildTools: async () => ctx.tools, buildModel: () => ctx.model,
    buildHarness: () => ({ run: input => new DefaultHarness().run(input as HarnessContext) }),
    buildHarnessContext: async input => { runtime.abortSignal = input.abortSignal; return ctx; },
    publish: event => published.push(event), logger: { log: vi.fn(), warn: vi.fn() },
  });
  return {
    ctx, output, published,
    run: () => machine.runHarnessTurn("agent-test", userMessage),
    flush: async () => {
      if (runtime instanceof ManagedNodeHarnessRuntime) await runtime.drain();
      else await (runtime as unknown as { writeChain: Promise<void> }).writeChain;
    },
    events: () => runtime.history.getEvents(),
  };
}

const partialChunks = [
  { type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "think" },
  { type: "reasoning-delta", id: "think", delta: "Partial thinking" },
  { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "Incomplete answer" },
];

describe.each(["legacy", "managed"] as const)("settled tools on the %s Node runtime", kind => {
  it("excludes complete unexecuted calls from protocol-error retries", async () => {
    const chunks = toolCallChunks({ id: "not-executed", toolName: "read", inputDeltas: ["{}"] });
    const scripted = createScriptedLanguageModel([
      streamStep(chunks, { errorAfterChunks: chunks.length, error: rejection() }), toolStep("read-once"), answer(),
    ]);
    const fx = await fixture(kind, scripted.model);
    const execute = vi.fn(async () => "completed read result");
    fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    await fx.run();
    await fx.flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scripted.calls).toHaveLength(3);
    expect(JSON.stringify(scripted.calls[1])).not.toContain("not-executed");
    expect(fx.events().filter(e => e.type === "agent.tool_use")).toHaveLength(1);
    expect(fx.events().filter(e => e.type === "agent.tool_result")).toHaveLength(1);
    expect(fx.output.filter(e => e.type === "agent.tool_use_input_stream_end" && e.tool_use_id === "not-executed"))
      .toEqual([expect.objectContaining({ status: "aborted" })]);
    expect(fx.published.some(e => e.type === "session.error")).toBe(false);
  });

  it.each(["protocol", "rejected-body"])("excludes partial output after %s failure", async failure => {
    const scripted = createScriptedLanguageModel([
      streamStep(partialChunks, { errorAfterChunks: partialChunks.length, error: rejection() }), answer(),
    ]);
    if (failure === "rejected-body") {
      const original = scripted.model.doStream.bind(scripted.model);
      let first = true;
      scripted.model.doStream = async options => {
        const result = await original(options);
        if (!first) return result;
        first = false;
        let index = 0;
        return { ...result, stream: new ReadableStream({
          pull(controller) {
            if (index < partialChunks.length) controller.enqueue(partialChunks[index++] as any);
            else controller.error(rejection());
          },
        }) };
      };
    }
    const fx = await fixture(kind, scripted.model);
    await fx.run();
    await fx.flush();
    expect(scripted.calls).toHaveLength(2);
    expect(JSON.stringify(scripted.calls[1])).not.toMatch(/Partial thinking|Incomplete answer/);
    expect(JSON.stringify(await new DefaultHarness().deriveModelContext(fx.events())))
      .not.toMatch(/Partial thinking|Incomplete answer/);
    expect(fx.events().filter(e => e.type === "agent.message")).toHaveLength(1);
    expect(fx.output.filter(e => e.type === "agent.message_stream_end" && e.status === "aborted"))
      .toEqual([expect.objectContaining({ error_text: "stream_error" })]);
  });

  it("persists one pair when a protocol error still flushes onStepFinish", async () => {
    const step = toolStep("settled");
    const scripted = createScriptedLanguageModel([
      streamStep(step.chunks, { errorAfterChunks: step.chunks.length, error: rejection() }), answer(),
    ]);
    const fx = await fixture(kind, scripted.model);
    const execute = vi.fn(async () => "settled read result");
    fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    await fx.run();
    await fx.flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scripted.calls).toHaveLength(2);
    expect(JSON.stringify(scripted.calls[1])).toContain("settled read result");
    expect(fx.events().filter(e => e.type === "agent.tool_use")).toHaveLength(1);
    expect(fx.events().filter(e => e.type === "agent.tool_result")).toHaveLength(1);
  });

  it("rebuilds the actual next provider prompt after failed output with a settled tool", async () => {
    const chunks = [
      ...partialChunks,
      ...toolCallChunks({ id: "protocol-pair", toolName: "read", inputDeltas: ["{}"] }).slice(1),
      finishChunk("tool-calls"),
    ];
    const scripted = createScriptedLanguageModel([
      streamStep(chunks, { errorAfterChunks: chunks.length, error: rejection() }), answer(),
    ]);
    const fx = await fixture(kind, scripted.model);
    const execute = vi.fn(async () => "protocol result");
    fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    await fx.run();
    await fx.flush();

    expect(scripted.calls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const nextPrompt = JSON.stringify(scripted.calls[1]);
    expect(nextPrompt).toContain("Be helpful");
    expect(nextPrompt).toContain("Read and finish");
    expect(nextPrompt).toContain("protocol-pair");
    expect(nextPrompt).toContain("protocol result");
    expect(nextPrompt).not.toMatch(/Partial thinking|Incomplete answer/);
    const canonical = fx.events().filter(e =>
      ["agent.thinking", "agent.message", "agent.tool_use", "agent.tool_result"].includes(e.type));
    expect(canonical.map(e => e.type)).toEqual(["agent.tool_use", "agent.tool_result", "agent.message"]);
    const finalContext = JSON.stringify(await new DefaultHarness().deriveModelContext(fx.events()));
    expect(finalContext).toContain("protocol-pair");
    expect(finalContext).toContain("protocol result");
    expect(finalContext).toContain("Done");
    expect(finalContext).not.toMatch(/Partial thinking|Incomplete answer/);
    expect(fx.published.some(e => e.type === "session.error")).toBe(false);
  });

  it.each(["tool-result", "tool-error"] as const)(
    "retains settled %s after body rejection and ignores a late step flush", async outcome => {
      const chunks = toolStep("settled-body").chunks;
      const scripted = createScriptedLanguageModel([streamStep(chunks), answer()]);
      let toolSettled!: () => void;
      const settled = new Promise<void>(resolve => { toolSettled = resolve; });
      const original = scripted.model.doStream.bind(scripted.model);
      let first = true;
      scripted.model.doStream = async options => {
        const result = await original(options);
        if (!first) return result;
        first = false;
        let index = 0;
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++] as any);
            else {
              await settled;
              // Execute has returned/thrown before the rejected response body.
              await new Promise(resolve => setTimeout(resolve, 20));
              controller.error(rejection());
            }
          },
        }) };
      };
      const fx = await fixture(kind, scripted.model);
      const execute = vi.fn(async () => {
        toolSettled();
        if (outcome === "tool-error") throw new Error("settled body error");
        return "settled body result";
      });
      fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
      await fx.run();
      await fx.flush();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(scripted.calls).toHaveLength(2);
      const retryPrompt = JSON.stringify(scripted.calls[1]);
      expect(retryPrompt).toContain("settled-body");
      expect(retryPrompt).toContain(outcome === "tool-error" ? "settled body error" : "settled body result");
      const canonical = () => fx.events().filter(e => e.type === "agent.tool_use" || e.type === "agent.tool_result");
      expect(canonical().map(e => e.type)).toEqual(["agent.tool_use", "agent.tool_result"]);
      expect(canonical()[1]).toMatchObject(outcome === "tool-error" ? { is_error: true } : { content: "settled body result" });

      // The catch already persisted the pair. A late SDK callback must not
      // repeat it or canonicalize the failed attempt's assistant output.
      const firstAttempt = vi.mocked(streamText).mock.calls[0][0];
      await firstAttempt.onStepFinish!({
        finishReason: "tool-calls",
        content: [
          { type: "text", text: "Failed step output must stay excluded" },
          { type: "tool-call", toolCallId: "settled-body", toolName: "read", input: {} },
          { type: outcome, toolCallId: "settled-body", toolName: "read", input: {},
            ...(outcome === "tool-error" ? { error: new Error("settled body error") } : { output: "settled body result" }) },
        ],
      } as any);
      await fx.flush();
      expect(canonical().map(e => e.type)).toEqual(["agent.tool_use", "agent.tool_result"]);
      expect(fx.events().filter(e => e.type === "agent.message")).toHaveLength(1);
      expect(fx.events().filter(e => e.type === "span.model_request_start")).toHaveLength(2);
      expect(fx.events().filter(e => e.type === "span.model_request_end")).toHaveLength(2);
      expect(fx.published.some(e => e.type === "session.error")).toBe(false);
    },
  );

  it("preserves call order and settlement order for parallel tools on body rejection", async () => {
    const chunks = [
      ...toolCallChunks({ id: "first", toolName: "read", inputDeltas: ['{"order":1}'] }),
      ...toolCallChunks({ id: "second", toolName: "read", inputDeltas: ['{"order":2}'] }).slice(1),
      finishChunk("tool-calls"),
    ];
    const scripted = createScriptedLanguageModel([streamStep(chunks), answer()]);
    let finished = 0;
    let allSettled!: () => void;
    const settled = new Promise<void>(resolve => { allSettled = resolve; });
    const original = scripted.model.doStream.bind(scripted.model);
    let first = true;
    scripted.model.doStream = async options => {
      const result = await original(options);
      if (!first) return result;
      first = false;
      let index = 0;
      return { ...result, stream: new ReadableStream({
        async pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++] as any);
          else {
            await settled;
            await new Promise(resolve => setTimeout(resolve, 20));
            controller.error(rejection());
          }
        },
      }) };
    };
    const fx = await fixture(kind, scripted.model);
    fx.ctx.agent.metadata = { tool_execution: "parallel" };
    const execute = vi.fn(async (input: any) => {
      if (input.order === 1) await new Promise(resolve => setTimeout(resolve, 20));
      if (++finished === 2) allSettled();
      return `completed result ${input.order}`;
    });
    fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
    await fx.run();
    await fx.flush();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(scripted.calls).toHaveLength(2);
    const pairs = fx.events().filter(e => e.type === "agent.tool_use" || e.type === "agent.tool_result");
    expect(pairs).toMatchObject([
      { type: "agent.tool_use", id: "first" },
      { type: "agent.tool_use", id: "second" },
      { type: "agent.tool_result", tool_use_id: "second", content: "completed result 2" },
      { type: "agent.tool_result", tool_use_id: "first", content: "completed result 1" },
    ]);
    const retryPrompt = JSON.stringify(scripted.calls[1]);
    expect(retryPrompt).toContain("completed result 1");
    expect(retryPrompt).toContain("completed result 2");
  });

  it("continues from the settled pair after a real Anthropic adapter socket reset", async () => {
    const start = { type: "message_start", message: {
      id: "msg_tool_native", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6",
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } };
    const toolFrames = (id: string) => [start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const textFrames = [start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const frameText = (frames: Array<{ type: string }>) => frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
    let requests = 0;
    let firstResponse: http.ServerResponse | undefined;
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const n = ++requests;
      bodies[n - 1] = "";
      req.on("data", data => { bodies[n - 1] += data.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (n === 1) {
          firstResponse = res;
          res.write(frameText(toolFrames("first-completed")));
        } else if (n === 2 && !bodies[1].includes("durable completed read result")) {
          // Reproduce the second execution if the retry lost the first result.
          res.end(frameText(toolFrames("retried-duplicate")));
        } else res.end(frameText(textFrames));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const model = createAnthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${address.port}/v1` })("claude-sonnet-4-6");
      const fx = await fixture(kind, model);
      const execute = vi.fn(async () => {
        if (!resetTimer) resetTimer = setTimeout(() => firstResponse?.destroy(), 20);
        return "durable completed read result";
      });
      fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
      await fx.run();
      await fx.flush();
      expect(bodies[1]).toContain("first-completed");
      expect(bodies[1]).toContain("durable completed read result");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(requests).toBe(2);
      expect(fx.events().filter(e => e.type === "agent.tool_use")).toHaveLength(1);
      expect(fx.events().filter(e => e.type === "agent.tool_result")).toHaveLength(1);
      expect(fx.published.some(e => e.type === "session.error")).toBe(false);
    } finally {
      clearTimeout(resetTimer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("excludes failed text from the real Anthropic follow-up body with a settled tool", async () => {
    const start = { type: "message_start", message: {
      id: "msg", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6",
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } };
    const text = (value: string, index = 0) => [
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index },
    ];
    const end = (reason: string) => [
      { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const frames = [start, ...text("Failed provider preface"),
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "adapter-settled", name: "read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 }, ...end("tool_use"),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
    const frameText = (values: Array<{ type: string }>) =>
      values.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const index = bodies.length;
      bodies.push("");
      req.on("data", data => { bodies[index] += data.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frameText(index === 0 ? frames : [start, ...text("Done"), ...end("end_turn")]));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const model = createAnthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${address.port}/v1` })("claude-sonnet-4-6");
      const fx = await fixture(kind, model);
      const execute = vi.fn(async () => "adapter settled result");
      fx.ctx.tools = { read: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute }) };
      await fx.run();
      await fx.flush();

      expect(bodies).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(bodies[1]).toContain("Be helpful");
      expect(bodies[1]).toContain("Read and finish");
      expect(bodies[1]).toContain("adapter-settled");
      expect(bodies[1]).toContain("adapter settled result");
      expect(bodies[1]).not.toContain("Failed provider preface");
      const canonical = fx.events().filter(e =>
        ["agent.thinking", "agent.message", "agent.tool_use", "agent.tool_result"].includes(e.type));
      expect(canonical.map(e => e.type)).toEqual(["agent.tool_use", "agent.tool_result", "agent.message"]);
      const finalContext = JSON.stringify(await new DefaultHarness().deriveModelContext(fx.events()));
      expect(finalContext).toContain("adapter-settled");
      expect(finalContext).toContain("adapter settled result");
      expect(finalContext).toContain("Done");
      expect(finalContext).not.toContain("Failed provider preface");
      expect(fx.published.some(e => e.type === "session.error")).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
