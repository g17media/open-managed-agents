type ApiKeyHeader = "x-goog-api-key" | "x-api-key" | "xi-api-key";

/**
 * Providers whose static API key must travel in a header of their own instead of
 * `Authorization: Bearer`: Gemini and Anthropic use API-key headers, and ElevenLabs has no
 * Bearer support at all. The mapping is fixed here, per host, so a request can never choose
 * where a token lands: it can only send the provider's own header (with any placeholder value) to
 * ask for that provider's documented shape. A host absent from this map always gets Bearer.
 */
const API_KEY_HEADER_BY_HOST = new Map<string, ApiKeyHeader>([
  ["generativelanguage.googleapis.com", "x-goog-api-key"],
  ["api.anthropic.com", "x-api-key"],
  ["api.elevenlabs.io", "xi-api-key"],
]);

// Derive the credential strip list from the map so newly supported headers cannot bypass it.
export const API_KEY_HEADERS: ReadonlySet<ApiKeyHeader> = new Set(API_KEY_HEADER_BY_HOST.values());

/**
 * The API-key header to inject into instead of `Authorization`, or undefined to keep Bearer.
 * Requires all three: the host is one whose key header is known, the client sent that header, and
 * the matched credential is a plain static_bearer. Everything else — other hosts, cap_cli/OAuth
 * credentials, git Basic — is untouched by this adaptation.
 */
export function apiKeyHeaderFor(
  url: string,
  requestHeaders: Record<string, string | string[] | undefined>,
  matched: { apiKeyCapable?: boolean },
): ApiKeyHeader | undefined {
  if (matched.apiKeyCapable !== true) return undefined;
  let host: string;
  try { host = new URL(url).hostname; } catch { return undefined; }
  const name = API_KEY_HEADER_BY_HOST.get(host);
  return name !== undefined && requestHeaders[name] !== undefined ? name : undefined;
}
