---
"@open-managed-agents/agent": minor
"@open-managed-agents/api-types": minor
---

Default harness records per-tool-call timing. `agent.tool_result` events for tools executed in-process now carry `metadata: { harness, kind: "tool_timing", started_at, ended_at, duration_ms, output_chars, output_chars_total?, is_error? }`, and the matching `agent.tool_use` carries `started_at`. Previously both events were written after execution inside the same `onStepFinish`, so their `processed_at` could not measure a tool's duration. Additive and wire-compatible (`EventBase.metadata`). MCP tool results are wrapped but not yet annotated.
