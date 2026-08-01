CREATE TABLE IF NOT EXISTS "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"agent_id" text NOT NULL,
	"environment_id" text,
	"initial_message" text NOT NULL,
	"vault_ids" text NOT NULL,
	"memory_store_ids" text NOT NULL,
	"trigger_type" text NOT NULL,
	"cron" text,
	"next_run_at" bigint,
	"last_run_at" bigint,
	"last_session_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deployments_tenant_created" ON "deployments" ("tenant_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deployments_due" ON "deployments" ("trigger_type","next_run_at") WHERE "archived_at" IS NULL;
