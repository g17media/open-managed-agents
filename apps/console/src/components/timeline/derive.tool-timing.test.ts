// deriveSpans' tool-span timing: when an agent.tool_result carries
// `metadata.kind === "tool_timing"`, the span must come from the harness's
// own started_at/ended_at rather than from the surrounding event
// timestamps, which only bound the model request that requested the call.
// Falls back to those timestamps when the metadata is absent (older logs,
// deployments without the instrumentation).
import { describe, expect, it } from "vitest";
import type { Event } from "../../lib/events";
import { deriveSpans } from "./derive";

describe("deriveSpans — tool_timing metadata", () => {
  it("uses started_at/ended_at for the tool span when tool_timing metadata is present", () => {
    const events: Event[] = [
      {
        type: "session.status_running",
        processed_at: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "agent.tool_use",
        id: "tc_1",
        name: "read",
        processed_at: "2026-01-01T00:00:10.000Z",
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_1",
        processed_at: "2026-01-01T00:00:10.000Z",
        metadata: {
          harness: "default",
          kind: "tool_timing",
          started_at: "2026-01-01T00:00:04.000Z",
          ended_at: "2026-01-01T00:00:09.500Z",
          duration_ms: 5500,
          output_chars: 10,
        },
      },
    ];

    const { spans } = deriveSpans(events);
    const toolSpan = spans.find((s) => s.family === "tool");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.startMs).toBe(4000);
    expect(toolSpan!.durationMs).toBe(5500);
  });

  it("keeps today's behaviour unchanged when no tool_timing metadata is present", () => {
    const events: Event[] = [
      {
        type: "session.status_running",
        processed_at: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "agent.tool_use",
        id: "tc_1",
        name: "read",
        processed_at: "2026-01-01T00:00:10.000Z",
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tc_1",
        processed_at: "2026-01-01T00:00:10.000Z",
      },
    ];

    const { spans } = deriveSpans(events);
    const toolSpan = spans.find((s) => s.family === "tool");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.startMs).toBe(10000);
    expect(toolSpan!.durationMs).toBe(0);
  });
});
