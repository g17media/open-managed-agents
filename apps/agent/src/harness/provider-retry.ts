import { AuthError, BillingError, ModelError } from "@open-managed-agents/shared";
import { isContextLengthError } from "./compaction";

export interface ProviderRetryConfig {
  /** Extra attempts after the initial request, shared across the turn. */
  attempts: number;
  backoffMs: number[];
}

export interface ProviderRetryEnv {
  OMA_MODEL_RETRY_ATTEMPTS?: string;
  OMA_MODEL_RETRY_BACKOFF_MS?: string;
}

const DEFAULT_BACKOFF_MS = [5000, 15000, 45000, 90000];
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const TERMINAL_STATUS = new Set([400, 401, 402, 403, 404, 413, 422]);
const PROVIDER_TYPE = /\b(overloaded_error|rate_limit_error|api_error)\b/i;
const NETWORK_FAILURE = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET)\b|fetch failed|socket hang up|\bterminated\b|other side closed/i;

type ErrorRecord = Record<string, unknown>;

// Classification wrappers preserve cause; AI SDK exhaustion uses errors and
// lastError. Walk both, plus Anthropic JSON bodies, without trusting cycles.
function errorRecords(error: unknown): ErrorRecord[] {
  const records: ErrorRecord[] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length && records.length < 100) {
    const value = pending.shift();
    if (typeof value === "string") {
      records.push({ message: value });
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as ErrorRecord;
    records.push(record);
    pending.push(record.cause, record.lastError, record.error);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
    if (typeof record.responseBody === "string") {
      try { pending.push(JSON.parse(record.responseBody)); }
      catch { pending.push({ message: record.responseBody }); }
    } else if (record.responseBody) pending.push(record.responseBody);
  }
  return records;
}

function message(record: ErrorRecord): string {
  return typeof record.message === "string" ? record.message : "";
}

function status(record: ErrorRecord): number | undefined {
  const code = record.statusCode ?? record.status;
  if (typeof code === "number") return code;
  // onError's legacy diagnostic format, or a provider's HTTP status text.
  const match = message(record).match(/\[(\d{3})\]|\b(?:HTTP(?: status)?|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

export function isTransientProviderError(error: unknown): boolean {
  const records = errorRecords(error);
  // Explicit exclusions win over any transient metadata in the cause chain.
  if (records.some(record => record instanceof BillingError || record instanceof AuthError
    || record.name === "AbortError" || /\babort(?:ed)?\b|silent_stop/i.test(message(record))
    || isContextLengthError(message(record)) || TERMINAL_STATUS.has(status(record) ?? 0))) return false;
  return records.some(record => TRANSIENT_STATUS.has(status(record) ?? 0)
    || PROVIDER_TYPE.test(String(record.type ?? "")) || PROVIDER_TYPE.test(message(record))
    || NETWORK_FAILURE.test(message(record)) || NETWORK_FAILURE.test(String(record.code ?? ""))
    || record instanceof ModelError && message(record) === "model stream errored (no diagnostic captured)");
}

/** Short diagnostic for server logs; never adds an API event type. */
export function providerErrorLabel(error: unknown): string {
  const records = errorRecords(error);
  for (const record of records) {
    const code = status(record);
    if (code !== undefined) return String(code);
  }
  for (const record of records) {
    const type = `${record.type ?? ""} ${message(record)}`.match(PROVIDER_TYPE)?.[1];
    if (type) return type;
  }
  return "network/stream";
}

export function readProviderRetryConfig(env: ProviderRetryEnv = {}): ProviderRetryConfig {
  // Node hosts supply process env; Workers/custom harnesses can supply bindings.
  const fallback = typeof process !== "undefined" ? process.env : {};
  const attemptsRaw = env.OMA_MODEL_RETRY_ATTEMPTS ?? fallback.OMA_MODEL_RETRY_ATTEMPTS ?? "4";
  const attempts = /^\d+$/.test(attemptsRaw) && Number.isSafeInteger(Number(attemptsRaw))
    ? Number(attemptsRaw) : 4;
  const backoffRaw = env.OMA_MODEL_RETRY_BACKOFF_MS ?? fallback.OMA_MODEL_RETRY_BACKOFF_MS;
  const values = backoffRaw?.split(",").map(value => value.trim());
  const backoffMs = values?.length && values.every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
    ? values.map(Number) : [...DEFAULT_BACKOFF_MS];
  return { attempts, backoffMs };
}

function milliseconds(value: unknown, multiplier: number): number | undefined {
  if (typeof value !== "number" && typeof value !== "string" || value === "") return undefined;
  const ms = Number(value) * multiplier;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 120000) : undefined;
}

function retryAfterHeader(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as ErrorRecord;
  if (typeof record.get === "function") return record.get.call(headers, "retry-after");
  return Object.entries(record).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
}

/** attempt is one-based: 1 is the first extra attempt. Retry-after has no jitter. */
export function retryDelayMs(attempt: number, error: unknown, config: ProviderRetryConfig): number {
  for (const record of errorRecords(error)) {
    const header = retryAfterHeader(record.responseHeaders ?? record.headers);
    if (header !== undefined && header !== null) {
      const seconds = milliseconds(header, 1000);
      if (seconds !== undefined) return seconds;
      if (typeof header === "string" && !/^-?\d+(?:\.\d+)?$/.test(header)) {
        const date = Date.parse(header);
        if (Number.isFinite(date)) return Math.min(120000, Math.max(0, date - Date.now()));
      }
    }
    for (const field of ["retry_after_ms", "retryAfterMs"]) {
      const ms = milliseconds(record[field], 1);
      if (ms !== undefined) return ms;
    }
    for (const field of ["retry_after", "retryAfter", "retry-after"]) {
      const ms = milliseconds(record[field], 1000);
      if (ms !== undefined) return ms;
    }
  }
  const schedule = config.backoffMs.length ? config.backoffMs : DEFAULT_BACKOFF_MS;
  const base = schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)]!;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** An interrupt during backoff rejects through the normal runtime abort path. */
export function waitForProviderRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
