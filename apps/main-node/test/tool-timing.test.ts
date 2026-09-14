// Unit tests for the harness tool-timing instrumentation. Lives in
// main-node because this is the only vitest project on the Node pool
// (the root config runs under workerd). No I/O, no network.
import { describe, it, expect } from "vitest";
import {
  instrumentToolTimings,
  toolTimingMetadata,
  toolUseTimingMetadata,
  TOOL_TIMING_KIND,
} from "@open-managed-agents/agent/harness/tool-timing";

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("instrumentToolTimings", () => {
  it("records start/end/duration/output size keyed by toolCallId", async () => {
    const clock = fakeClock();
    const tools = {
      read: {
        description: "read",
        execute: async (_input: unknown, _opts: { toolCallId: string }) => {
          clock.advance(250);
          return "hello world";
        },
      },
    };
    const { tools: wrapped, timings } = instrumentToolTimings(tools, { now: clock.now });
    const out = await wrapped.read.execute({ file_path: "/x" }, { toolCallId: "tc_1" });
    expect(out).toBe("hello world");
    const rec = timings.get("tc_1")!;
    expect(rec.started_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(rec.ended_at).toBe(new Date(1_700_000_000_250).toISOString());
    expect(rec.duration_ms).toBe(250);
    expect(rec.output_chars).toBe("hello world".length);
    expect(rec.output_chars_total).toBeUndefined();
    expect(rec.is_error).toBeUndefined();
  });

  it("parses the truncation suffix into output_chars_total", async () => {
    const body = "x".repeat(40) + "\n...(truncated, total 123456 chars)";
    const tools = { grep: { execute: async () => body } };
    const { tools: wrapped, timings } = instrumentToolTimings(tools);
    await wrapped.grep.execute({}, { toolCallId: "tc_2" });
    expect(timings.get("tc_2")!.output_chars).toBe(body.length);
    expect(timings.get("tc_2")!.output_chars_total).toBe(123456);
  });

  it("measures non-string results by their JSON length and flags errors", async () => {
    const tools = {
      img: { execute: async () => [{ type: "image", data: "abcd" }] },
      boom: { execute: async () => { throw new Error("nope"); } },
    };
    const { tools: wrapped, timings } = instrumentToolTimings(tools);
    await wrapped.img.execute({}, { toolCallId: "tc_img" });
    expect(timings.get("tc_img")!.output_chars).toBe(JSON.stringify([{ type: "image", data: "abcd" }]).length);
    await expect(wrapped.boom.execute({}, { toolCallId: "tc_boom" })).rejects.toThrow("nope");
    expect(timings.get("tc_boom")!.is_error).toBe(true);
    expect(timings.get("tc_boom")!.output_chars).toBe(0);
  });

  it("leaves tools without execute untouched (custom / always_ask tools)", () => {
    const custom = { description: "client-side" };
    const { tools: wrapped } = instrumentToolTimings({ custom });
    expect(wrapped.custom).toBe(custom);
    expect("execute" in wrapped.custom).toBe(false);
  });

  it("preserves the rest of the tool definition and passes options through", async () => {
    let seen: unknown;
    const tools = {
      t: { description: "d", inputSchema: { kind: "schema" }, execute: async (_i: unknown, o: unknown) => { seen = o; return "ok"; } },
    };
    const { tools: wrapped } = instrumentToolTimings(tools);
    expect(wrapped.t.description).toBe("d");
    expect(wrapped.t.inputSchema).toEqual({ kind: "schema" });
    const opts = { toolCallId: "tc_3", messages: [] };
    await wrapped.t.execute({}, opts);
    expect(seen).toBe(opts);
  });
});

describe("metadata formatting", () => {
  it("builds the wire metadata objects", () => {
    const rec = { started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z", duration_ms: 1000, output_chars: 5 };
    expect(toolTimingMetadata(rec, "default")).toEqual({ harness: "default", kind: TOOL_TIMING_KIND, ...rec });
    expect(toolUseTimingMetadata(rec, "default")).toEqual({ harness: "default", kind: TOOL_TIMING_KIND, started_at: rec.started_at });
  });
});
