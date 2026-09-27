import type { ContentBlock } from "@open-managed-agents/shared";

let maxToolResultChars = 50_000;
export function configureToolResultLimit(limit?: number): void {
  maxToolResultChars = typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.floor(limit)) : 50_000;
}
export function toolResultMaxChars(): number { return maxToolResultChars; }

/** Bound the canonical event shape, including legacy events on replay. */
export function capToolResultContent(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === "string") return truncateMcpText(content, maxToolResultChars);
  return (capMcpResult({ content }, maxToolResultChars, true) as { content: ContentBlock[] }).content;
}

/** Bound MCP results before persistence as well as before model conversion.
 * Text shares one budget across blocks. Binary data has a separate budget:
 * it is omitted whole, never sliced into an invalid image/document.
 */
export function capMcpResult(output: unknown, maxChars = maxToolResultChars, wireContent = false): unknown {
  const source = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
  const parts = Array.isArray(source?.content) ? source.content : undefined;
  if (!parts) return truncateMcpText(typeof output === "string" ? output : JSON.stringify(output) ?? String(output), maxChars);

  let binaryLeft = Math.max(maxChars * 40, 2_000_000);
  const normalized = parts.map((part: unknown) => {
    if (part && typeof part === "object") {
      const b = part as Record<string, unknown>;
      // Match the converter's binary predicate exactly. Malformed binary
      // blocks become JSON text and must use the text budget instead.
      if ((b.type === "image" || b.type === "audio") && typeof b.data === "string" && typeof b.mimeType === "string") {
        if (b.data.length <= binaryLeft) { binaryLeft -= b.data.length; return b; }
        return { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" };
      }
      if (wireContent && (b.type === "image" || b.type === "document") && b.source && typeof b.source === "object") {
        const source = b.source as Record<string, unknown>;
        if (source.type === "base64" && typeof source.data === "string") {
          if (source.data.length <= binaryLeft) { binaryLeft -= source.data.length; return b; }
          return { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" };
        }
        if (source.type === "url" || source.type === "file") return b;
      }
      if (b.type === "resource" && b.resource && typeof b.resource === "object" && "blob" in b.resource && typeof b.resource.blob === "string") {
        const size = JSON.stringify(b).length;
        if (size <= binaryLeft) { binaryLeft -= size; return b; }
        return { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" };
      }
      if (b.type === "text" && typeof b.text === "string") return b;
    }
    return { type: "text", text: JSON.stringify(part) ?? String(part) };
  });
  const total = normalized.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0);
  let left = maxChars;
  const content: Record<string, unknown>[] = [];
  for (const b of normalized) {
    if (typeof b.text !== "string") { content.push(b); continue; }
    if (left <= 0) continue;
    const text = truncateMcpText(b.text, left, total);
    content.push({ ...b, text });
    left -= b.text.length;
  }
  if (total > maxChars) {
    const lastText = [...content].reverse().find(b => typeof b.text === "string");
    if (lastText && !/\n\.\.\.\(truncated, total \d{1,16} chars\)$/.test(lastText.text as string)) {
      lastText.text += `\n...(truncated, total ${total} chars)`;
    }
  }
  // structuredContent often duplicates the complete document. Preserve it
  // for small responses only; otherwise it bypasses the text budget on replay.
  const extras = { ...source };
  delete extras.content;
  const extraSize = JSON.stringify(extras).length;
  if (extraSize > Math.max(0, left)) {
    return { ...(source?.isError !== undefined ? { isError: source.isError } : {}), content };
  }
  return { ...extras, content };
}

export function truncateMcpText(text: string, cap = maxToolResultChars, total = text.length): string {
  // Conversion follows execution/persistence. Keep our bounded suffix
  // intact, but never trust arbitrarily long tool-supplied numeric markers.
  const suffix = /\n\.\.\.\(truncated, total \d{1,16} chars\)$/.exec(text);
  if (suffix && suffix.index <= cap) return text;
  return text.length > cap ? text.slice(0, cap) + `\n...(truncated, total ${total} chars)` : text;
}
