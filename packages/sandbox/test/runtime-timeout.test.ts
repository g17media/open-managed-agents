import { describe, expect, it } from "vitest";
import { runtimeRequestTimeoutMs } from "../src/runtime-timeout";

describe("runtimeRequestTimeoutMs", () => {
  it.each([undefined, {}, { path: "/file" }])("bounds calls without a command timeout", (body) => {
    expect(runtimeRequestTimeoutMs(body)).toBe(120_000);
  });
  it.each([1, 5_000, 120_000, 600_000, 900_000])("adds transport grace to %i without capping command time", (timeoutMs) => {
    expect(runtimeRequestTimeoutMs({ timeoutMs })).toBe(timeoutMs + 30_000);
  });
  it.each([0, -1, NaN, Infinity, 1.5, "600000", null, 2 ** 31 - 30_000])("rejects invalid or overflowing command timeouts: %s", (timeoutMs) => {
    expect(() => runtimeRequestTimeoutMs({ timeoutMs })).toThrow(RangeError);
  });
});
