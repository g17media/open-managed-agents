import type { Client } from "../client.js";
import type { AgentDetail, AgentSummary, PaginatedResponse } from "../types.js";

export interface AgentModelInput {
  id: string;
  speed?: "standard" | "fast";
}

export interface AgentSkillInput {
  skill_id: string;
  type?: string;
  version?: string;
}

export interface CallableAgentInput {
  type: "agent";
  id: string;
  version?: number;
}

/** OMA platform extensions — nested under `_oma` so AMA-shaped payloads
 *  stay spec-clean. Mirrors the `_oma` envelope the API returns. */
export interface AgentOmaInput {
  aux_model?: string | AgentModelInput | null;
  harness?: string;
  runtime_binding?: {
    runtime_id: string;
    acp_agent_id: string;
    local_skill_blocklist?: string[];
  } | null;
  appendable_prompts?: string[] | null;
}

export interface CreateAgentInput {
  name: string;
  model?: string | AgentModelInput;
  system?: string;
  tools?: unknown[];
  skills?: AgentSkillInput[];
  mcp_servers?: unknown[];
  callable_agents?: CallableAgentInput[];
  multiagent?: { type: "coordinator"; agents: unknown[] } | null;
  description?: string;
  metadata?: Record<string, unknown>;
  harness?: string;
  enable_general_subagent?: boolean;
  _oma?: AgentOmaInput;
}

export interface UpdateAgentInput {
  name?: string;
  model?: string | AgentModelInput;
  system?: string | null;
  tools?: unknown[];
  skills?: AgentSkillInput[] | null;
  mcp_servers?: unknown[] | null;
  callable_agents?: CallableAgentInput[] | null;
  multiagent?: { type: "coordinator"; agents: unknown[] } | null;
  description?: string | null;
  /** Per-key merge — pass `{ key: null }` to drop a key. */
  metadata?: Record<string, unknown>;
  /** Optimistic concurrency: the version this update was read from.
   *  The API responds 409 if the agent has moved past it. */
  version?: number;
  harness?: string;
  enable_general_subagent?: boolean | null;
  _oma?: AgentOmaInput;
}

export interface ListAgentsOptions {
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export class AgentsResource {
  constructor(private readonly client: Client) {}

  async list(opts: ListAgentsOptions = {}): Promise<PaginatedResponse<AgentSummary>> {
    return this.client.request<PaginatedResponse<AgentSummary>>(
      "GET",
      "/v1/agents",
      { query: opts as Record<string, string | number | boolean | undefined> },
    );
  }

  async get(agentId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("GET", `/v1/agents/${agentId}`);
  }

  async create(input: CreateAgentInput): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", "/v1/agents", { body: input });
  }

  async update(agentId: string, input: UpdateAgentInput): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("PUT", `/v1/agents/${agentId}`, { body: input });
  }

  async delete(agentId: string): Promise<void> {
    await this.client.request("DELETE", `/v1/agents/${agentId}`);
  }
}
