import { describe, expect, it } from "vitest";
import { modelCardMaxInputTokens } from "@open-managed-agents/agent/harness/model-card-credentials";
import { createPiModelRuntime, toAiSdkLanguageModel } from "@open-managed-agents/agent/harness/pi-provider";
import { resolveContextWindowTokens } from "@open-managed-agents/agent/harness/default-loop";
import { eventsToMessages } from "@open-managed-agents/agent/runtime/history";
import { decodeRuntimeProducedSessionEvent, encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionEvent } from "@open-managed-agents/shared";

describe("Node model card context budget", () => {
  it("passes the stored card budget through the same builder inputs used by Node", () => {
    const card = { pi_config: { contextWindow: 48_000 } };
    const model = toAiSdkLanguageModel(createPiModelRuntime({
      model: "claude-opus-5-5", apiKey: "test", provider: "anthropic",
      piConfig: card.pi_config, maxInputTokens: modelCardMaxInputTokens(card),
    }));
    expect(resolveContextWindowTokens(model)).toBe(48_000);
  });

  it("uses the conservative runtime fallback for an unknown card without limits", () => {
    const model = toAiSdkLanguageModel(createPiModelRuntime({
      model: "claude-opus-5-5", apiKey: "test", provider: "anthropic",
      maxInputTokens: modelCardMaxInputTokens({ pi_config: null }),
    }));
    expect(resolveContextWindowTokens(model)).toBe(128_000);
  });

  it("keeps tail budgets and elisions after the Node event codec round trip", () => {
    const prefix: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "old".repeat(5_000) }] },
      { type: "agent.tool_use", id: "read", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "read", content: "r".repeat(5_000) },
      { type: "user.message", content: [{ type: "text", text: "continue" }] },
    ];
    const boundary: SessionEvent = {
      id: "boundary", processed_at: "2026-09-27T00:00:00.000Z",
      type: "agent.thread_context_compacted", original_message_count: 4, compacted_message_count: 2,
      summary: [{ type: "text", text: "summary" }],
      metadata: { preserved_tail: { minTokens: 0, maxTokens: 1_000, minMessages: 1 } },
    };
    const roundTrip = encodeRuntimeHistoryEvent(decodeRuntimeProducedSessionEvent(boundary)!) as SessionEvent;
    expect(eventsToMessages([...prefix, roundTrip]).length).toBe(eventsToMessages([...prefix, boundary]).length);
    const elision: SessionEvent = {
      ...boundary, id: "elision", summary: undefined,
      metadata: { kind: "tool_result_elision", tool_result_elisions: [{ tool_call_id: "read", chars: 5_000 }] },
    };
    const replayed = encodeRuntimeHistoryEvent(decodeRuntimeProducedSessionEvent(elision)!) as SessionEvent;
    expect(JSON.stringify(eventsToMessages([...prefix, replayed]))).toContain("[tool result elided during compaction: 5000 chars; re-run the tool if needed]");
  });
});
