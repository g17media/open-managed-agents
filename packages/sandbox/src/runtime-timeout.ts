/** HTTP grace lets the runtime report its own command timeout first. */
export const RUNTIME_TIMEOUT_GRACE_MS = 30_000;
export const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 120_000;
// Belljar defaults: image pull 600s + readiness 120s; OMA startup up to
// 600s. Keep that lifecycle wait separate from the actual command budget.
export const DEFAULT_LIFECYCLE_REQUEST_TIMEOUT_MS = 1_350_000;

export function lifecycleRequestTimeoutMs(value: number = DEFAULT_LIFECYCLE_REQUEST_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new RangeError("Belljar lifecycle timeout must be a positive integer within the Node timer range");
  }
  return value;
}

/** Shared by every Belljar request, including exec callers outside the harness. */
export function runtimeRequestTimeoutMs(body?: { timeoutMs?: unknown }): number {
  const timeoutMs = body?.timeoutMs;
  if (timeoutMs === undefined) return DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
  // Node timers overflow to 1ms outside this range. Reject instead of silently
  // aborting before the runtime, or turning an invalid limit into an infinite wait.
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1 - RUNTIME_TIMEOUT_GRACE_MS) {
    throw new RangeError("Belljar timeoutMs must be a positive integer within the Node timer range");
  }
  return timeoutMs + RUNTIME_TIMEOUT_GRACE_MS;
}
