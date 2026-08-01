import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  DeploymentListOptions,
  DeploymentRepo,
  DeploymentUpdateFields,
  NewDeploymentInput,
} from "../ports";
import type { DeploymentRow, DeploymentTriggerType } from "../types";

/**
 * SQL implementation of {@link DeploymentRepo}. Mirrors the schema in
 * apps/main/migrations/0019_deployments.sql.
 *
 * Backend-agnostic: takes any {@link SqlClient} so the same statements work
 * against D1 and better-sqlite3 / Postgres (self-host). JSON columns
 * (`vault_ids`, `memory_store_ids`) are encoded at the boundary.
 */
export class SqlDeploymentRepo implements DeploymentRepo {
  constructor(private readonly db: SqlClient) {}

  async insert(input: NewDeploymentInput): Promise<DeploymentRow> {
    await this.db
      .prepare(
        `INSERT INTO deployments (
           id, tenant_id, name, agent_id, environment_id, initial_message,
           vault_ids, memory_store_ids,
           trigger_type, cron, next_run_at,
           last_run_at, last_session_id,
           created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.name,
        input.agentId,
        input.environmentId,
        input.initialMessage,
        JSON.stringify(input.vaultIds),
        JSON.stringify(input.memoryStoreIds),
        input.triggerType,
        input.cron,
        input.nextRunAt,
        input.createdAt,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error(`deployment ${input.id} vanished after insert`);
    return row;
  }

  async get(tenantId: string, deploymentId: string): Promise<DeploymentRow | null> {
    const row = await this.db
      .prepare(`${SELECT_COLS} WHERE id = ? AND tenant_id = ?`)
      .bind(deploymentId, tenantId)
      .first<DbDeployment>();
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: DeploymentListOptions,
  ): Promise<{ items: DeploymentRow[]; hasMore: boolean }> {
    const limit = opts.limit;
    const binds: unknown[] = [tenantId];
    let where = "WHERE tenant_id = ?";
    if (!opts.includeArchived) where += " AND archived_at IS NULL";
    if (opts.after) {
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      binds.push(opts.after.createdAtMs, opts.after.createdAtMs, opts.after.id);
    }
    const sql = `${SELECT_COLS} ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
    binds.push(limit + 1);
    const result = await this.db.prepare(sql).bind(...binds).all<DbDeployment>();
    const rows = (result.results ?? []).map(toRow);
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async update(
    tenantId: string,
    deploymentId: string,
    fields: DeploymentUpdateFields,
  ): Promise<DeploymentRow> {
    const sets: string[] = ["updated_at = ?"];
    const binds: unknown[] = [fields.updatedAt];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      binds.push(fields.name);
    }
    if (fields.agentId !== undefined) {
      sets.push("agent_id = ?");
      binds.push(fields.agentId);
    }
    if (fields.environmentId !== undefined) {
      sets.push("environment_id = ?");
      binds.push(fields.environmentId);
    }
    if (fields.initialMessage !== undefined) {
      sets.push("initial_message = ?");
      binds.push(fields.initialMessage);
    }
    if (fields.vaultIds !== undefined) {
      sets.push("vault_ids = ?");
      binds.push(JSON.stringify(fields.vaultIds));
    }
    if (fields.memoryStoreIds !== undefined) {
      sets.push("memory_store_ids = ?");
      binds.push(JSON.stringify(fields.memoryStoreIds));
    }
    if (fields.triggerType !== undefined) {
      sets.push("trigger_type = ?");
      binds.push(fields.triggerType);
    }
    if (fields.cron !== undefined) {
      sets.push("cron = ?");
      binds.push(fields.cron);
    }
    if (fields.nextRunAt !== undefined) {
      sets.push("next_run_at = ?");
      binds.push(fields.nextRunAt);
    }
    if (fields.lastRunAt !== undefined) {
      sets.push("last_run_at = ?");
      binds.push(fields.lastRunAt);
    }
    if (fields.lastSessionId !== undefined) {
      sets.push("last_session_id = ?");
      binds.push(fields.lastSessionId);
    }
    binds.push(deploymentId, tenantId);
    await this.db
      .prepare(`UPDATE deployments SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
      .bind(...binds)
      .run();
    const row = await this.get(tenantId, deploymentId);
    if (!row) throw new Error(`deployment ${deploymentId} vanished after update`);
    return row;
  }

  async archive(
    tenantId: string,
    deploymentId: string,
    archivedAt: number,
  ): Promise<DeploymentRow> {
    await this.db
      .prepare(
        `UPDATE deployments SET archived_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      )
      .bind(archivedAt, archivedAt, deploymentId, tenantId)
      .run();
    const row = await this.get(tenantId, deploymentId);
    if (!row) throw new Error(`deployment ${deploymentId} vanished after archive`);
    return row;
  }

  async delete(tenantId: string, deploymentId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM deployments WHERE id = ? AND tenant_id = ?`)
      .bind(deploymentId, tenantId)
      .run();
  }

  async listDue(opts: { nowMs: number; limit: number }): Promise<DeploymentRow[]> {
    // Cross-tenant: the cron sweep runs per-shard, not per-tenant. Ordered
    // oldest-due first so a backlog drains fairly under the limit.
    const result = await this.db
      .prepare(
        `${SELECT_COLS}
          WHERE trigger_type = 'schedule'
            AND archived_at IS NULL
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?
          ORDER BY next_run_at ASC
          LIMIT ?`,
      )
      .bind(opts.nowMs, opts.limit)
      .all<DbDeployment>();
    return (result.results ?? []).map(toRow);
  }
}

const SELECT_COLS = `SELECT
  id, tenant_id, name, agent_id, environment_id, initial_message,
  vault_ids, memory_store_ids,
  trigger_type, cron, next_run_at,
  last_run_at, last_session_id,
  created_at, updated_at, archived_at
FROM deployments`;

interface DbDeployment {
  id: string;
  tenant_id: string;
  name: string;
  agent_id: string;
  environment_id: string | null;
  initial_message: string;
  vault_ids: string;
  memory_store_ids: string;
  trigger_type: string;
  cron: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_session_id: string | null;
  created_at: number;
  updated_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbDeployment): DeploymentRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    agent_id: r.agent_id,
    environment_id: r.environment_id,
    initial_message: r.initial_message,
    vault_ids: parseJsonStringArray(r.vault_ids),
    memory_store_ids: parseJsonStringArray(r.memory_store_ids),
    trigger:
      r.trigger_type === "schedule"
        ? { type: "schedule", cron: r.cron }
        : { type: (r.trigger_type as DeploymentTriggerType) || "manual" },
    next_run_at: r.next_run_at != null ? msToIso(r.next_run_at) : null,
    last_run_at: r.last_run_at != null ? msToIso(r.last_run_at) : null,
    last_session_id: r.last_session_id,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at != null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at != null ? msToIso(r.archived_at) : null,
  };
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* fallthrough */
  }
  return [];
}

function msToIso(ms: number): string {
  return new Date(Number(ms)).toISOString();
}
