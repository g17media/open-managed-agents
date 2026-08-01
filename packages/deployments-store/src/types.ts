// Public types for the deployments-store service. Mirrors the schema in
// apps/main/migrations/0019_deployments.sql.
//
// A `deployment` is a stored launch recipe: agent + environment + vaults +
// memory stores + an initial message, fired either manually
// (POST /v1/oma/deployments/:id/run) or on a cron schedule (the
// deployments-tick job). Every run creates a regular session behind the
// scenes and sends the initial message — deployments own no runtime state
// of their own beyond run bookkeeping.

export type DeploymentTriggerType = "manual" | "schedule";

export interface DeploymentTrigger {
  type: DeploymentTriggerType;
  /** Cron expression (croner syntax). Present iff type === "schedule". */
  cron?: string | null;
}

export const MAX_DEPLOYMENT_NAME_CHARS = 256;
export const MAX_DEPLOYMENT_MESSAGE_CHARS = 65536;

/**
 * The shape returned by the repo + service. ISO strings on the wire, like
 * sessions / dreams. `trigger` is split across two columns in storage
 * (trigger_type, cron) but flattened back at the boundary.
 */
export interface DeploymentRow {
  id: string;
  tenant_id: string;
  name: string;
  agent_id: string;
  /** Null for local-runtime agents (session create falls back to the
   *  local-runtime sentinel env). */
  environment_id: string | null;
  initial_message: string;
  vault_ids: string[];
  memory_store_ids: string[];
  trigger: DeploymentTrigger;
  /** Next scheduled fire time — null for manual deployments. */
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
