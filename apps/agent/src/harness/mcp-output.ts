/** Bound MCP results before persistence as well as before model conversion.
 * Text shares one budget across blocks. Binary data has a separate budget:
 * it is omitted whole, never sliced into an invalid image/document.
 */
export function capMcpResult(output: unknown, maxChars = 50_000): unknown {
  const source = output && typeof output === "object" ? output as Record<string, unknown> : undefined;
  const parts = Array.isArray(source?.content) ? source.content : undefined;
  if (!parts) return truncateMcpText(typeof output === "string" ? output : JSON.stringify(output) ?? String(output), maxChars);

  let binaryLeft = Math.max(maxChars * 40, 2_000_000);
  const normalized = parts.map((part: unknown) => {
    if (part && typeof part === "object") {
      const b = part as Record<string, unknown>;
      if ((b.type === "image" || b.type === "audio") && typeof b.data === "string") {
        if (b.data.length <= binaryLeft) { binaryLeft -= b.data.length; return b; }
        return { type: "text", text: "[binary tool result omitted: exceeds binary size limit]" };
      }
      if (b.type === "resource" && b.resource && typeof b.resource === "object" && "blob" in b.resource) {
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
    if (lastText && !/\n\.\.\.\(truncated, total \d+ chars\)$/.test(lastText.text as string)) {
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

export function truncateMcpText(text: string, cap = 50_000, total = text.length): string {
  // Conversion follows execution/persistence. Keep an existing suffix intact.
  const suffix = /\n\.\.\.\(truncated, total \d+ chars\)$/.exec(text);
  if (suffix && suffix.index <= cap) return text;
  return text.length > cap ? text.slice(0, cap) + `\n...(truncated, total ${total} chars)` : text;
}
