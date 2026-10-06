// Safe outbound log fields: URL userinfo, paths and queries may contain member data or secrets.
export function requestLogFields(method: string, url: string): { method: string; scheme: string; hostname: string } {
  try {
    const target = new URL(url);
    return { method, scheme: target.protocol.slice(0, -1), hostname: target.hostname };
  } catch {
    // Invalid URLs can themselves contain secrets, so they get constant placeholders.
    return { method, scheme: "unknown", hostname: "unknown" };
  }
}
