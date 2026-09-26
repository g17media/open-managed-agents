import { expect, it } from "vitest";
import { getPendingSessionToolUses, type SessionEventView } from "../src/index";

it.each(["always_ask", "always_allow", "auto"] as const)("recovers legacy MCP calls only for the pinned %s policy", (policy) => {
  const processedAt = "2026-09-26T00:00:00.000Z";
  expect(getPendingSessionToolUses([
    { type: "agent.mcp_tool_use", id: "legacy", name: "mcp__docs__read", mcpServerName: "docs", input: {}, processedAt },
    { type: "agent.tool_use", id: "allowed", name: "bash", input: {}, evaluatedPermission: "allow", processedAt },
  ], { agentTools: [{ type: "mcp_toolset", mcpServerName: "docs", configs: [], defaultConfig: { enabled: true, permissionPolicy: { type: policy } } }] }).map(call => call.id)).toEqual(policy === "always_ask" ? ["legacy"] : []);
});

it("uses per-tool policy overrides when recovering legacy calls", () => {
  const processedAt = "2026-09-26T00:00:00.000Z";
  expect(getPendingSessionToolUses([
    { type: "agent.tool_use", id: "bash", name: "bash", input: {}, processedAt },
    { type: "agent.mcp_tool_use", id: "docs", name: "mcp__docs__read", mcpServerName: "docs", input: {}, processedAt },
  ], { agentTools: [
    { type: "agent_toolset_20260401", defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" } }, configs: [{ type: "bash", name: "bash", enabled: true, permissionPolicy: { type: "always_ask" } }] },
    { type: "mcp_toolset", mcpServerName: "docs", defaultConfig: { enabled: true, permissionPolicy: { type: "always_ask" } }, configs: [{ name: "read", enabled: true, permissionPolicy: { type: "always_allow" } }] },
  ] }).map(call => call.id)).toEqual(["bash"]);
});

it("restores issue order from the persisted idle reason and excludes answered calls", () => {
  const processedAt = "2026-09-26T00:00:00.000Z";
  const calls: SessionEventView[] = ["a", "b", "c"].map(id => ({
    type: "agent.tool_use", id, name: "bash", input: {}, evaluatedPermission: "ask", processedAt,
  }));
  const history: SessionEventView[] = [
    // An equal-timestamp result may sort before the corresponding call.
    { type: "agent.tool_result", id: "0", toolUseId: "b", processedAt },
    ...calls,
    { type: "session.status_idle", id: "idle", processedAt, stopReason: {
      type: "requires_action", actionType: "tool_confirmation", eventIds: ["c", "b", "a"],
    } },
  ];
  expect(getPendingSessionToolUses(history).map(call => call.id)).toEqual(["c", "a"]);
});
