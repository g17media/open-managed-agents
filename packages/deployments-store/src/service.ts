import { generateId } from "@open-managed-agents/shared";
import { Cron } from "croner";
import {
  DeploymentAgentMissingError,
  DeploymentInvalidInputError,
  DeploymentNotFoundError,
} from "./errors";
import type {
  Clock,
  DeploymentListOptions,
  DeploymentRepo,
  DeploymentUpdateFields,
  IdGenerator,
  Logger,
} from "./ports";
import {
  MAX_DEPLOYMENT_MESSAGE_CHARS,
  MAX_DEPLOYMENT_NAME_CHARS,
  type DeploymentRow,
  type DeploymentTrigger,
} from "./types";

export interface DeploymentServiceDeps {
  repo: DeploymentRepo;
  /** Optional existence check for the referenced agent at create/update.
   *  Callback (not an AgentService import) to avoid a dependency cycle —
   *  same pattern as dreams-store's verifyMemoryStoreExists. */
  verifyAgentExists?: (tenantId: string, agentId: string) => Promise<boolean>;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/** Next fire time for a cron expression, strictly after `fromMs`. Throws
 *  DeploymentInvalidInputError on an unparseable expression. */
export function nextRunFromCron(cron: string, fromMs: number): number {
  let next: Date | null;
  try {
    next = new Cron(cron).nextRun(new Date(fromMs));
  } catch (err) {
    throw new DeploymentInvalidInputError(
      `invalid cron expression "${cron}": ${(err as Error).message}`,
    );
  }
  if (!next) {
    throw new DeploymentInvalidInputError(`cron expression "${cron}" never fires`);
  }
  return next.getTime();
}

/**
 * DeploymentService — persistence + trigger bookkeeping for stored launch
 * recipes. Actually running a deployment (create session → init runtime →
 * send initial message) lives in the route layer's `runDeployment`, which
 * calls back into `recordRun` to publish the outcome. Splitting service ↔
 * runner keeps this package free of SessionRouter dependencies.
 */
export class DeploymentService {
  private readonly repo: DeploymentRepo;
  private readonly verifyAgentExists?: DeploymentServiceDeps["verifyAgentExists"];
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: DeploymentServiceDeps) {
    this.repo = deps.repo;
    this.verifyAgentExists = deps.verifyAgentExists;
    this.clock = deps.clock ?? { nowMs: () => Date.now() };
    this.ids = deps.ids ?? { deploymentId: () => `dpl-${generateId()}` };
  }

  async create(opts: {
    tenantId: string;
    name: string;
    agentId: string;
    environmentId?: string | null;
    initialMessage: string;
    vaultIds?: string[];
    memoryStoreIds?: string[];
    trigger: DeploymentTrigger;
  }): Promise<DeploymentRow> {
    this.validateFields(opts);
    if (!opts.name) throw new DeploymentInvalidInputError("name is required");
    if (!opts.agentId) throw new DeploymentInvalidInputError("agent_id is required");
    if (!opts.initialMessage) {
      throw new DeploymentInvalidInputError("initial_message is required");
    }
    const trigger = this.normalizeTrigger(opts.trigger);
    if (this.verifyAgentExists) {
      const ok = await this.verifyAgentExists(opts.tenantId, opts.agentId);
      if (!ok) throw new DeploymentAgentMissingError(opts.agentId);
    }
    const now = this.clock.nowMs();
    return this.repo.insert({
      id: this.ids.deploymentId(),
      tenantId: opts.tenantId,
      name: opts.name,
      agentId: opts.agentId,
      environmentId: opts.environmentId ?? null,
      initialMessage: opts.initialMessage,
      vaultIds: opts.vaultIds ?? [],
      memoryStoreIds: opts.memoryStoreIds ?? [],
      triggerType: trigger.type,
      cron: trigger.type === "schedule" ? trigger.cron! : null,
      nextRunAt:
        trigger.type === "schedule" ? nextRunFromCron(trigger.cron!, now) : null,
      createdAt: now,
    });
  }

  async update(opts: {
    tenantId: string;
    deploymentId: string;
    name?: string;
    agentId?: string;
    environmentId?: string | null;
    initialMessage?: string;
    vaultIds?: string[];
    memoryStoreIds?: string[];
    trigger?: DeploymentTrigger;
  }): Promise<DeploymentRow> {
    const existing = await this.require(opts.tenantId, opts.deploymentId);
    this.validateFields(opts);
    if (opts.name !== undefined && !opts.name) {
      throw new DeploymentInvalidInputError("name cannot be empty");
    }
    if (opts.initialMessage !== undefined && !opts.initialMessage) {
      throw new DeploymentInvalidInputError("initial_message cannot be empty");
    }
    if (opts.agentId !== undefined && opts.agentId !== existing.agent_id && this.verifyAgentExists) {
      const ok = await this.verifyAgentExists(opts.tenantId, opts.agentId);
      if (!ok) throw new DeploymentAgentMissingError(opts.agentId);
    }
    const update: DeploymentUpdateFields = { updatedAt: this.clock.nowMs() };
    if (opts.name !== undefined) update.name = opts.name;
    if (opts.agentId !== undefined) update.agentId = opts.agentId;
    if (opts.environmentId !== undefined) update.environmentId = opts.environmentId;
    if (opts.initialMessage !== undefined) update.initialMessage = opts.initialMessage;
    if (opts.vaultIds !== undefined) update.vaultIds = opts.vaultIds;
    if (opts.memoryStoreIds !== undefined) update.memoryStoreIds = opts.memoryStoreIds;
    if (opts.trigger !== undefined) {
      const trigger = this.normalizeTrigger(opts.trigger);
      update.triggerType = trigger.type;
      update.cron = trigger.type === "schedule" ? trigger.cron! : null;
      update.nextRunAt =
        trigger.type === "schedule"
          ? nextRunFromCron(trigger.cron!, this.clock.nowMs())
          : null;
    }
    return this.repo.update(opts.tenantId, opts.deploymentId, update);
  }

  async get(opts: { tenantId: string; deploymentId: string }): Promise<DeploymentRow | null> {
    return this.repo.get(opts.tenantId, opts.deploymentId);
  }

  async list(opts: {
    tenantId: string;
    includeArchived?: boolean;
    limit?: number;
    after?: DeploymentListOptions["after"];
  }): Promise<{ items: DeploymentRow[]; hasMore: boolean }> {
    return this.repo.list(opts.tenantId, {
      includeArchived: opts.includeArchived ?? false,
      limit: Math.min(Math.max(1, opts.limit ?? 50), 100),
      after: opts.after,
    });
  }

  async archive(opts: { tenantId: string; deploymentId: string }): Promise<DeploymentRow> {
    await this.require(opts.tenantId, opts.deploymentId);
    return this.repo.archive(opts.tenantId, opts.deploymentId, this.clock.nowMs());
  }

  async delete(opts: { tenantId: string; deploymentId: string }): Promise<void> {
    await this.require(opts.tenantId, opts.deploymentId);
    await this.repo.delete(opts.tenantId, opts.deploymentId);
  }

  /**
   * Publish the outcome of a run. Scheduled deployments advance
   * next_run_at past `ranAtMs`; manual ones just record the bookkeeping.
   */
  async recordRun(opts: {
    tenantId: string;
    deploymentId: string;
    sessionId: string;
    ranAtMs?: number;
  }): Promise<DeploymentRow> {
    const existing = await this.require(opts.tenantId, opts.deploymentId);
    const ranAt = opts.ranAtMs ?? this.clock.nowMs();
    const update: DeploymentUpdateFields = {
      updatedAt: ranAt,
      lastRunAt: ranAt,
      lastSessionId: opts.sessionId,
    };
    if (existing.trigger.type === "schedule" && existing.trigger.cron) {
      update.nextRunAt = nextRunFromCron(existing.trigger.cron, ranAt);
    }
    return this.repo.update(opts.tenantId, opts.deploymentId, update);
  }

  /** Advance next_run_at past now without recording a run — the tick
   *  calls this when a run fails so a broken recipe can't hot-loop. */
  async deferNextRun(opts: { tenantId: string; deploymentId: string }): Promise<void> {
    const existing = await this.require(opts.tenantId, opts.deploymentId);
    if (existing.trigger.type !== "schedule" || !existing.trigger.cron) return;
    const now = this.clock.nowMs();
    await this.repo.update(opts.tenantId, opts.deploymentId, {
      updatedAt: now,
      nextRunAt: nextRunFromCron(existing.trigger.cron, now),
    });
  }

  /** Due scheduled deployments across all tenants — the cron sweep input. */
  async listDue(opts: { nowMs?: number; limit?: number }): Promise<DeploymentRow[]> {
    return this.repo.listDue({
      nowMs: opts.nowMs ?? this.clock.nowMs(),
      limit: Math.min(Math.max(1, opts.limit ?? 20), 100),
    });
  }

  private async require(tenantId: string, deploymentId: string): Promise<DeploymentRow> {
    const row = await this.repo.get(tenantId, deploymentId);
    if (!row) throw new DeploymentNotFoundError();
    return row;
  }

  private normalizeTrigger(trigger: DeploymentTrigger): DeploymentTrigger {
    if (trigger.type === "manual") return { type: "manual" };
    if (trigger.type === "schedule") {
      if (!trigger.cron) {
        throw new DeploymentInvalidInputError("trigger.cron is required for schedule triggers");
      }
      // Parse eagerly so a bad expression 400s at create, not at tick time.
      nextRunFromCron(trigger.cron, this.clock.nowMs());
      return { type: "schedule", cron: trigger.cron };
    }
    throw new DeploymentInvalidInputError(`trigger.type must be "manual" or "schedule"`);
  }

  private validateFields(opts: { name?: string; initialMessage?: string }): void {
    if (opts.name && opts.name.length > MAX_DEPLOYMENT_NAME_CHARS) {
      throw new DeploymentInvalidInputError(
        `name exceeds ${MAX_DEPLOYMENT_NAME_CHARS} character limit`,
      );
    }
    if (opts.initialMessage && opts.initialMessage.length > MAX_DEPLOYMENT_MESSAGE_CHARS) {
      throw new DeploymentInvalidInputError(
        `initial_message exceeds ${MAX_DEPLOYMENT_MESSAGE_CHARS} character limit`,
      );
    }
  }
}
