import { describe, expect, it } from "vitest";
import { toSessionEventResponse } from "../src/mappers/session-events";
import type { SessionEventView } from "../src/ports/session-events";

describe("tool permission wire fields", () => {
  it.each(["agent.tool_use", "agent.mcp_tool_use"] as const)("retains policy evaluation on %s", type => {
    const event = { id: "call", type, name: "bash", input: {}, processedAt: "2026-09-26T00:00:00Z", mcpServerName: "docs", evaluatedPermission: "ask", evaluation: { type: "always_ask" } } as SessionEventView;
    expect(toSessionEventResponse(event)).toMatchObject({ evaluated_permission: "ask", evaluation: { type: "always_ask" } });
  });
  it("retains confirmation action_type and ordered ids", () => {
    const event = { id: "idle", type: "session.status_idle", processedAt: "2026-09-26T00:00:00Z", stopReason: { type: "requires_action", actionType: "tool_confirmation", eventIds: ["mcp", "bash"] } } as SessionEventView;
    expect(toSessionEventResponse(event)).toMatchObject({ stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["mcp", "bash"] } });
  });
});
