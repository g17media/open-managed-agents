import Database from "better-sqlite3";
import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { MIGRATION_ID } from "./v0-data-model";
import { canonical, planMigration, safePath, sha, tableExists, type MigrationOptions, type MigrationPlan, type MigrationReport } from "./v0-data-plan";

export interface AppliedMigration extends MigrationReport { completedAt: string; backupDirectory: string; backupManifestSha256: string }
export interface MigrationProgress { phase: "planning" | "backup" | "copying" | "verifying" | "completed"; report?: MigrationReport | AppliedMigration }
export function completedMigration(db: Database.Database): AppliedMigration | null {
  if (!tableExists(db, "oma_data_migrations")) return null;
  const row = db.prepare("SELECT report FROM oma_data_migrations WHERE id=?").get(MIGRATION_ID) as { report: string } | undefined;
  return row ? JSON.parse(row.report) : null;
}

export function hasV0Data(db: Database.Database): boolean {
  const needsMigration = ["agents", "agent_versions", "sessions", "deployments", "vaults", "credentials", "files", "memory_stores"]
    .some((table) => tableExists(db, table) && db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get());
  const hasSkills = tableExists(db, "kv_entries") && db.prepare("SELECT 1 FROM kv_entries WHERE key LIKE 't:%:skill:%' LIMIT 1").get();
  const hasEnvironments = tableExists(db, "environments") && db.prepare("SELECT 1 FROM environments WHERE id <> 'env-local-runtime' LIMIT 1").get();
  return Boolean(needsMigration || hasSkills || hasEnvironments);
}

/** Used only when an operator explicitly disables automatic migration. */
export function assertV0DataMigrated(db: Database.Database): boolean {
  if (completedMigration(db)) return true;
  const needsMigration = hasV0Data(db);
  if (needsMigration) throw new Error("Existing SQLite data needs the v0-to-v1 migration. Automatic migration is disabled by OMA_AUTO_MIGRATE=0. Enable it or use migrate:v0 plan/apply; see docs/sqlite-v1-migration.md. Original records have not been removed.");
  return false;
}

/** Default startup path: complete the migration before any app graph,
 * background job or HTTP listener can access the new resource tables. */
export async function migrateV0AtStartup(options: MigrationOptions & {
  enabled?: boolean; storagePaths?: Partial<Record<"files-blobs" | "memory-blobs" | "sandboxes" | "session-outputs" | "auth.db", string>>;
  remoteBlobs?: boolean; onProgress?: (progress: MigrationProgress) => void;
}): Promise<AppliedMigration | null> {
  const path = resolve(options.databasePath ?? join(options.dataDir, "oma.db"));
  const db = new Database(path, { fileMustExist: true });
  try {
    const done = completedMigration(db);
    if (done) return done;
    if (options.enabled === false) { assertV0DataMigrated(db); return null; }
    if (!hasV0Data(db)) return null;
  } finally { db.close(); }
  if (options.remoteBlobs) throw new Error("Automatic v0 migration needs a mapping for remote blob storage; original data is unchanged. See docs/sqlite-v1-migration.md.");
  for (const [name, configured] of Object.entries(options.storagePaths ?? {})) {
    if (configured && resolve(configured) !== resolve(options.dataDir, name)) throw new Error(`Automatic v0 migration needs a mapping for the configured ${name} directory; original data is unchanged. See docs/sqlite-v1-migration.md.`);
  }
  const result = await applyMigration({ ...options, databasePath: path, maintenance: true });
  return result.report;
}

async function lockDatabase(db: Database.Database) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { db.exec("BEGIN IMMEDIATE"); return; }
    catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

async function fileManifest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) result[key] = `symlink:${await fs.readlink(path)}`;
      else if (entry.isFile()) result[key] = sha(await fs.readFile(path));
      else throw new Error(`Unsupported backup entry: ${key}`);
    }
  }
  await walk(root);
  return result;
}

async function backupData(options: MigrationOptions, backupRoot: string, configFile?: string) {
  const source = await fs.realpath(options.dataDir);
  if (resolve(backupRoot) === source) throw new Error("Backup directory must be separate from the data directory");
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(join(backupRoot, `${MIGRATION_ID}-`));
  await fs.chmod(directory, 0o700);
  const target = join(directory, "data");
  await fs.mkdir(target, { mode: 0o700 });
  async function copy(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const from = join(dir, entry.name);
      if (entry.name === ".backups" || from === resolve(backupRoot)) continue;
      const to = join(target, relative(source, from));
      if (entry.isDirectory()) { await fs.mkdir(to, { mode: 0o700 }); await copy(from); }
      else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
      else if (entry.isFile()) {
        if (/\.(db|sqlite)(-wal|-shm|-journal)$/.test(entry.name)) continue;
        if (/\.(db|sqlite)$/.test(entry.name) || from === resolve(options.databasePath ?? join(source, "oma.db"))) {
          const original = new Database(from, { readonly: true, fileMustExist: true });
          try { await original.backup(to); } finally { original.close(); }
          const saved = new Database(to, { readonly: true });
          try { if (saved.pragma("integrity_check", { simple: true }) !== "ok") throw new Error(`Backup integrity check failed: ${entry.name}`); }
          finally { saved.close(); }
        } else await fs.copyFile(from, to, constants.COPYFILE_EXCL);
        await fs.chmod(to, 0o600);
      } else throw new Error(`Unsupported backup entry: ${relative(source, from)}`);
    }
  }
  await copy(source);
  if (configFile) { await fs.copyFile(configFile, join(directory, "configuration.env"), constants.COPYFILE_EXCL); await fs.chmod(join(directory, "configuration.env"), 0o600); }
  else if (options.backupConfiguration) {
    const configuration = Object.entries(options.backupConfiguration).map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("Invalid backup configuration name");
      return `${name}=${JSON.stringify(value)}`;
    }).join("\n") + "\n";
    await fs.writeFile(join(directory, "configuration.env"), configuration, { flag: "wx", mode: 0o600 });
  }
  const manifest = await fileManifest(directory);
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(join(directory, "manifest.json"), serialized, { flag: "wx", mode: 0o600 });
  // Read every backup byte again; an existing tarball or filename is not proof.
  const verified = await fileManifest(directory);
  delete verified["manifest.json"];
  if (canonical(verified) !== canonical(manifest)) throw new Error("Backup verification failed");
  return { directory, manifestSha256: sha(serialized) };
}

function applyPendingSchema(db: Database.Database) {
  // Execute the same checked-in SQL and journal used by Drizzle, inside the
  // data migration's transaction so schema + documents commit together.
  db.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
  const last = db.prepare("SELECT MAX(created_at) AS time FROM __drizzle_migrations").get() as { time: number | null };
  for (const migration of readMigrationFiles({ migrationsFolder: new URL("../../migrations-sqlite", import.meta.url).pathname })) {
    if (last.time != null && last.time >= migration.folderMillis) continue;
    for (const statement of migration.sql) db.exec(statement);
    db.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)").run(migration.hash, migration.folderMillis);
  }
}

async function ensureParent(root: string, path: string) {
  const parent = dirname(safePath(root, path));
  let current = root;
  for (const segment of relative(root, parent).split("/").filter(Boolean)) {
    current = join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!(await fs.lstat(current)).isDirectory()) throw new Error(`Destination parent is not a directory: ${path}`);
  }
}

async function verifyFiles(plan: MigrationPlan, dataDir: string, destination: boolean) {
  for (const file of plan.files) {
    const path = safePath(dataDir, destination && file.target ? file.target : file.source);
    const stat = await fs.lstat(path);
    const hash = file.symlink !== undefined
      ? stat.isSymbolicLink() ? sha(await fs.readlink(path)) : "not a symlink"
      : stat.isFile() && !stat.isSymbolicLink() ? sha(await fs.readFile(path)) : "not a regular file";
    if (hash !== file.sha256 || (file.symlink === undefined && stat.size !== file.size)) throw new Error(`File verification failed: ${file.source}`);
  }
}

export async function verifyMigrationRows(db: Database.Database, plan: MigrationPlan, options: MigrationOptions) {
  for (const row of plan.rows) {
    const record = db.prepare(`SELECT * FROM "${row.table}" WHERE ${Object.keys(row.key).map((key) => `"${key}"=?`).join(" AND ")}`).get(...Object.values(row.key)) as Record<string, unknown> | undefined;
    if (!record) throw new Error(`Verification missing row in ${row.table}`);
    for (const [column, expected] of Object.entries(row.values)) {
      const seal = row.seals?.[column];
      const actual = seal ? await new WebCryptoAesGcm(options.rootSecret, seal.purpose).decrypt(String(record[column])) : record[column];
      if (canonical(actual) !== canonical(seal ? seal.plaintext : expected)) throw new Error(`Verification mismatch in ${row.table}.${column}`);
    }
  }
  await verifyFiles(plan, await fs.realpath(options.dataDir), true);
  if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Migrated SQLite integrity check failed");
}

export async function applyMigration(options: MigrationOptions & { expected?: MigrationReport; backupRoot?: string; maintenance: boolean; configFile?: string; onProgress?: (progress: MigrationProgress) => void }): Promise<{ type: "applied" | "already_applied"; report: AppliedMigration }> {
  if (!options.maintenance) throw new Error("Stop all database/blob writers and pass --maintenance before applying");
  const root = await fs.realpath(options.dataDir);
  const db = new Database(options.databasePath ?? join(root, "oma.db"), { fileMustExist: true, timeout: 0 });
  let backup: { directory: string; manifestSha256: string } | undefined;
  try {
    await lockDatabase(db);
    const completed = completedMigration(db);
    if (completed) {
      if (options.expected && (options.expected.migration !== completed.migration || options.expected.planSha256 !== completed.planSha256)) throw new Error("Database already migrated with a different plan");
      if (sha(`migration-key:${options.rootSecret}`) !== completed.keySha256) throw new Error("Migration encryption key differs from the completed migration");
      db.exec("COMMIT");
      return { type: "already_applied", report: completed };
    }
    const checkedOptions = { ...options, dataDir: root, createdAt: options.expected?.createdAt ?? options.createdAt ?? new Date().toISOString() };
    options.onProgress?.({ phase: "planning" });
    const plan = await planMigration(db, checkedOptions);
    if (options.expected && canonical(plan.report) !== canonical(options.expected)) throw new Error("Migration plan is stale or configuration changed; create and review a fresh plan");
    options.onProgress?.({ phase: "backup", report: plan.report });
    backup = await backupData(checkedOptions, options.backupRoot ?? join(root, ".backups"), options.configFile);
    const locked = await planMigration(db, checkedOptions);
    if (locked.report.planSha256 !== plan.report.planSha256) throw new Error("Data changed during backup; stop all writers and plan again");
    applyPendingSchema(db);
    options.onProgress?.({ phase: "copying", report: plan.report });
    for (const file of plan.files) {
      if (!file.target) continue;
      await ensureParent(root, file.target);
      const target = safePath(root, file.target);
      try {
        if (file.symlink !== undefined) await fs.symlink(file.symlink, target);
        else {
          const staged = `${target}.migration-${process.pid}`;
          await fs.copyFile(safePath(root, file.source), staged, constants.COPYFILE_EXCL);
          try { await fs.link(staged, target); } finally { await fs.unlink(staged); }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    for (const row of plan.rows) {
      const values = { ...row.values };
      for (const [column, seal] of Object.entries(row.seals ?? {})) values[column] = await new WebCryptoAesGcm(options.rootSecret, seal.purpose).encrypt(seal.plaintext);
      const columns = Object.keys(values);
      db.prepare(`INSERT INTO "${row.table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(values));
    }
    options.onProgress?.({ phase: "verifying", report: plan.report });
    await verifyMigrationRows(db, plan, options);
    await verifyFiles(plan, root, false);
    const report: AppliedMigration = { ...plan.report, completedAt: new Date().toISOString(), backupDirectory: backup.directory, backupManifestSha256: backup.manifestSha256 };
    db.exec("CREATE TABLE IF NOT EXISTS oma_data_migrations (id TEXT PRIMARY KEY, report TEXT NOT NULL)");
    db.prepare("INSERT INTO oma_data_migrations(id,report) VALUES (?,?)").run(MIGRATION_ID, JSON.stringify(report));
    db.exec("COMMIT");
    options.onProgress?.({ phase: "completed", report });
    return { type: "applied", report };
  } catch (error) {
    if (!db.inTransaction && completedMigration(db)) throw error;
    if (db.inTransaction) db.exec("ROLLBACK");
    if (!backup) throw error;
    throw new Error(`Migration failed; SQL changes rolled back. Verified backup: ${backup.directory}. ${error instanceof Error ? error.message : "Unknown error"}`);
  } finally { db.close(); }
}
