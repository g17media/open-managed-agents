-- Migration 0019: Deployments — stored launch recipes.
--
-- A `deployment` bundles agent + environment + vaults + memory stores + an
-- initial message, fired manually (POST /v1/oma/deployments/:id/run) or on
-- a cron schedule (the deployments-tick job). Every run creates a regular
-- session (tagged metadata.deployment_id) and sends the initial message —
-- the deployment row only carries the recipe + run bookkeeping.
--
-- Storage choices:
--   * `vault_ids` / `memory_store_ids` are JSON arrays read whole — no
--     reverse-lookup use case yet, so no split columns.
--   * `trigger_type` + `cron` split so the due-sweep index below stays
--     JSON-free. `next_run_at` is NULL for manual deployments.
--   * `last_session_id` links the console straight to the latest run;
--     full run history is derivable from sessions.metadata.deployment_id.

CREATE TABLE IF NOT EXISTS "deployments" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "agent_id"          TEXT NOT NULL,
  "environment_id"    TEXT,            -- NULL for local-runtime agents
  "initial_message"   TEXT NOT NULL,
  "vault_ids"         TEXT NOT NULL,   -- JSON array of vault ids
  "memory_store_ids"  TEXT NOT NULL,   -- JSON array of memory store ids
  "trigger_type"      TEXT NOT NULL,   -- 'manual' | 'schedule'
  "cron"              TEXT,            -- croner expression when scheduled
  "next_run_at"       INTEGER,         -- NULL for manual
  "last_run_at"       INTEGER,
  "last_session_id"   TEXT,
  "created_at"        INTEGER NOT NULL,
  "updated_at"        INTEGER,
  "archived_at"       INTEGER
);

-- List endpoint: newest first per tenant.
CREATE INDEX IF NOT EXISTS "idx_deployments_tenant_created"
  ON "deployments" ("tenant_id", "created_at" DESC);

-- Cron sweep: due scheduled deployments, cross-tenant.
CREATE INDEX IF NOT EXISTS "idx_deployments_due"
  ON "deployments" ("trigger_type", "next_run_at")
  WHERE "archived_at" IS NULL;
