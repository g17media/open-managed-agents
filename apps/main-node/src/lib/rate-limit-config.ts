import type { MemoryGatesOpts } from "@open-managed-agents/rate-limit/adapters/memory";

const SETTINGS = [
  ["OMA_RATE_LIMIT_API_WRITES_PER_MINUTE", "apiWrite", 60],
  ["OMA_RATE_LIMIT_SESSIONS_PER_TENANT_PER_MINUTE", "sessionsTenant", 30],
  ["OMA_RATE_LIMIT_AUTH_IP_PER_MINUTE", "authIp", 60],
  ["OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE", "authSendIp", 10],
  ["OMA_RATE_LIMIT_AUTH_SEND_EMAIL_PER_MINUTE", "authSendEmail", 3],
] as const;

/** Resolve once at boot. Zero points means unlimited in the memory adapter. */
export function parseRateLimitConfig(
  env: Record<string, string | undefined>,
  warn: (name: string, value: string, defaultPoints: number) => void = (name, value, defaultPoints) => {
    console.warn(`Invalid ${name}=${JSON.stringify(value)}; using default ${defaultPoints}/minute`);
  },
): Required<MemoryGatesOpts> {
  const config = {} as Required<MemoryGatesOpts>;
  for (const [name, gate, defaultPoints] of SETTINGS) {
    const raw = env[name];
    let points: number = defaultPoints;
    if (raw !== undefined) {
      const value = raw.trim();
      const parsed = value.toLowerCase() === "off" ? 0 : /^\d+$/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        points = parsed;
      } else {
        warn(name, raw, defaultPoints);
      }
    }
    config[gate] = { points, durationSec: 60 };
  }
  return config;
}
