import type { SessionEventView } from "../domain/session-event";
import type { AgentTool } from "../domain/agent-definition";

export type PendingSessionToolUse = Extract<SessionEventView, {
  type: "agent.tool_use" | "agent.mcp_tool_use" | "agent.custom_tool_use";
}>;

function legacyPermissionRequiresConfirmation(
  call: Extract<PendingSessionToolUse, { type: "agent.tool_use" | "agent.mcp_tool_use" }>,
  tools: readonly AgentTool[],
): boolean {
  const toolset = tools.find((tool) => call.type === "agent.mcp_tool_use"
    ? tool.type === "mcp_toolset" && tool.mcpServerName === call.mcpServerName
    : tool.type === "agent_toolset_20260401");
  if (toolset === undefined || toolset.type === "custom") return false;
  const prefix = call.type === "agent.mcp_tool_use" ? `mcp__${call.mcpServerName}__` : "";
  const name = prefix && call.name.startsWith(prefix) ? call.name.slice(prefix.length) : call.name;
  const config = toolset.configs.find((candidate) => candidate.name === name);
  return (config?.permissionPolicy ?? toolset.defaultConfig.permissionPolicy).type === "always_ask";
}

/** Rebuild unresolved calls in event order. A confirmation reserves a call at
 * admission; execution keeps it pending until its tool result is persisted. */
export function getPendingSessionToolUses(
  events: readonly SessionEventView[],
  options: { includeConfirmed?: boolean; agentTools?: readonly AgentTool[] } = {},
): PendingSessionToolUse[] {
  const pending = new Map<string, PendingSessionToolUse>();
  const resolved = new Set<string>();
  let issuedOrder: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        // Old histories omit permission metadata. Only recover calls whose
        // pinned agent policy required confirmation; auto/allow stay unchanged.
        if (event.evaluatedPermission === "ask" ||
          (event.evaluatedPermission === undefined &&
            legacyPermissionRequiresConfirmation(event, options.agentTools ?? []))) {
          pending.set(event.id, event);
        }
        break;
      case "agent.custom_tool_use":
        pending.set(event.id, event);
        break;
      case "agent.tool_result":
      case "user.tool_result":
        resolved.add(event.toolUseId);
        break;
      case "agent.mcp_tool_result":
        resolved.add(event.mcpToolUseId);
        break;
      case "user.custom_tool_result":
        resolved.add(event.customToolUseId);
        break;
      case "user.tool_confirmation":
        if (!options.includeConfirmed) resolved.add(event.toolUseId);
        break;
      case "session.status_idle":
        if (event.stopReason?.type === "requires_action") {
          issuedOrder = event.stopReason.eventIds;
        }
        break;
    }
  }
  // Persisted pages may sort equal timestamps by event ID. The idle event
  // records the original issue order before persistence and survives restarts.
  const ordered = new Map(issuedOrder.map((id, index) => [id, index]));
  return [...pending.values()]
    .filter((call) => !resolved.has(call.id))
    .sort((left, right) => (ordered.get(left.id) ?? Infinity) - (ordered.get(right.id) ?? Infinity));
}
