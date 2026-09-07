import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { planMigration } from "./v0-data-plan";
import { applyMigration, completedMigration } from "./v0-data";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, "config": { type: "string" }, report: { type: "string" },
    plan: { type: "string" }, "backup-dir": { type: "string" }, maintenance: { type: "boolean" },
  } });
  if (values["config"]) process.loadEnvFile(resolve(values["config"]));
  if (process.env.DATABASE_URL || process.env.FILES_S3_ENDPOINT || process.env.FILES_S3_BUCKET || process.env.MEMORY_S3_ENDPOINT || process.env.MEMORY_S3_BUCKET) throw new Error("This migration supports SQLite with local filesystem blobs. Remote stores need their own migration mapping.");
  if (!values["data-dir"]) throw new Error("Pass --data-dir containing oma.db, auth.db and the blob/workspace directories");
  const dataDir = resolve(values["data-dir"]);
  const options = { dataDir, rootSecret: process.env.PLATFORM_ROOT_SECRET ?? "" };
  if (positionals[0] === "apply") {
    if (!values.plan) throw new Error("Pass --plan with the reviewed dry-run report");
    const result = await applyMigration({ ...options, expected: JSON.parse(await fs.readFile(resolve(values.plan), "utf8")), maintenance: values.maintenance ?? false,
      ...(values["backup-dir"] && { backupRoot: resolve(values["backup-dir"]) }), ...(values["config"] && { configFile: resolve(values["config"]) }) });
    if (values.report) await fs.writeFile(resolve(values.report), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const db = new Database(join(dataDir, "oma.db"), { readonly: true, fileMustExist: true });
  try {
    if (positionals[0] === "status") { console.log(JSON.stringify(completedMigration(db) ?? { status: "not_migrated" }, null, 2)); return; }
    if (positionals[0] !== "plan" || !values.report) throw new Error("Usage: migrate:v0 plan --data-dir PATH --report PLAN.json [--config PATH]; apply --data-dir PATH --plan PLAN.json --maintenance; status --data-dir PATH");
    if (completedMigration(db)) throw new Error("This database is already migrated; use status to read its audit report");
    const plan = await planMigration(db, options);
    await fs.writeFile(resolve(values.report), JSON.stringify(plan.report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(plan.report, null, 2));
  } finally { db.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Migration failed"); process.exitCode = 1; });
