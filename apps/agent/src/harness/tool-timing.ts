// Per-tool-call timing for the default harness.
//
// The AI SDK runs a step's tools before `onStepFinish` fires, so the
// `agent.tool_use` and `agent.tool_result` events the loop writes there
// land microseconds apart — their `processed_at` can never measure how
// long a tool took. Wrapping each tool's `execute` is the only place the
// harness observes the true start/settle of a call. The record is keyed
// by the AI SDK's `toolCallId` (which is also the tool_use event id) and
// surfaced on the events through `EventBase.metadata`, the documented
// wire-compatible extension slot — no new event types, no schema change.

export const TOOL_TIMING_KIND = "tool_timing" as const;

export type ToolTimingRecord = {
  /** ISO-8601 (ms precision) when execute() was invoked. */
  started_at: string;
  /** ISO-8601 (ms precision) when execute() resolved or rejected. */
  ended_at: string;
  duration_ms: number;
  /** Chars of the result as handed to the model (post-truncation); 0 on throw. */
  output_chars: number;
  /** Pre-truncation total when the tool appended "...(truncated, total N chars)". */
  output_chars_total?: number;
  is_error?: true;
};

// `type` (not `interface`) all the way down, ToolTimingRecord included:
// object type ALIASES get an implicit index signature (interfaces, and
// intersections containing one, do not), so these assign straight to
// `EventBase.metadata` (Record<string, unknown>) with no cast. The lax
// consumer-facing twin is `ToolTimingMetadata` in
// packages/api-types/src/types.ts (all-optional).
export type ToolTimingMetadata = ToolTimingRecord & {
  harness: string;
  kind: typeof TOOL_TIMING_KIND;
};

export type ToolUseTimingMetadata = {
  harness: string;
  kind: typeof TOOL_TIMING_KIND;
  started_at: string;
};

export interface InstrumentOptions {
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
}

const TRUNCATION_SUFFIX = /\.\.\.\(truncated, total (\d+) chars\)\s*$/;

/** Size of a tool result in chars: strings as-is, anything else via JSON. */
export function measureOutputChars(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output === undefined || output === null) return 0;
  try {
    return JSON.stringify(output).length;
  } catch {
    return 0;
  }
}

/** Total pre-truncation size when `truncateResult` (tools.ts) clipped the output. */
export function parseTruncatedTotal(output: unknown): number | undefined {
  if (typeof output !== "string") return undefined;
  const m = TRUNCATION_SUFFIX.exec(output);
  return m ? Number(m[1]) : undefined;
}

/**
 * Return a copy of `tools` whose executable entries record a
 * ToolTimingRecord into `timings` under their toolCallId. Entries without
 * `execute` (custom / always_ask tools — the client runs those) are
 * returned by reference, untouched, so `!tools[name]?.execute` checks
 * downstream still classify them correctly.
 */
export function instrumentToolTimings<T extends Record<string, any>>(
  tools: T,
  opts: InstrumentOptions = {},
): { tools: T; timings: Map<string, ToolTimingRecord> } {
  const now = opts.now ?? (() => Date.now());
  const timings = new Map<string, ToolTimingRecord>();
  const wrapped: Record<string, any> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const original = tool.execute.bind(tool);
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options: { toolCallId?: string } & Record<string, unknown>) => {
        const t0 = now();
        const record = (output: unknown, isError: boolean): void => {
          const t1 = now();
          const rec: ToolTimingRecord = {
            started_at: new Date(t0).toISOString(),
            ended_at: new Date(t1).toISOString(),
            duration_ms: Math.max(0, t1 - t0),
            output_chars: isError ? 0 : measureOutputChars(output),
          };
          const total = isError ? undefined : parseTruncatedTotal(output);
          if (total !== undefined) rec.output_chars_total = total;
          if (isError) rec.is_error = true;
          if (options?.toolCallId) timings.set(options.toolCallId, rec);
        };
        try {
          const output = await original(input, options);
          record(output, false);
          return output;
        } catch (err) {
          record(undefined, true);
          throw err;
        }
      },
    };
  }
  return { tools: wrapped as T, timings };
}

export function toolTimingMetadata(record: ToolTimingRecord, harness: string): ToolTimingMetadata {
  return { harness, kind: TOOL_TIMING_KIND, ...record };
}

export function toolUseTimingMetadata(record: ToolTimingRecord, harness: string): ToolUseTimingMetadata {
  return { harness, kind: TOOL_TIMING_KIND, started_at: record.started_at };
}
