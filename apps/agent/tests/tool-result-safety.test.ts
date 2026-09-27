import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import { buildTools, mcpToModelOutput } from "../src/harness/tools";
import { eventsToMessages, eventsToMessagesAsync } from "../src/runtime/history";

const sandbox = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
const agent = { tools: [{ type: "agent_toolset_20260401" }] } as never;
afterEach(async () => { await buildTools(agent, sandbox as never); });

describe("tool result safety across conversion boundaries", () => {
  it("does not trust an unbounded numeric truncation suffix from a tool", () => {
    const text = "ok\n...(truncated, total " + "9".repeat(300_000) + " chars)";
    const output = mcpToModelOutput({ output: { content: [{ type: "text", text }] } });
    expect(JSON.stringify(output).length).toBeLessThan(50_200);
    const replay = eventsToMessages([{ type: "agent.tool_result", tool_use_id: "read", content: text }]);
    expect(JSON.stringify(replay).length).toBeLessThan(50_300);
  });

  it.each([
    ["JSON fallback", { document: "x".repeat(313_478) }],
    ["non-array content", { content: { document: "x".repeat(313_478) } }],
    ["resource text", { content: [{ type: "resource", resource: { uri: "doc://1", text: "x".repeat(313_478) } }] }],
    ["malformed image fallback", { content: [{ type: "image", data: "x".repeat(313_478) }] }],
    ["non-MCP image shape fallback", { content: [{ type: "image", source: { type: "base64", data: "x".repeat(313_478) } }] }],
  ])("caps %s with a visible suffix", (_name, output) => {
    const result = mcpToModelOutput({ output });
    const text = result.value.map(part => "text" in part ? part.text : "").join("");
    expect(text.length).toBeLessThanOrEqual(50_050);
    expect(text).toMatch(/\.\.\.\(truncated, total \d+ chars\)$/);
  });

  it("shares the binary budget across MCP audio and embedded resources", () => {
    const result = mcpToModelOutput({ output: { content: [
      { type: "audio", mimeType: "audio/wav", data: "a".repeat(1_200_000) },
      { type: "resource", resource: { uri: "doc://1", mimeType: "application/pdf", blob: "b".repeat(1_200_000) } },
    ] } });
    expect(result.value[0]).toMatchObject({ type: "file", mediaType: "audio/wav", data: { data: "a".repeat(1_200_000) } });
    expect(result.value[1]).toMatchObject({ type: "text", text: "[binary tool result omitted: exceeds binary size limit]" });
    expect(JSON.stringify(result)).not.toContain("b".repeat(100));
  });

  it("preserves a bounded native image but omits oversized legacy documents on replay", async () => {
    const events: SessionEvent[] = [{ type: "agent.mcp_tool_result", mcp_tool_use_id: "call", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abcd" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "b".repeat(2_000_001) } },
    ] }];
    const messages = eventsToMessages(events);
    expect(JSON.stringify(messages)).toContain('"data":"abcd"');
    expect(JSON.stringify(messages)).toContain("binary tool result omitted");
    expect(JSON.stringify(messages).length).toBeLessThan(600);
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(messages);
  });

  it.each(["agent.mcp_tool_result", "agent.tool_result"] as const)("caps legacy %s in sync and async replay without rewriting events", async type => {
    const content = [{ type: "text", text: "x".repeat(40_000) }, { type: "text", text: "y".repeat(273_478) }];
    const events = [{ type, tool_use_id: "call", mcp_tool_use_id: "call", content }] as SessionEvent[];
    const before = JSON.stringify(events);
    const sync = eventsToMessages(events);
    expect(JSON.stringify(sync).length).toBeLessThan(50_400);
    expect(JSON.stringify(sync)).toContain("...(truncated, total 313478 chars)");
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(sync);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("bounds legacy string errors and binary error serialization", async () => {
    for (const content of ["x".repeat(313_478), [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(313_478) } }]]) {
      const events = [{ type: "agent.mcp_tool_result", mcp_tool_use_id: "call", content, is_error: true }] as SessionEvent[];
      const result = JSON.stringify(await eventsToMessagesAsync(events, async () => null));
      expect(result.length).toBeLessThan(50_400);
      expect(result).toContain("...(truncated, total");
    }
  });

  it("applies the deployment cap during replay", async () => {
    await buildTools(agent, sandbox as never, { toolResultMaxChars: 1_000 });
    const events: SessionEvent[] = [{ type: "agent.mcp_tool_result", mcp_tool_use_id: "call", content: "x".repeat(2_000) }];
    expect(JSON.stringify(eventsToMessages(events)).length).toBeLessThan(1_400);
  });

  it.each([
    ["read", { file_path: "/big.txt", offset: 1, limit: 2 }, "x".repeat(60_000)],
    ["glob", { pattern: "**/*" }, "exit=0\n" + "file\n".repeat(15_000)],
    ["grep", { pattern: "x", path: "/", output_mode: "content" }, "exit=0\n" + "match\n".repeat(15_000)],
    ["web_fetch", { url: "https://example.com", max_length: 300_000 }, "x".repeat(60_000)],
    ["write", { file_path: "/big.txt", content: "ok" }, "x".repeat(60_000)],
  ])("caps %s execution even when it uses an independent formatter", async (name, args, output) => {
    const tools = await buildTools(agent, { exec: async () => output, readFile: async () => output, writeFile: async () => output } as never, { toolResultMaxChars: 1_000 });
    const result = await tools[name].execute(args, { toolCallId: "call", messages: [] });
    expect(result.length).toBeLessThanOrEqual(1_050);
    expect(result).toMatch(/\.\.\.\(truncated, total \d+ chars\)$/);
  });
});
