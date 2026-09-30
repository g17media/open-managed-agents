import type { Agent } from "../domain/agent";
import type { SessionAgent } from "../domain/session";

export interface FindSessionAgent {
  workspaceId: string;
  agentId: string;
}

export interface FindSessionAgentVersion extends FindSessionAgent {
  version: number;
}

export interface ResolveSessionAgent {
  workspaceId: string;
  agent: SessionAgent;
}

export type ResolveSessionAgentResult =
  | { type: "resolved"; agent: SessionAgent }
  | { type: "dependency_not_found"; message: string };

export interface SessionAgentSourcePort {
  findCurrent(input: FindSessionAgent): Promise<Agent | null>;
  findVersion(input: FindSessionAgentVersion): Promise<Agent | null>;
  resolveSessionAgent?(
    input: ResolveSessionAgent,
  ): Promise<ResolveSessionAgentResult>;
}
