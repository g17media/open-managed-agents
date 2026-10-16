import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { SessionEvent } from "@open-managed-agents/shared";
import { createPiModelRuntime, toAiSdkLanguageModel } from "../src/harness/pi-provider";
import { eventsToMessages, eventsToMessagesAsync } from "../src/runtime/history";
import incident from "./fixtures/tool-result-order.json";

// Keep private message bodies out of the repository while preserving every
// event's API-list order, call identity and response boundary from the incident.
const fixture = incident as SessionEvent[];
const evidencePath = process.env.OMA_TOOL_ORDER_EVIDENCE;
const evidence: SessionEvent[] | undefined = evidencePath
  ? readFileSync(evidencePath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : undefined;
// Earlier API rows also have timestamp ties; only this correctly ordered
// portion is a byte-stability reference for the legacy projection.
const healthyPart = (events: SessionEvent[]) => events.slice(65, 94);
const digest = (messages: ModelMessage[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
const user = { type: "user.message", content: [{ type: "text", text: "Continue" }] } as SessionEvent;
const start = (id: string) => ({ type: "span.model_request_start", id }) as SessionEvent;
const call = (id: string) => ({ type: "agent.tool_use", id, name: "bash", input: {} }) as SessionEvent;
const result = (id: string) => ({ type: "agent.tool_result", tool_use_id: id, content: `result ${id}` }) as SessionEvent;
const reasoning = { type: "agent.thinking", text: "Thinking", providerOptions: { pi: { thinkingSignature: "signed" } } } as SessionEvent;
const text = { type: "agent.message", content: [{ type: "text", text: "Answer" }] } as SessionEvent;

async function payloadFor(messages: ModelMessage[]) {
  const runtime = createPiModelRuntime({ model: "claude-opus-5-5", apiKey: "offline-test", provider: "anthropic" });
  let payload: any;
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  runtime.models = { ...runtime.models, streamSimple: ((model: any, context: any, options: any) =>
    streamSimple(model, context, { ...options, apiKey: "offline-test", onPayload: (value: unknown) => {
      payload = structuredClone(value);
      throw new Error("Captured before network");
    } })) as typeof runtime.models.streamSimple };
  // These text-only fixtures already match LanguageModelV3's prompt shape.
  // Bypass SDK prompt validation so malformed pre-fix histories reach Pi's
  // actual payload builder, including its synthetic-result transformation.
  const response = await toAiSdkLanguageModel(runtime).doStream({ prompt: messages as any });
  const reader = response.stream.getReader();
  while (!(await reader.read()).done) { /* drain the offline capture error */ }
  expect(fetch).not.toHaveBeenCalled();
  expect(payload).toBeDefined();
  return payload;
}

function expectValidToolPairs(payload: any) {
  const messages = payload.messages as any[];
  expect(JSON.stringify(messages).includes("No result provided")).toBe(false);
  for (const [i, message] of messages.entries()) {
    const content = Array.isArray(message.content) ? message.content : [];
    const calls = content.filter((p: any) => p.type === "tool_use").map((p: any) => p.id);
    if (calls.length) {
      expect(message.role).toBe("assistant");
      expect(messages[i + 1]?.role).toBe("user");
      const outputs = messages[i + 1].content.filter((p: any) => p.type === "tool_result").map((p: any) => p.tool_use_id);
      expect([...outputs].sort()).toEqual([...calls].sort());
      expect(new Set(outputs).size).toBe(outputs.length);
    }
    for (const output of content.filter((p: any) => p.type === "tool_result")) {
      const previous = messages[i - 1];
      expect(previous?.role).toBe("assistant");
      expect(previous.content.filter((p: any) => p.type === "tool_use").map((p: any) => p.id)).toContain(output.tool_use_id);
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe("tool ordering in history projection", () => {
  it.each(["sync", "async"])("repairs the incident through the real Anthropic payload builder (%s)", async mode => {
    const messages = mode === "sync" ? eventsToMessages(fixture) : await eventsToMessagesAsync(fixture, async () => null);
    expectValidToolPairs(await payloadFor(messages));
  });

  it("keeps healthy projections byte-identical to the pre-fix implementation", async () => {
    const histories: SessionEvent[][] = [
      healthyPart(fixture),
      [user, start("one"), reasoning, text, call("a"), call("b"), result("b"), result("a"), start("two"), reasoning, text],
      [user, reasoning, text, call("a"), result("a"), user, text],
      [user, start("one"), text, start("two"), reasoning, text],
    ];
    expect(histories.map(events => digest(eventsToMessages(events)))).toMatchSnapshot();
    for (const events of histories) {
      expect(JSON.stringify(await eventsToMessagesAsync(events, async () => null))).toBe(JSON.stringify(eventsToMessages(events)));
    }
  });

  it.each([false, true])("preserves text-only lifecycle histories byte-for-byte (spanned=%s)", async spanned => {
    const events = [user, ...(spanned ? [start("one")] : []), text,
      { type: "session.status_idle" } as SessionEvent, { type: "session.status_running" } as SessionEvent, text];
    // The legacy projection ignores these lifecycle events and coalesces text.
    const expected = JSON.stringify(eventsToMessages([user, text, text]));
    expect(JSON.stringify(eventsToMessages(events))).toBe(expected);
    expect(JSON.stringify(await eventsToMessagesAsync(events, async () => null))).toBe(expected);
  });

  it("retains genuinely unanswered calls across a new user message", async () => {
    const events = [user, start("one"), call("unanswered"), user, start("two"), call("new"), result("new")];
    expect(eventsToMessages(events).map(m => m.role)).toEqual(["user", "assistant", "user", "assistant", "tool"]);
    expect(digest(eventsToMessages(events))).toMatchSnapshot();
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(eventsToMessages(events));
  });

  it("never merges two separate model requests with unanswered calls", async () => {
    const events = [user, start("one"), call("unanswered"), start("two"), call("new"), result("new")];
    const messages = eventsToMessages(events);
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(messages);
  });

  it("repairs both sides of a summary boundary and applies result elisions", async () => {
    const broken = [user, start("one"), reasoning, call("a"), call("b"), result("b"), text, call("c"), result("a"), result("c")];
    const boundary = { type: "agent.thread_context_compacted", summary: [{ type: "text", text: "Summary" }],
      metadata: { preserved_tail: { minTokens: 10000, maxTokens: 40000, minMessages: 5 }, tool_result_elisions: [{ tool_call_id: "a", chars: 8 }] } } as SessionEvent;
    const events = [...broken, boundary, user, start("two"), call("d"), call("e"), result("e"), call("f"), result("d"), result("f")];
    const messages = eventsToMessages(events);
    expect(JSON.stringify(messages)).toContain("tool result elided during compaction: 8 chars");
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(messages);
    expectValidToolPairs(await payloadFor(messages));
  });

  it.runIf(evidence)("projects the exact private incident log without synthetic or orphan results", async () => {
    expectValidToolPairs(await payloadFor(eventsToMessages(evidence!)));
    expectValidToolPairs(await payloadFor(await eventsToMessagesAsync(evidence!, async () => null)));
  });

  it.runIf(evidence)("keeps the exact private healthy portion byte-identical", () => {
    expect(digest(eventsToMessages(healthyPart(evidence!)))).toMatchSnapshot();
  });
});
