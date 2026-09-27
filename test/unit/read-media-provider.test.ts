import { describe, expect, it } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { SessionEvent } from "@open-managed-agents/shared";
import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import type { HarnessContext, HarnessRuntime } from "../../apps/agent/src/harness/interface";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { eventsToMessages, eventsToMessagesAsync } from "../../apps/agent/src/runtime/history";

// This runs in the root workerd pool: exercise the real Anthropic adapter and
// DefaultHarness on CF, with only sandbox IO and HTTP replaced by local fakes.
describe("read media through DefaultHarness and Anthropic", () => {
  // Catches wrong image/document kind, MIME, bytes and replay loss; does not catch
  // Pi conversion or tool races, covered by the agent harness suites.
  it.each([
    ["jpeg", "image", "image/jpeg", "image-data"],
    ["pdf", "document", "application/pdf", "file-data"],
  ])("sends the same %s block live and after history replay", async (ext, kind, mime, outputType) => {
    const data = "AAH+/w==";
    const input = { file_path: `/workspace/file.${ext}` };
    const agent = {
      id: "agent-test", name: "test", model: "claude-sonnet-4-6", system: "Read the file",
      tools: [{ type: "agent_toolset_20260401" }],
    } as HarnessContext["agent"];
    const sandbox = { exec: async () => `exit=0\n${data}`, readFile: async () => "", writeFile: async () => "ok" };
    const tools = await buildTools(agent, sandbox as never);
    const events: SessionEvent[] = [{ type: "user.message", content: [{ type: "text", text: "Read the file" }] }];
    const requests: Array<{ messages: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }> }> = [];
    let first = true;
    const model = createAnthropic({ apiKey: "test-placeholder", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const content = first
        ? { type: "tool_use", id: "read-call", name: "read", input: {} }
        : { type: "text", text: "" };
      const chunks = [
        { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: agent.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: content },
        { type: "content_block_delta", index: 0, delta: first ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: "Done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      first = false;
      return new Response(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } })("claude-sonnet-4-6");
    const noop = async () => {};
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: (event: SessionEvent) => events.push(event) },
      sandbox, broadcast: (event: SessionEvent) => events.push(event), pendingConfirmations: [],
      broadcastStreamStart: noop, broadcastChunk: noop, broadcastStreamEnd: noop,
      broadcastThinkingStart: noop, broadcastThinkingChunk: noop, broadcastThinkingEnd: noop,
      broadcastToolInputStart: noop, broadcastToolInputChunk: noop, broadcastToolInputEnd: noop, reportUsage: noop,
    } as unknown as HarnessRuntime;
    const ctx = { agent, tools, model, runtime, systemPrompt: "Read the file", session_id: "media", userMessage: events[0], env: {} } as HarnessContext;
    await new DefaultHarness().run(ctx);
    const media = (request: typeof requests[number]) => request.messages.flatMap(m => m.content).filter(p => p.type === "tool_result").map(p => p.content);
    const expected = [[{ type: kind, source: { type: "base64", media_type: mime, data } }]];
    expect(media(requests[1])).toEqual(expected);

    const sync = eventsToMessages(events);
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(sync);
    const output = sync.filter(m => m.role === "tool").flatMap(m => m.content).find(p => p.type === "tool-result");
    expect(output).toMatchObject({ output: { type: "content", value: [{ type: outputType, mediaType: mime, data }] } });
    events.push({ type: "user.message", content: [{ type: "text", text: "Describe it again" }] });
    await new DefaultHarness().run(ctx);
    expect(media(requests[2])).toEqual(expected);
  });
});
