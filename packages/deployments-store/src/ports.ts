// Abstract ports the DeploymentService depends on. Same DIP convention as
// dreams-store / sessions-store: pure data in, pure data out, no Cloudflare
// types, no SQL dialect.

import type { DeploymentRow, DeploymentTriggerType } from "./types";

export interface NewDeploymentInput {
  id: string;
  tenantId: string;
  name: string;
  agentId: string;
  environmentId: string | null;
  initialMessage: string;
  vaultIds: string[];
  memoryStoreIds: string[];
  triggerType: DeploymentTriggerType;
  cron: string | null;
  nextRunAt: number | null;
  createdAt: number;
}

export interface DeploymentUpdateFields {
  name?: string;
  agentId?: string;
  environmentId?: string | null;
  initialMessage?: string;
  vaultIds?: string[];
  memoryStoreIds?: string[];
  triggerType?: DeploymentTriggerType;
  cron?: string | null;
  nextRunAt?: number | null;
  lastRunAt?: number;
  lastSessionId?: string;
  updatedAt: number;
}

export interface DeploymentListOptions {
  includeArchived: boolean;
  limit: number;
  /** Opaque pagination cursor — created_at(ms) of the last item from the
   *  previous page, plus its id for tie-break. */
  after?: { createdAtMs: number; id: string };
}

export interface DeploymentRepo {
  insert(input: NewDeploymentInput): Promise<DeploymentRow>;

  get(tenantId: string, deploymentId: string): Promise<DeploymentRow | null>;

  list(
    tenantId: string,
    opts: DeploymentListOptions,
  ): Promise<{ items: DeploymentRow[]; hasMore: boolean }>;

  update(
    tenantId: string,
    deploymentId: string,
    fields: DeploymentUpdateFields,
  ): Promise<DeploymentRow>;

  archive(tenantId: string, deploymentId: string, archivedAt: number): Promise<DeploymentRow>;

  delete(tenantId: string, deploymentId: string): Promise<void>;

  /**
   * Cross-tenant sweep for the deployments-tick cron: non-archived
   * scheduled deployments whose next_run_at is due. Bounded by `limit`
   * so one tick can't blow up on a backlog after downtime.
   */
  listDue(opts: { nowMs: number; limit: number }): Promise<DeploymentRow[]>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  deploymentId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
}
