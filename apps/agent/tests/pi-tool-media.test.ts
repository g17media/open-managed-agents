import { describe, expect, it } from "vitest";
import { toPiToolResult } from "../src/harness/pi-ai-sdk";
import { toolOutputToPi } from "../src/harness/pi-loop";

const converters = {
  sdk: (value: unknown[]) => toPiToolResult({
    type: "tool-result", toolCallId: "read", toolName: "read",
    output: { type: "content", value },
  } as Parameters<typeof toPiToolResult>[0], 0).content,
  loop: (value: unknown[]) => toolOutputToPi({ type: "content", value }),
};

describe.each(Object.entries(converters))("Pi %s tool media", (_name, convert) => {
  // Each case catches its own shape being omitted or its MIME/data being rewritten.
  // None catches dispatch ordering; harness-tool-execution.test.ts covers that.
  it.each([
    ["image-data", { type: "image-data", data: "AAH+/w==", mediaType: "image/jpeg" }],
    ["file-data", { type: "file-data", data: "AAH+/w==", mediaType: "image/jpeg" }],
    ["V3 file", { type: "file", data: { type: "data", data: "AAH+/w==" }, mediaType: "image/jpeg" }],
    ["byte file", { type: "file", data: new Uint8Array([0, 1, 254, 255]), mediaType: "image/jpeg" }],
  ])("preserves %s bytes, MIME and surrounding text order", (_shape, part) => {
    expect(convert([{ type: "text", text: "before" }, part, { type: "text", text: "after" }])).toEqual([
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/jpeg", data: "AAH+/w==" },
      { type: "text", text: "after" },
    ]);
  });

  it.each([
    ["URL object", { type: "file", mediaType: "image/png", data: new URL("https://example.test/a.png") }],
    ["V3 URL", { type: "file", mediaType: "image/png", data: { type: "url", url: "https://example.test/a.png" } }],
    ["PDF", { type: "file", mediaType: "application/pdf", data: { type: "data", data: "JVBERg==" } }],
  ])("turns %s into a text notice", (_shape, part) => {
    const result = convert([part]);
    expect(result).toEqual([{ type: "text", text: expect.stringMatching(/omitted/) }]);
    expect(JSON.stringify(result)).not.toContain("JVBERg==");
  });
});

describe("Pi replay binary budget", () => {
  // This catches per-image instead of aggregate capping; the matrix above catches MIME/order bugs.
  it("shares the two-million-character budget across image shapes without clipping bytes", () => {
    const data = "a".repeat(1_000_000);
    expect(toolOutputToPi({ type: "content", value: [
      { type: "image-data", mediaType: "image/png", data },
      { type: "file", mediaType: "image/jpeg", data: { type: "data", data } },
      { type: "text", text: "caption" },
      { type: "file-data", mediaType: "image/webp", data: "AAAA" },
    ] })).toEqual([
      { type: "image", mimeType: "image/png", data },
      { type: "image", mimeType: "image/jpeg", data },
      { type: "text", text: "caption" },
      { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" },
    ]);
  });
});
