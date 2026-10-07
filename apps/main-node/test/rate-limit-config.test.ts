import { describe, expect, it, vi } from "vitest";
import { buildMemoryGates } from "@open-managed-agents/rate-limit/adapters/memory";
import { parseRateLimitConfig } from "../src/lib/rate-limit-config";

const settings = [
  ["OMA_RATE_LIMIT_API_WRITES_PER_MINUTE", "apiWrite", 60],
  ["OMA_RATE_LIMIT_SESSIONS_PER_TENANT_PER_MINUTE", "sessionsTenant", 30],
  ["OMA_RATE_LIMIT_AUTH_IP_PER_MINUTE", "authIp", 60],
  ["OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE", "authSendIp", 10],
  ["OMA_RATE_LIMIT_AUTH_SEND_EMAIL_PER_MINUTE", "authSendEmail", 3],
] as const;

describe("Node rate-limit configuration", () => {
  it("preserves all defaults when unset", () => {
    const warn = vi.fn();
    const config = parseRateLimitConfig({}, warn);
    for (const [, gate, points] of settings) {
      expect(config[gate]).toEqual({ points, durationSec: 60 });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(settings)("overrides %s independently", (name, gate) => {
    const config = parseRateLimitConfig({ [name]: " 600 " });
    expect(config[gate]).toEqual({ points: 600, durationSec: 60 });
    for (const [, other, points] of settings) {
      if (other !== gate) expect(config[other]?.points).toBe(points);
    }
  });

  it.each(["0", "off", " OFF "])("disables all selected gates with %s", (value) => {
    const warn = vi.fn();
    const config = parseRateLimitConfig(Object.fromEntries(settings.map(([name]) => [name, value])), warn);
    for (const [, gate] of settings) expect(config[gate]?.points).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", " ", "-1", "1.5", "NaN", "Infinity", "600abc", "1e3", "0x10", "9007199254740992"])(
    "warns and falls back for invalid value %j", (value) => {
      const warn = vi.fn();
      const config = parseRateLimitConfig(Object.fromEntries(settings.map(([name]) => [name, value])), warn);
      for (const [name, gate, points] of settings) {
        expect(config[gate]).toEqual({ points, durationSec: 60 });
        expect(warn).toHaveBeenCalledWith(name, value, points);
      }
      expect(warn).toHaveBeenCalledTimes(5);
    },
  );

  it("accepts the maximum safe integer", () => {
    expect(parseRateLimitConfig({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: String(Number.MAX_SAFE_INTEGER) }).apiWrite.points)
      .toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("configured memory gates", () => {
  it.each(settings)("consumes configured points for %s and refills after one minute", async (name, gate) => {
    vi.useFakeTimers();
    try {
      const gates = buildMemoryGates(parseRateLimitConfig({ [name]: "2" }));
      expect(await gates[gate].consume("principal")).toEqual({ ok: true });
      expect(await gates[gate].consume("principal")).toEqual({ ok: true });
      expect(await gates[gate].consume("principal")).toEqual({ ok: false, retryAfter: 60 });
      vi.advanceTimersByTime(1250);
      expect(await gates[gate].consume("principal")).toEqual({ ok: false, retryAfter: 59 });
      expect(await gates[gate].consume("other")).toEqual({ ok: true });
      vi.advanceTimersByTime(58_750);
      expect(await gates[gate].consume("principal", 2)).toEqual({ ok: true });
    } finally { vi.useRealTimers(); }
  });

  it.each(settings)("allows unlimited consumption when %s is disabled", async (name, gate) => {
    const gates = buildMemoryGates(parseRateLimitConfig({ [name]: "off" }));
    for (let i = 0; i < 100; i++) {
      expect(await gates[gate].consume("principal", 1000)).toEqual({ ok: true });
    }
  });

  it("allows two transform starts and retirement with the recommended write budget", async () => {
    const gates = buildMemoryGates(parseRateLimitConfig({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: "600" }));
    for (let i = 0; i < 33 * 2 + 20; i++) {
      expect(await gates.apiWrite.consume("shared-api-key")).toEqual({ ok: true });
    }
  });
});
