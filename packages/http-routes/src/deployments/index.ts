// Deployments — stored launch recipes (OMA-only extension, mounted under
// /v1/oma/deployments).
//
// A deployment bundles agent + environment + vaults + memory stores + an
// initial message, with a manual or cron-schedule trigger. Running one
// creates a regular session behind the scenes — the same three calls the
// public session-create route makes (sessions.create → router.init →
// router.appendEvent) — and tags it with metadata.deployment_id.
//
// `runDeployment` + `deploymentsTick` are exported for the scheduler
// wiring (apps/main cf-scheduler-jobs, apps/main-node node-scheduler-jobs)
// so scheduled deployments fire through the exact same code path as the
// "Run now" button.

import { Hono } from "hono";
import type { Context } from "hono";
import {
  DeploymentAgentMissingError,
  DeploymentInvalidInputError,
  DeploymentNotFoundError,
  type DeploymentRow,
  type DeploymentService,
  type DeploymentTrigger,
} from "@open-managed-agents/deployments-store";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type {
  SessionRouter,
  SessionInitParams,
} from "@open-managed-agents/session-runtime";
import { generateEventId } from "@open-managed-agents/shared";
import type {
  AgentConfig,
  CredentialConfig,
  EnvironmentConfig,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

export class DeploymentRunError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

/** The narrow service slice a run needs — structurally satisfied by both
 *  RouteServices (routes) and the CF Services container (cron). */
export interface DeploymentRunServices {
  deployments: DeploymentService;
  sessions: SessionService;
  agents: AgentService;
}

export interface DeploymentRunContext {
  services: DeploymentRunServices;
  router: SessionRouter;
  loadEnvironment?: (input: {
    tenantId: string;
    environmentId: string;
  }) => Promise<EnvironmentConfig | null>;
  fetchVaultCredentials?: (input: {
    tenantId: string;
    vaultIds: string[];
  }) => Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>>;
  localRuntimeEnvId?: string;
}

/**
 * Fire one deployment: create the session, init the runtime, send the
 * initial message, record the run. Mirrors the session-create route's
 * sequence (sessions/index.ts) minus the request-scoped extras.
 */
export async function runDeployment(
  ctx: DeploymentRunContext,
  tenantId: string,
  deployment: DeploymentRow,
): Promise<{ sessionId: string }> {
  const agentRow = await ctx.services.agents.get({
    tenantId,
    agentId: deployment.agent_id,
  });
  if (!agentRow) {
    throw new DeploymentRunError(`agent not found: ${deployment.agent_id}`, 404);
  }
  const { tenant_id: _t, ...agentSnapshot } = agentRow as AgentConfig & {
    tenant_id?: string;
  };

  const isLocalRuntime = !!agentRow.runtime_binding;
  let envId = deployment.environment_id ?? undefined;
  if (!envId) {
    if (!isLocalRuntime) {
      throw new DeploymentRunError("environment_id is required for cloud agents", 400);
    }
    envId = ctx.localRuntimeEnvId ?? "env_local_runtime";
  }
  const envSnap = ctx.loadEnvironment
    ? await ctx.loadEnvironment({ tenantId, environmentId: envId })
    : null;
  if (!isLocalRuntime && !envSnap) {
    throw new DeploymentRunError(`environment not found: ${envId}`, 404);
  }

  const vaultIds = deployment.vault_ids;
  const vaultCreds = ctx.fetchVaultCredentials
    ? await ctx.fetchVaultCredentials({ tenantId, vaultIds })
    : [];

  const { session } = await ctx.services.sessions.create({
    tenantId,
    agentId: deployment.agent_id,
    environmentId: envId,
    title: deployment.name,
    vaultIds,
    agentSnapshot: agentSnapshot as AgentConfig,
    environmentSnapshot: envSnap ?? undefined,
    metadata: { deployment_id: deployment.id },
    resources: deployment.memory_store_ids.map((id) => ({
      type: "memory_store" as const,
      memory_store_id: id,
      access: "read_write" as const,
    })) as never,
  });
  const sessionId = session.id;

  const initParams: SessionInitParams = {
    agentId: deployment.agent_id,
    environmentId: envId,
    title: deployment.name,
    tenantId,
    vaultIds,
    agentSnapshot: agentSnapshot as AgentConfig,
    environmentSnapshot: envSnap ?? undefined,
    vaultCredentials: vaultCreds,
    initEvents: [],
  };
  await ctx.router.init(sessionId, initParams).catch((err) => {
    console.warn(`[deployments] router.init failed for ${sessionId}:`, err);
  });

  const ev = {
    type: "user.message",
    id: generateEventId(),
    content: [{ type: "text", text: deployment.initial_message }],
  } as unknown as UserMessageEvent;
  const append = await ctx.router.appendEvent(sessionId, ev);
  if (append.status >= 400) {
    console.warn(
      `[deployments] initial message append failed for ${sessionId}: ${append.status}`,
    );
  }

  await ctx.services.deployments.recordRun({
    tenantId,
    deploymentId: deployment.id,
    sessionId,
  });
  return { sessionId };
}

// ── Cron sweep ──────────────────────────────────────────────────────────

export interface DeploymentsTickShard {
  services: DeploymentRunServices;
  routerForTenant: (tenantId: string) => SessionRouter;
  loadEnvironment?: DeploymentRunContext["loadEnvironment"];
  fetchVaultCredentials?: DeploymentRunContext["fetchVaultCredentials"];
  localRuntimeEnvId?: string;
}

export interface DeploymentsTickDeps {
  forEachShard: (fn: (shard: DeploymentsTickShard) => Promise<void>) => Promise<unknown>;
  /** Max due deployments fired per shard per tick. */
  limit?: number;
  logger?: { warn(msg: string, ctx?: unknown): void };
}

/** Per-minute sweep: fire every due scheduled deployment. Failures defer
 *  next_run_at past now so a broken recipe can't hot-loop every tick. */
export function deploymentsTick(deps: DeploymentsTickDeps): () => Promise<void> {
  return async () => {
    await deps.forEachShard(async (shard) => {
      const due = await shard.services.deployments.listDue({ limit: deps.limit ?? 20 });
      for (const deployment of due) {
        try {
          await runDeployment(
            {
              services: shard.services,
              router: shard.routerForTenant(deployment.tenant_id),
              loadEnvironment: shard.loadEnvironment,
              fetchVaultCredentials: shard.fetchVaultCredentials,
              localRuntimeEnvId: shard.localRuntimeEnvId,
            },
            deployment.tenant_id,
            deployment,
          );
        } catch (err) {
          deps.logger?.warn(
            `[deployments-tick] run failed for ${deployment.id}: ${(err as Error).message}`,
          );
          await shard.services.deployments
            .deferNextRun({
              tenantId: deployment.tenant_id,
              deploymentId: deployment.id,
            })
            .catch(() => undefined);
        }
      }
    });
  };
}

// ── HTTP routes ─────────────────────────────────────────────────────────

export interface DeploymentRoutesDeps {
  services: RouteServicesArg;
  router: SessionRouter | ((c: Context) => SessionRouter);
  loadEnvironment?: DeploymentRunContext["loadEnvironment"];
  fetchVaultCredentials?: DeploymentRunContext["fetchVaultCredentials"];
  localRuntimeEnvId?: string;
}

interface DeploymentBody {
  name?: string;
  agent_id?: string;
  environment_id?: string | null;
  initial_message?: string;
  vault_ids?: string[];
  memory_store_ids?: string[];
  trigger?: DeploymentTrigger;
}

function toApiDeployment(row: DeploymentRow) {
  const { tenant_id: _t, ...rest } = row;
  return { type: "deployment" as const, ...rest };
}

function mapDeploymentError(c: Context, err: unknown): Response {
  if (err instanceof DeploymentNotFoundError) {
    return c.json({ error: "Deployment not found" }, 404);
  }
  if (err instanceof DeploymentInvalidInputError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof DeploymentAgentMissingError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof DeploymentRunError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  throw err;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export function buildDeploymentRoutes(deps: DeploymentRoutesDeps) {
  const app = new Hono<Vars>();

  const resolveRouter = (c: Context): SessionRouter =>
    typeof deps.router === "function" ? deps.router(c) : deps.router;

  const requireDeployments = (c: Context): DeploymentService | Response => {
    const services = resolveServices(deps.services, c);
    if (!services.deployments) {
      return c.json({ error: "Deployments service is not configured" }, 501);
    }
    return services.deployments;
  };

  app.post("/", async (c) => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    const body = (await c.req.json().catch(() => ({}))) as DeploymentBody;
    if (body.vault_ids !== undefined && !isStringArray(body.vault_ids)) {
      return c.json({ error: "vault_ids must be an array of strings" }, 400);
    }
    if (body.memory_store_ids !== undefined && !isStringArray(body.memory_store_ids)) {
      return c.json({ error: "memory_store_ids must be an array of strings" }, 400);
    }
    try {
      const row = await deployments.create({
        tenantId: c.var.tenant_id,
        name: body.name ?? "",
        agentId: body.agent_id ?? "",
        environmentId: body.environment_id ?? null,
        initialMessage: body.initial_message ?? "",
        vaultIds: body.vault_ids,
        memoryStoreIds: body.memory_store_ids,
        trigger: body.trigger ?? { type: "manual" },
      });
      return c.json(toApiDeployment(row), 201);
    } catch (err) {
      return mapDeploymentError(c, err);
    }
  });

  app.get("/", async (c) => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    const limitStr = c.req.query("limit");
    const limit = limitStr ? Math.min(Math.max(1, Number(limitStr)), 100) : 50;
    const includeArchived = c.req.query("include_archived") === "true";
    const cursorRaw = c.req.query("cursor");
    let after: { createdAtMs: number; id: string } | undefined;
    if (cursorRaw) {
      const sep = cursorRaw.indexOf("_");
      const ms = Number(cursorRaw.slice(0, sep));
      if (sep === -1 || Number.isNaN(ms)) {
        return c.json({ error: "invalid cursor" }, 400);
      }
      after = { createdAtMs: ms, id: cursorRaw.slice(sep + 1) };
    }
    const page = await deployments.list({
      tenantId: c.var.tenant_id,
      includeArchived,
      limit,
      after,
    });
    const last = page.items[page.items.length - 1];
    return c.json({
      data: page.items.map(toApiDeployment),
      has_more: page.hasMore,
      ...(page.hasMore && last
        ? { next_cursor: `${Date.parse(last.created_at)}_${last.id}` }
        : {}),
    });
  });

  app.get("/:id", async (c) => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    const row = await deployments.get({
      tenantId: c.var.tenant_id,
      deploymentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Deployment not found" }, 404);
    return c.json(toApiDeployment(row));
  });

  const updateDeployment = async (c: Context<Vars, "/:id">): Promise<Response> => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    const body = (await c.req.json().catch(() => ({}))) as DeploymentBody;
    if (body.vault_ids !== undefined && !isStringArray(body.vault_ids)) {
      return c.json({ error: "vault_ids must be an array of strings" }, 400);
    }
    if (body.memory_store_ids !== undefined && !isStringArray(body.memory_store_ids)) {
      return c.json({ error: "memory_store_ids must be an array of strings" }, 400);
    }
    try {
      const row = await deployments.update({
        tenantId: c.var.tenant_id,
        deploymentId: c.req.param("id"),
        name: body.name,
        agentId: body.agent_id,
        environmentId: body.environment_id,
        initialMessage: body.initial_message,
        vaultIds: body.vault_ids,
        memoryStoreIds: body.memory_store_ids,
        trigger: body.trigger,
      });
      return c.json(toApiDeployment(row));
    } catch (err) {
      return mapDeploymentError(c, err);
    }
  };
  app.post("/:id", updateDeployment);
  app.put("/:id", updateDeployment);

  app.post("/:id/archive", async (c) => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    try {
      const row = await deployments.archive({
        tenantId: c.var.tenant_id,
        deploymentId: c.req.param("id"),
      });
      return c.json(toApiDeployment(row));
    } catch (err) {
      return mapDeploymentError(c, err);
    }
  });

  app.delete("/:id", async (c) => {
    const deployments = requireDeployments(c);
    if (deployments instanceof Response) return deployments;
    try {
      await deployments.delete({
        tenantId: c.var.tenant_id,
        deploymentId: c.req.param("id"),
      });
      return c.json({ type: "deployment_deleted", id: c.req.param("id") });
    } catch (err) {
      return mapDeploymentError(c, err);
    }
  });

  app.post("/:id/run", async (c) => {
    const services = resolveServices(deps.services, c);
    if (!services.deployments) {
      return c.json({ error: "Deployments service is not configured" }, 501);
    }
    const tenantId = c.var.tenant_id;
    const row = await services.deployments.get({
      tenantId,
      deploymentId: c.req.param("id"),
    });
    if (!row) return c.json({ error: "Deployment not found" }, 404);
    if (row.archived_at) {
      return c.json({ error: "Deployment is archived" }, 409);
    }
    try {
      const { sessionId } = await runDeployment(
        {
          services: services as unknown as DeploymentRunServices,
          router: resolveRouter(c),
          loadEnvironment: deps.loadEnvironment,
          fetchVaultCredentials: deps.fetchVaultCredentials,
          localRuntimeEnvId: deps.localRuntimeEnvId,
        },
        tenantId,
        row,
      );
      return c.json({ type: "deployment_run", deployment_id: row.id, session_id: sessionId }, 201);
    } catch (err) {
      return mapDeploymentError(c, err);
    }
  });

  return app;
}
