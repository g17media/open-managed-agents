import { describe, expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { DefaultHarness } from "../src/harness/default-loop";
import { PiHarness } from "../src/harness/pi-loop";
import { createScriptedLanguageModel, finishChunk, streamStep, textChunks } from "../../../test/fakes/scripted-language-model";

function setup(kind: "pi" | "default", metadata: Record<string, unknown>, tools: HarnessContext["tools"], names = ["edit", "bash"]) {
  const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "edit then run" }] }];
  const noop = async () => {};
  const runtime = {
    history: { getEvents: () => events, getMessages: () => [], append: (event: SessionEvent) => events.push(event) },
    sandbox: {}, broadcast: (event: SessionEvent) => events.push(event), pendingConfirmations: [],
    broadcastStreamStart: noop, broadcastChunk: noop, broadcastStreamEnd: noop,
    broadcastThinkingStart: noop, broadcastThinkingChunk: noop, broadcastThinkingEnd: noop,
    broadcastToolInputStart: noop, broadcastToolInputChunk: noop, broadcastToolInputEnd: noop, reportUsage: noop,
  } as unknown as HarnessRuntime;
  const scripted = createScriptedLanguageModel([
    streamStep([{ type: "stream-start", warnings: [] }, ...names.map(name => ({
      type: "tool-call", toolCallId: name, toolName: name, input: "{}",
    })), finishChunk("tool-calls")]),
    streamStep([...textChunks("done", ["Done"]), finishChunk("stop")]),
  ]);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let served: unknown;
  faux.setResponses([
    fauxAssistantMessage(names.map(name => fauxToolCall(name, {}, { id: name })), { stopReason: "toolUse" }),
    context => { served = context.messages; return fauxAssistantMessage("Done"); },
  ]);
  const ctx = {
    agent: { id: "agent-test", model: kind === "pi" ? faux.getModel().id : scripted.model.modelId, metadata },
    userMessage: events[0], session_id: "session-test", tools, model: scripted.model,
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "Be concise", env: { ANTHROPIC_API_KEY: "unused" }, runtime,
  } as unknown as HarnessContext;
  return {
    run: () => (kind === "pi" ? new PiHarness() : new DefaultHarness()).run(ctx), events, ctx,
    results: () => kind === "pi"
      ? (served as Array<{ role: string; toolCallId: string }>).filter(m => m.role === "toolResult")
      : (scripted.calls[1] as { prompt: Array<{ role: string; content: Array<{ toolCallId: string }> }> }).prompt.filter(m => m.role === "tool").flatMap(m => m.content),
  };
}

describe.each(["pi", "default"] as const)("%s tool execution", kind => {
  // Does not catch wrong MIME; media tests do. Prevents a queue from running
  // side effects after abort even if the preceding tool ignores its signal.
  it("does not start queued tools after interruption", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let ran = false;
    const { run, ctx } = setup(kind, {}, {
      edit: { inputSchema: z.object({}), execute: async () => { started.resolve(); await release.promise; return "edited"; } },
      bash: { inputSchema: z.object({}), execute: async () => { ran = true; return "ran"; } },
    });
    ctx.runtime.abortSignal = controller.signal;
    const running = run().then(() => undefined, (error: unknown) => error);
    await started.promise;
    controller.abort();
    release.resolve();
    const error = await running;
    if (kind === "default") expect(error).toMatchObject({ name: "AbortError" });
    else expect(error).toBeUndefined();
    expect(ran).toBe(false);
  });

  // Catches ignored sequential flag and poisoned rejection queues, but not media loss (pi-tool-media covers that).
  it.each([undefined, "sequential", "invalid", "parallel"])("honours tool_execution=%s and preserves later calls after failure", async mode => {
    for (const fail of [false, true]) {
      let edited = false;
      let observed: boolean | undefined;
      const order: string[] = [];
      const { run, results, events } = setup(kind, mode === undefined ? {} : { tool_execution: mode }, {
        edit: { inputSchema: z.object({}), execute: async () => {
          order.push("edit:start");
          await new Promise(resolve => setTimeout(resolve, 20));
          edited = true;
          order.push("edit:end");
          if (fail) throw new Error("edit failed");
          return "edited";
        } },
        bash: { inputSchema: z.object({}), execute: async () => { observed = edited; order.push("bash"); return "ran"; } },
      });
      await run();
      expect(observed).toBe(mode !== "parallel");
      expect(order).toEqual(mode === "parallel" ? ["edit:start", "bash", "edit:end"] : ["edit:start", "edit:end", "bash"]);
      const delivered = results();
      // Both model prompts retain call order even when executions overlap.
      expect(delivered.map(r => r.toolCallId)).toEqual(["edit", "bash"]);
      expect(JSON.stringify(delivered)).toContain(fail ? "edit failed" : "edited");
      expect(JSON.stringify(delivered)).toContain("ran");
      if (fail) expect(delivered[0]).toMatchObject(kind === "pi"
        ? { isError: true }
        : { output: { type: "error-text" } });
      if (kind === "default" && mode !== "parallel") {
        const edit = events.find(e => e.type === "agent.tool_result" && e.tool_use_id === "edit");
        const bash = events.find(e => e.type === "agent.tool_result" && e.tool_use_id === "bash");
        expect(edit?.metadata?.ended_at).toEqual(expect.any(String));
        expect(bash?.metadata?.started_at).toEqual(expect.any(String));
        expect(Date.parse(bash!.metadata!.started_at as string)).toBeGreaterThanOrEqual(Date.parse(edit!.metadata!.ended_at as string));
      }
    }
  });

  // Timing measurements are diagnostic, not a flaky wall-clock performance assertion.
  // Would not catch multi-call races; the cases above do.
  it("measures single-tool turns in both modes", async () => {
    const durations: Record<string, number[]> = { sequential: [], parallel: [] };
    for (let i = 0; i < 8; i++) {
      for (const mode of i % 2 ? ["parallel", "sequential"] : ["sequential", "parallel"]) {
        let calls = 0;
        const { run, results } = setup(kind, { tool_execution: mode }, {
          edit: { inputSchema: z.object({}), execute: async () => { calls++; return "edited"; } },
        }, ["edit"]);
        const start = performance.now();
        await run();
        durations[mode].push(performance.now() - start);
        expect(calls).toBe(1);
        expect(results().map(r => r.toolCallId)).toEqual(["edit"]);
      }
    }
    console.log(`${kind} single-tool median ms`, Object.fromEntries(Object.entries(durations).map(([mode, times]) => [mode, times.sort((a, b) => a - b)[4]])));
  });
});
