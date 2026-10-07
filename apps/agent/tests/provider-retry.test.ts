import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, BillingError, ModelError, classifyExternalError } from "@open-managed-agents/shared";
import { createAnthropic } from "@ai-sdk/anthropic";
import { RetryError } from "ai";
import { isTransientProviderError, readProviderRetryConfig, retryDelayMs, waitForProviderRetry } from "../src/harness/provider-retry";

const httpError = (statusCode: number, extra = {}) => Object.assign(new Error("provider rejected request"), { statusCode, ...extra });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("provider retry classification", () => {
  it.each([408, 409, 429, 500, 502, 503, 504, 529])("retries HTTP %s through classified causes", status => {
    expect(isTransientProviderError(classifyExternalError(httpError(status)))).toBe(true);
    expect(isTransientProviderError(new ModelError(`Overloaded [${status}]`))).toBe(true);
  });
  it.each([400, 401, 402, 403, 404, 413, 422])("does not retry HTTP %s even with a transient message", status => {
    expect(isTransientProviderError(httpError(status, { message: "fetch failed overloaded_error" }))).toBe(false);
  });
  it.each(["overloaded_error", "rate_limit_error", "api_error"])("recognizes Anthropic %s in bodies and messages", type => {
    expect(isTransientProviderError(Object.assign(new Error("rejected"), { responseBody: JSON.stringify({ type: "error", error: { type, message: "failure" } }) }))).toBe(true);
    expect(isTransientProviderError(new ModelError(`provider: ${type}`))).toBe(true);
  });
  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "fetch failed", "socket hang up", "terminated", "other side closed"])("recognizes network failure %s", message => {
    expect(isTransientProviderError(classifyExternalError(new Error(message)))).toBe(true);
    expect(isTransientProviderError(new Error("request failed", { cause: { code: message } }))).toBe(true);
  });
  it.each([
    new AuthError("overloaded_error"), new BillingError("fetch failed"),
    new ModelError("prompt is too long [529]"), new ModelError("silent_stop: terminated"),
    Object.assign(new Error("fetch failed"), { name: "AbortError" }),
    new Error("request aborted"), new Error("ordinary failure"),
  ])("excludes fatal/context/silent/abort/unknown failures: %s", error => {
    expect(isTransientProviderError(error)).toBe(false);
  });
  it("recognizes the undiagnosed stream ModelError only", () => {
    expect(isTransientProviderError(new ModelError("model stream errored (no diagnostic captured)"))).toBe(true);
    expect(isTransientProviderError(new Error("model stream errored (no diagnostic captured)"))).toBe(false);
  });
  it("unwraps exhausted SDK retries and tolerates cyclic causes", () => {
    const wrapped = Object.assign(new Error("Failed after 3 attempts"), { errors: [httpError(529)], lastError: httpError(529) });
    expect(isTransientProviderError(new ModelError("request failed", { cause: wrapped }))).toBe(true);
    const cycle = new Error("unknown");
    Object.assign(cycle, { cause: cycle });
    expect(isTransientProviderError(cycle)).toBe(false);
  });
  it.each(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])("recognizes %s through the SDK's real fetch-error wrapper", async code => {
    const cause = Object.assign(new Error("Connect Timeout Error"), { code });
    const raw = new TypeError("fetch failed", { cause });
    const model = createAnthropic({ apiKey: "test", fetch: async () => { throw raw; } })("claude-sonnet-4-6");
    const wrapped = await model.doStream({ prompt: [] }).catch(error => error);
    expect(wrapped).toMatchObject({ name: "AI_APICallError", isRetryable: true, message: "Cannot connect to API: Connect Timeout Error", cause });
    expect(isTransientProviderError(wrapped)).toBe(true);
    expect(isTransientProviderError(new ModelError("Failed after 3 attempts", {
      cause: new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [wrapped, wrapped, wrapped] }),
    }))).toBe(true);
    expect(isTransientProviderError(new Error("Cannot connect to API: connection failed"))).toBe(true);
  });
  it("recognizes provider timeouts without rejecting messages containing aborted", () => {
    expect(isTransientProviderError(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
    expect(isTransientProviderError({ code: 23, message: "aborted due to timeout" })).toBe(true);
    expect(isTransientProviderError(httpError(529, { message: "exchange aborted by provider" }))).toBe(true);
  });
});

describe("provider retry delays", () => {
  const config = { attempts: 4, backoffMs: [5000, 15000, 45000, 90000], maxWaitMs: 300000 };
  it("uses the default schedule and repeats its last entry (one-based retries)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect([1, 2, 3, 4, 5].map(attempt => retryDelayMs(attempt, new Error(), config))).toEqual([5000, 15000, 45000, 90000, 90000]);
  });
  it.each([0, 0.5, 1])("keeps jitter in bounds with random=%s", random => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    expect(retryDelayMs(2, new Error(), config)).toBe(Math.round(15000 * (0.8 + random * 0.4)));
  });
  it.each([
    [{ responseHeaders: { "retry-after": "17" } }, 17000],
    [{ responseHeaders: { "Retry-After": "999" } }, 120000],
    [{ headers: new Headers({ "retry-after": "3" }) }, 3000],
    [{ retry_after_ms: 250 }, 250], [{ retryAfterMs: 1250 }, 1250],
    [{ retry_after: 7 }, 7000], [{ retryAfter: 0 }, 0],
    [{ responseBody: '{"error":{"retry_after":8}}' }, 8000],
  ])("honors retry-after without jitter: %j", (metadata, expected) => {
    expect(retryDelayMs(1, new ModelError("failure", { cause: httpError(529, metadata) }), config)).toBe(expected);
  });
  it("accepts HTTP dates and ignores invalid retry-after", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(retryDelayMs(1, httpError(503, { responseHeaders: { "retry-after": "Wed, 07 Oct 2026 00:01:00 GMT" } }), config)).toBe(60000);
    expect(retryDelayMs(1, httpError(503, { retry_after: -1, responseHeaders: { "retry-after": "invalid" } }), config)).toBe(5000);
  });
  it("reads env values, accepts zero attempts/delays, and falls back on malformed config", () => {
    expect(readProviderRetryConfig({})).toEqual(config);
    expect(readProviderRetryConfig({ OMA_MODEL_RETRY_ATTEMPTS: "0", OMA_MODEL_RETRY_BACKOFF_MS: "0, 20", OMA_MODEL_RETRY_MAX_WAIT_MS: "0" })).toEqual({ attempts: 0, backoffMs: [0, 20], maxWaitMs: 0 });
    for (const invalid of ["-1", "NaN", "1.5", "", "2oops"]) {
      expect(readProviderRetryConfig({ OMA_MODEL_RETRY_ATTEMPTS: invalid }).attempts).toBe(4);
      expect(readProviderRetryConfig({ OMA_MODEL_RETRY_MAX_WAIT_MS: invalid }).maxWaitMs).toBe(300000);
    }
    for (const invalid of ["", "1,-2", "1,", "invalid"]) {
      expect(readProviderRetryConfig({ OMA_MODEL_RETRY_BACKOFF_MS: invalid }).backoffMs).toEqual(config.backoffMs);
    }
  });
  it("aborts the backoff immediately and clears its timer/listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForProviderRetry(90000, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("handles pre-aborted signals and cleans up after a completed wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waitForProviderRetry(50, controller.signal);
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(remove).toHaveBeenCalled();
    controller.abort();
    await expect(waitForProviderRetry(50, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
