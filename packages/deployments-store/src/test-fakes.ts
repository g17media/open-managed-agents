// In-memory adapters + a convenience factory for unit tests. Mirrors the
// conventions used by dreams-store/test-fakes and sessions-store/test-fakes.

import type {
  Clock,
  DeploymentListOptions,
  DeploymentRepo,
  DeploymentUpdateFields,
  IdGenerator,
  NewDeploymentInput,
} from "./ports";
import { DeploymentService, type DeploymentServiceDeps } from "./service";
import type { DeploymentRow, DeploymentTriggerType } from "./types";

export class InMemoryDeploymentRepo implements DeploymentRepo {
  private readonly rows = new Map<string, DeploymentRow>();

  async insert(input: NewDeploymentInput): Promise<DeploymentRow> {
    const row: DeploymentRow = {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      agent_id: input.agentId,
      environment_id: input.environmentId,
      initial_message: input.initialMessage,
      vault_ids: [...input.vaultIds],
      memory_store_ids: [...input.memoryStoreIds],
      trigger:
        input.triggerType === "schedule"
          ? { type: "schedule", cron: input.cron }
          : { type: "manual" },
      next_run_at: input.nextRunAt != null ? msToIso(input.nextRunAt) : null,
      last_run_at: null,
      last_session_id: null,
      created_at: msToIso(input.createdAt),
      updated_at: null,
      archived_at: null,
    };
    this.rows.set(input.id, row);
    return row;
  }

  async get(tenantId: string, deploymentId: string): Promise<DeploymentRow | null> {
    const row = this.rows.get(deploymentId);
    return row && row.tenant_id === tenantId ? row : null;
  }

  async list(
    tenantId: string,
    opts: DeploymentListOptions,
  ): Promise<{ items: DeploymentRow[]; hasMore: boolean }> {
    let candidates = Array.from(this.rows.values())
      .filter((d) => d.tenant_id === tenantId)
      .filter((d) => opts.includeArchived || !d.archived_at)
      .sort((a, b) => {
        const cmp = b.created_at.localeCompare(a.created_at);
        return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
      });
    if (opts.after) {
      const afterIso = msToIso(opts.after.createdAtMs);
      const afterId = opts.after.id;
      candidates = candidates.filter(
        (d) =>
          d.created_at < afterIso ||
          (d.created_at === afterIso && d.id < afterId),
      );
    }
    const hasMore = candidates.length > opts.limit;
    return { items: candidates.slice(0, opts.limit), hasMore };
  }

  async update(
    tenantId: string,
    deploymentId: string,
    fields: DeploymentUpdateFields,
  ): Promise<DeploymentRow> {
    const row = await this.get(tenantId, deploymentId);
    if (!row) throw new Error(`deployment ${deploymentId} not found`);
    if (fields.name !== undefined) row.name = fields.name;
    if (fields.agentId !== undefined) row.agent_id = fields.agentId;
    if (fields.environmentId !== undefined) row.environment_id = fields.environmentId;
    if (fields.initialMessage !== undefined) row.initial_message = fields.initialMessage;
    if (fields.vaultIds !== undefined) row.vault_ids = [...fields.vaultIds];
    if (fields.memoryStoreIds !== undefined) row.memory_store_ids = [...fields.memoryStoreIds];
    if (fields.triggerType !== undefined) {
      row.trigger =
        fields.triggerType === "schedule"
          ? { type: "schedule", cron: fields.cron ?? row.trigger.cron }
          : { type: "manual" as DeploymentTriggerType };
    } else if (fields.cron !== undefined && row.trigger.type === "schedule") {
      row.trigger = { type: "schedule", cron: fields.cron };
    }
    if (fields.nextRunAt !== undefined) {
      row.next_run_at = fields.nextRunAt != null ? msToIso(fields.nextRunAt) : null;
    }
    if (fields.lastRunAt !== undefined) row.last_run_at = msToIso(fields.lastRunAt);
    if (fields.lastSessionId !== undefined) row.last_session_id = fields.lastSessionId;
    row.updated_at = msToIso(fields.updatedAt);
    return row;
  }

  async archive(
    tenantId: string,
    deploymentId: string,
    archivedAt: number,
  ): Promise<DeploymentRow> {
    const row = await this.get(tenantId, deploymentId);
    if (!row) throw new Error(`deployment ${deploymentId} not found`);
    row.archived_at = msToIso(archivedAt);
    row.updated_at = msToIso(archivedAt);
    return row;
  }

  async delete(tenantId: string, deploymentId: string): Promise<void> {
    const row = await this.get(tenantId, deploymentId);
    if (row) this.rows.delete(deploymentId);
  }

  async listDue(opts: { nowMs: number; limit: number }): Promise<DeploymentRow[]> {
    const nowIso = msToIso(opts.nowMs);
    return Array.from(this.rows.values())
      .filter(
        (d) =>
          d.trigger.type === "schedule" &&
          !d.archived_at &&
          d.next_run_at !== null &&
          d.next_run_at <= nowIso,
      )
      .sort((a, b) => (a.next_run_at ?? "").localeCompare(b.next_run_at ?? ""))
      .slice(0, opts.limit);
  }
}

export class ManualClock implements Clock {
  constructor(private ms: number) {}
  nowMs(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  deploymentId(): string {
    return `dpl-${String(++this.n).padStart(4, "0")}`;
  }
}

export function createInMemoryDeploymentService(
  overrides: Partial<DeploymentServiceDeps> = {},
): { service: DeploymentService; repo: InMemoryDeploymentRepo } {
  const repo = (overrides.repo as InMemoryDeploymentRepo) ?? new InMemoryDeploymentRepo();
  const service = new DeploymentService({
    repo,
    clock: overrides.clock ?? new ManualClock(1_700_000_000_000),
    ids: overrides.ids ?? new SequentialIds(),
    verifyAgentExists: overrides.verifyAgentExists,
  });
  return { service, repo };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
