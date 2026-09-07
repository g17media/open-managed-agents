import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { zipSync, unzipSync } from "fflate";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { ZipSkillPackageCompiler, RuntimeEventStreamDecoder, CronDeploymentSchedulePlanner } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { Agent, Session, SessionEventView } from "@open-managed-agents/managed-agents-application";
import { toSessionEventResponse, sessionStreamEventResponseSchema } from "@open-managed-agents/managed-agents-api";
import { agent, environment, credentialAuth, object, array, string, iso, milliseconds, metadata, camel, MIGRATION_ID, type Legacy } from "./v0-data-model";

export type SqlValue = string | number | null | Buffer;
export interface MigrationRow { table: string; key: Record<string, SqlValue>; values: Record<string, SqlValue>; seals?: Record<string, { purpose: string; plaintext: string }> }
export interface MigrationFile { source: string; target?: string; sha256: string; size: number; symlink?: string }
export interface MigrationReport {
  migration: string; createdAt: string; sourceSha256: string; destinationSha256: string;
  keySha256: string; planSha256: string; sourceCounts: Record<string, number>;
  destinationCounts: Record<string, number>; fileCount: number; fileBytes: number;
  retainedOrphanEvents: number; warnings: string[];
}
export interface MigrationPlan { report: MigrationReport; rows: MigrationRow[]; files: MigrationFile[] }
export interface MigrationOptions { dataDir: string; rootSecret: string; createdAt?: string; databasePath?: string; backupConfiguration?: Record<string, string> }

export const SOURCE_TABLES = ["agents", "agent_versions", "environments", "vaults", "credentials", "files", "sessions", "session_resources", "session_memory_stores", "session_events", "session_threads", "memory_stores", "memories", "memory_versions", "deployments", "kv_entries", "model_cards"];
export function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function canonical(value: any): string {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return JSON.stringify({ bytes: sha(value), size: value.byteLength });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
export function readRows(db: Database.Database, table: string): Legacy[] {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid migration table");
  return tableExists(db, table) ? db.prepare(`SELECT * FROM "${table}"`).all() as Legacy[] : [];
}
export function sourceTables(db: Database.Database): Record<string, Legacy[]> {
  return Object.fromEntries(SOURCE_TABLES.map((table) => [table, readRows(db, table).sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}
export function destinationFingerprint(db: Database.Database): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%' ORDER BY name").all() as { name: string }[]);
  return sha(canonical(tables.map(({ name }) => [name, readRows(db, name).map(canonical).sort()])));
}
export function safePath(root: string, path: string): string {
  const result = resolve(root, path);
  const rel = relative(resolve(root), result);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel.includes("\0")) throw new Error("Migration path escapes its data directory");
  return result;
}

export async function planMigration(db: Database.Database, options: MigrationOptions): Promise<MigrationPlan> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const source = sourceTables(db);
  const rows: MigrationRow[] = [];
  const files: MigrationFile[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();
  const root = await fs.realpath(options.dataDir);
  const emit = (table: string, key: Record<string, SqlValue>, values: Record<string, SqlValue>, seals?: MigrationRow["seals"]) => {
    const identity = `${table}:${canonical(key)}`;
    if (keys.has(identity)) throw new Error(`Duplicate migration destination ${table} ${canonical(key)}`);
    keys.add(identity);
    if (tableExists(db, table)) {
      const uniqueKey = ["managed_agents", "managed_sessions"].includes(table) ? { id: key.id! } : table === "managed_agent_versions" ? { agent_id: key.agent_id!, version: key.version! } : key;
      const where = Object.keys(uniqueKey).map((column) => `"${column}"=?`).join(" AND ");
      if (db.prepare(`SELECT 1 FROM "${table}" WHERE ${where}`).get(...Object.values(uniqueKey))) throw new Error(`Destination already contains ${table} ${canonical(key)}; refusing to overwrite`);
    }
    rows.push({ table, key, values: { ...key, ...values }, ...(seals && { seals }) });
  };
  const document = (value: Legacy) => ({ document: JSON.stringify(value), created_at: milliseconds(value.createdAt, "createdAt"), updated_at: milliseconds(value.updatedAt ?? value.createdAt, "updatedAt"), archived_at: value.archivedAt == null ? null : milliseconds(value.archivedAt, "archivedAt") });
  const inspectFile = async (path: string, target?: string, expectedSize?: number, expectedHash?: string) => {
    const from = safePath(root, path);
    const stat = await fs.lstat(from);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(from) !== from) throw new Error(`Source blob must be a regular file: ${path}`);
    const bytes = await fs.readFile(from);
    const hash = sha(bytes);
    if (expectedSize != null && bytes.byteLength !== expectedSize) throw new Error(`Source blob size mismatch: ${path}`);
    if (expectedHash && hash !== expectedHash) throw new Error(`Source blob checksum mismatch: ${path}`);
    if (target) {
      try {
        const existing = await fs.readFile(safePath(root, target));
        if (sha(existing) !== hash) throw new Error(`Destination file conflicts: ${target}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    files.push({ source: path, ...(target && { target }), sha256: hash, size: bytes.byteLength });
    return bytes;
  };
  if (source.session_threads.length) throw new Error("Legacy child session threads require an explicit migration mapping");
  for (const table of ["dreams", "eval_runs"]) {
    if (readRows(db, table).length) warnings.push(`${table} remains in its existing OMA extension store; no records are removed.`);
  }
  const ownerKey = (workspace: string, id: string) => `${workspace}:${id}`;
  const environments = new Map<string, ReturnType<typeof environment>>();
  for (const row of source.environments) {
    const value = environment(row);
    environments.set(ownerKey(row.tenant_id, row.id), value);
    emit("managed_environments", { workspace_id: row.tenant_id, id: row.id }, { ...document(value), revision: 1 });
  }
  const vaults = new Set<string>();
  for (const row of source.vaults) {
    const value = { id: row.id, displayName: row.name, metadata: metadata(row.metadata), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at ?? row.created_at), archivedAt: row.archived_at == null ? null : iso(row.archived_at) };
    vaults.add(ownerKey(row.tenant_id, row.id));
    emit("managed_vaults", { workspace_id: row.tenant_id, id: row.id }, { ...document(value), revision: 1 });
  }
  const oldCrypto = options.rootSecret ? new WebCryptoAesGcm(options.rootSecret, "credentials.auth") : null;
  for (const row of source.credentials) {
    if (!options.rootSecret) throw new Error("PLATFORM_ROOT_SECRET is required to migrate credentials");
    if (!vaults.has(ownerKey(row.tenant_id, row.vault_id))) throw new Error(`Credential ${row.id} has no vault in its workspace`);
    const auth = typeof row.auth === "string" && row.auth.trim().startsWith("{") ? row.auth : await oldCrypto!.decrypt(row.auth);
    const value = { id: row.id, vaultId: row.vault_id, displayName: row.display_name ?? null,
      auth: credentialAuth(object(auth, `Credential ${row.id}`)), metadata: {}, createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at ?? row.created_at), archivedAt: row.archived_at == null ? null : iso(row.archived_at) };
    const { document: _document, ...columns } = document(value);
    emit("managed_credentials", { workspace_id: row.tenant_id, id: row.id }, { ...columns, vault_id: row.vault_id, sealed_document: "", revision: 1 },
      { sealed_document: { purpose: "managed.vault.credentials", plaintext: JSON.stringify(value) } });
  }
  const skills = new Map<string, Legacy>();
  const skillVersions = new Set<string>();
  const skillEntries = source.kv_entries.flatMap((row) => {
    const match = /^t:([^:]+):(skill|skillver):(.+)$/.exec(row.key);
    return match ? [{ workspace: match[1], kind: match[2], suffix: match[3], value: object(row.value, `Skill entry ${row.key}`) }] : [];
  });
  for (const entry of skillEntries.filter((entry) => entry.kind === "skill")) {
    const old = entry.value;
    const value = { id: old.id, displayTitle: old.display_title ?? old.name ?? null, latestVersion: old.latest_version ?? null,
      source: old.source ?? "custom", createdAt: iso(old.created_at), updatedAt: iso(old.updated_at ?? old.created_at),
      ...(old.github_source && { githubSource: camel(old.github_source) }) };
    skills.set(ownerKey(entry.workspace, old.id), { ...old, workspace: entry.workspace });
    const { archived_at: _archive, ...columns } = document(value);
    emit("managed_skills", { workspace_id: entry.workspace, id: old.id }, { ...columns, source: value.source, revision: 1 });
  }
  const compiler = new ZipSkillPackageCompiler();
  for (const entry of skillEntries.filter((entry) => entry.kind === "skillver")) {
    const separator = entry.suffix.lastIndexOf(":");
    const skillId = entry.suffix.slice(0, separator);
    const version = entry.suffix.slice(separator + 1);
    if (!skills.has(ownerKey(entry.workspace, skillId))) throw new Error(`Skill version ${skillId}@${version} has no parent`);
    const inputs = [];
    for (const file of array(entry.value.files, "skill files")) {
      const filename = string(file.filename, "skill filename");
      const content = file.content != null
        ? Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")
        : await inspectFile(`files-blobs/t/${entry.workspace}/skills/${skillId}/${version}/${filename}`, undefined, file.size_bytes);
      inputs.push({ filename, content, mimeType: "application/octet-stream" });
    }
    const compiled = await compiler.compile({ files: inputs });
    if (compiled.type !== "compiled") throw new Error(`Skill ${skillId}@${version}: ${compiled.message}`);
    const info = compiled.package;
    const value = { id: `skver_v0_${sha(`${entry.workspace}:${skillId}:${version}`).slice(0, 24)}`, skillId, version,
      name: info.name, directory: info.directory, description: info.description, createdAt: iso(entry.value.created_at) };
    const archive = zipSync(unzipSync(info.archive.content), { level: 6, mtime: new Date(value.createdAt) });
    emit("managed_skill_versions", { workspace_id: entry.workspace, skill_id: skillId, version }, {
      id: value.id, document: JSON.stringify(value), archive: Buffer.from(archive), archive_filename: info.archive.filename,
      archive_media_type: info.archive.mediaType, created_at: milliseconds(value.createdAt, "skill version time"),
    });
    skillVersions.add(`${entry.workspace}:${skillId}:${version}`);
  }
  const resolveSkill = (workspace: string) => (binding: Legacy): Agent["skills"][number] => {
    const candidates = [...skills.values()].filter((skill) => skill.workspace === workspace && (skill.id === binding.skill_id || skill.name === binding.skill_id));
    if (candidates.length !== 1) throw new Error(`Skill binding ${binding.skill_id} cannot be resolved unambiguously in its workspace`);
    const skill = candidates[0]!;
    const version = !binding.version || binding.version === "latest" ? skill.latest_version : binding.version;
    if (!skillVersions.has(`${workspace}:${skill.id}:${version}`)) throw new Error(`Missing skill version ${skill.id}@${version}`);
    return { type: skill.source === "anthropic" ? "anthropic" : "custom", skillId: skill.id, version };
  };
  const versionsByWorkspace = (workspace: string) => new Map(source.agents.filter((row) => row.tenant_id === workspace).map((row) => [row.id, Number(row.version)]));
  const agents = new Map<string, Agent>();
  for (const row of source.agents) {
    const value = agent(row, object(row.config, `Agent ${row.id}`), resolveSkill(row.tenant_id), versionsByWorkspace(row.tenant_id));
    agents.set(ownerKey(row.tenant_id, row.id), value);
    emit("managed_agents", { workspace_id: row.tenant_id, id: row.id }, { ...document(value), version: value.version });
  }
  for (const row of source.agent_versions) {
    const value = agent({ ...row, id: row.agent_id }, object(row.snapshot, "agent version"), resolveSkill(row.tenant_id), versionsByWorkspace(row.tenant_id));
    emit("managed_agent_versions", { workspace_id: row.tenant_id, agent_id: row.agent_id, version: row.version }, { document: JSON.stringify(value), created_at: row.created_at });
  }
  const fileIds = new Set<string>();
  for (const row of source.files) {
    const value = { id: row.id, filename: row.filename, mimeType: row.media_type, sizeBytes: Number(row.size_bytes), createdAt: iso(row.created_at),
      downloadable: Boolean(row.downloadable), scope: row.session_id ? { type: "session", id: row.session_id } : null };
    await inspectFile(`files-blobs/${row.r2_key}`, `files-blobs/managed-files/${encodeURIComponent(row.tenant_id)}/${encodeURIComponent(row.id)}`, Number(row.size_bytes));
    fileIds.add(ownerKey(row.tenant_id, row.id));
    emit("managed_files", { workspace_id: row.tenant_id, id: row.id }, { document: JSON.stringify(value), created_at: row.created_at, scope_id: row.session_id ?? null });
  }
  const stores = new Map<string, Legacy>();
  for (const row of source.memory_stores) {
    stores.set(row.id, row);
    const value = { id: row.id, name: row.name, ...(row.description != null && { description: row.description }), metadata: {},
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at ?? row.created_at), archivedAt: row.archived_at == null ? null : iso(row.archived_at) };
    emit("managed_memory_stores", { workspace_id: row.tenant_id, id: row.id }, { ...document(value), revision: 1 });
  }
  for (const row of source.memory_versions) {
    const store = stores.get(row.store_id);
    if (!store) {
      warnings.push(`Memory version ${row.id} belongs to a previously removed store; retained intact in memory_versions.`);
      continue;
    }
    const actors: Record<string, string> = { agent_session: "session", session: "session", api: "api", api_key: "api", user: "user", service_account: "service_account", system: "service_account" };
    const kind = actors[row.actor_type];
    if (!kind) throw new Error(`Memory version ${row.id}: unsupported actor type`);
    const actorKey: Record<string, string> = { session: "sessionId", api: "apiKeyId", user: "userId", service_account: "serviceAccountId" };
    const actorId = row.actor_id ?? "v0-memory-service";
    const value = { id: row.id, memoryId: row.memory_id, memoryStoreId: row.store_id, operation: row.operation,
      path: row.redacted ? null : row.path, content: row.redacted ? null : row.content,
      contentSha256: row.redacted ? null : row.content_sha256, contentSizeBytes: row.redacted ? null : row.size_bytes,
      createdAt: iso(row.created_at), createdBy: { kind, [actorKey[kind]!]: actorId },
      redactedAt: row.redacted ? createdAt : null, ...(row.redacted && { redactedBy: { kind: "service_account", serviceAccountId: MIGRATION_ID } }) };
    emit("managed_memory_versions", { workspace_id: store.tenant_id, id: row.id }, { document: JSON.stringify(value), memory_store_id: row.store_id,
      memory_id: row.memory_id, revision: 1, operation: row.operation, actor_kind: kind, actor_id: actorId, created_at: row.created_at,
      redacted_at: row.redacted ? milliseconds(createdAt, "migration time") : null });
  }
  for (const row of source.memories) {
    const store = stores.get(row.store_id);
    if (!store) throw new Error(`Memory ${row.id} has no memory store`);
    const bytes = await inspectFile(`memory-blobs/${row.store_id}/${string(row.path, "memory path").replace(/^\/+/, "")}`, undefined, row.size_bytes, row.content_sha256);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    let head = source.memory_versions.filter((version) => version.memory_id === row.id && !version.redacted && version.operation !== "deleted" && version.content_sha256 === row.content_sha256)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
    if (!head) {
      head = { id: `memver_v0_${sha(`${store.tenant_id}:${row.id}`).slice(0, 24)}` };
      const version = { id: head.id, memoryId: row.id, memoryStoreId: row.store_id, operation: "modified", path: row.path, content,
        contentSha256: row.content_sha256, contentSizeBytes: bytes.byteLength, createdAt: iso(row.updated_at),
        createdBy: { kind: "service_account", serviceAccountId: MIGRATION_ID }, redactedAt: null };
      emit("managed_memory_versions", { workspace_id: store.tenant_id, id: head.id }, { document: JSON.stringify(version), memory_store_id: row.store_id,
        memory_id: row.id, revision: 1, operation: "modified", actor_kind: "service_account", actor_id: MIGRATION_ID, created_at: row.updated_at, redacted_at: null });
      warnings.push(`Memory ${row.id}: added a version for its current content, which had no matching historical version.`);
    }
    const value = { id: row.id, memoryStoreId: row.store_id, path: row.path, content, contentSha256: row.content_sha256, contentSizeBytes: bytes.byteLength,
      memoryVersionId: head.id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
    emit("managed_memories", { workspace_id: store.tenant_id, id: row.id }, { document: JSON.stringify(value), memory_store_id: row.store_id, revision: 1,
      path: row.path, created_at: row.created_at, updated_at: row.updated_at });
  }
  const sessions = new Map<string, { workspace: string; value: Session }>();
  let unpinnedEnvironments = 0;
  for (const row of source.sessions) {
    if (!["idle", "terminated"].includes(row.status) || row.turn_id) throw new Error(`Session ${row.id} is active; drain all writers before migration`);
    const workspace = string(row.tenant_id, "session workspace");
    const current = agents.get(ownerKey(workspace, row.agent_id));
    const env = environments.get(ownerKey(workspace, row.environment_id));
    if (!current || !env) throw new Error(`Session ${row.id}: agent/environment is missing from its workspace`);
    const rawAgent = row.agent_snapshot ? object(row.agent_snapshot, "session agent snapshot") : null;
    if (!rawAgent) throw new Error(`Session ${row.id}: missing agent snapshot`);
    const snapshot = agent({ ...row, id: row.agent_id, version: rawAgent.version, created_at: rawAgent.created_at ?? row.created_at, updated_at: rawAgent.updated_at ?? row.created_at }, rawAgent, resolveSkill(workspace), versionsByWorkspace(workspace));
    const snapshotEnv = row.environment_snapshot ? object(row.environment_snapshot, "session environment snapshot") : {};
    if (!snapshotEnv.config) unpinnedEnvironments++;
    const pinnedEnvironment = snapshotEnv.config ? environment({ ...env, ...snapshotEnv, created_at: snapshotEnv.created_at ?? row.created_at, updated_at: snapshotEnv.updated_at ?? row.created_at }) : env;
    const resources: Session["resources"] = [];
    for (const resourceRow of source.session_resources.filter((item) => item.session_id === row.id)) {
      const raw = object(resourceRow.config, `Resource ${resourceRow.id}`);
      if (resourceRow.type === "memory_store") {
        const store = stores.get(raw.memory_store_id);
        if (!store || store.tenant_id !== workspace) throw new Error(`Session ${row.id}: memory resource crosses workspace or is missing`);
        resources.push({ type: "memory_store", memoryStoreId: store.id, name: store.name, description: store.description ?? undefined,
          access: raw.access ?? "read_write", instructions: raw.instructions ?? null, mountPath: `/mnt/memory/${store.name}` });
        emit("managed_session_memory_stores", { workspace_id: workspace, session_id: row.id, memory_store_id: store.id }, {});
      } else if (resourceRow.type === "file") {
        if (!fileIds.has(ownerKey(workspace, raw.file_id))) throw new Error(`Session ${row.id}: file resource crosses workspace or is missing`);
        resources.push({ id: resourceRow.id, type: "file", fileId: raw.file_id, mountPath: raw.mount_path ?? `/workspace/${source.files.find((file) => file.id === raw.file_id)!.filename}`,
          createdAt: iso(resourceRow.created_at), updatedAt: iso(resourceRow.created_at) });
      } else if (resourceRow.type === "github_repository") {
        const token = raw.authorization_token ?? (raw.credential_id ? await resolveRepositoryToken(raw.credential_id, workspace, source.credentials, options.rootSecret) : undefined);
        if (!token) throw new Error(`Repository resource ${resourceRow.id} has no resolvable credential`);
        resources.push({ id: resourceRow.id, type: "github_repository", url: raw.repo_url ?? raw.url, checkout: raw.checkout ?? null,
          mountPath: raw.mount_path ?? "/workspace", createdAt: iso(resourceRow.created_at), updatedAt: iso(resourceRow.created_at) });
        emit("managed_session_resource_secrets", { workspace_id: workspace, session_id: row.id, resource_id: resourceRow.id },
          { secret_type: "github_token", sealed_value: "", updated_at: resourceRow.created_at }, { sealed_value: { purpose: "managed.sessions.resources", plaintext: token } });
      } else throw new Error(`Unsupported session resource type ${resourceRow.type}`);
    }
    for (const binding of source.session_memory_stores.filter((item) => item.session_id === row.id)) {
      const store = stores.get(binding.store_id);
      if (!store || store.tenant_id !== workspace) throw new Error(`Session ${row.id}: legacy memory binding crosses workspace or is missing`);
      const existing = resources.find((resource) => resource.type === "memory_store" && resource.memoryStoreId === store.id);
      if (existing?.type === "memory_store") {
        if ((existing.access ?? "read_write") !== binding.access) throw new Error(`Session ${row.id}: conflicting memory access in the two v0 binding tables`);
        continue;
      }
      resources.push({ type: "memory_store", memoryStoreId: store.id, name: store.name, description: store.description ?? undefined,
        access: binding.access, instructions: null, mountPath: `/mnt/memory/${store.name}` });
      emit("managed_session_memory_stores", { workspace_id: workspace, session_id: row.id, memory_store_id: store.id }, {});
    }
    const vaultIds = array(row.vault_ids, "session vaults");
    for (const id of vaultIds) if (!vaults.has(ownerKey(workspace, id))) throw new Error(`Session ${row.id}: missing vault ${id}`);
    const value: Session = { id: row.id, agent: { ...snapshot, multiagent: snapshot.multiagent ? { type: "coordinator", agents: snapshot.multiagent.agents.map((member) => {
      if (member.type === "advisor") return member;
      const target = agents.get(ownerKey(workspace, member.agentId));
      if (!target || target.version !== member.version) throw new Error(`Session ${row.id}: callable agent snapshot is unavailable`);
      return { ...target, type: "agent" as const };
    }) } : null }, environmentId: row.environment_id, environmentSnapshot: pinnedEnvironment,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at ?? row.created_at), archivedAt: row.archived_at == null ? null : iso(row.archived_at),
      title: row.title ?? null, status: row.status, metadata: metadata(row.metadata), budget: null, resources, vaultIds, stats: {}, usage: {}, outcomeEvaluations: [],
      deploymentId: row.metadata ? object(row.metadata, "session metadata").deployment_id ?? null : null };
    sessions.set(row.id, { workspace, value });
    emit("managed_sessions", { workspace_id: workspace, id: row.id }, { ...document(value), revision: 1, agent_id: value.agent.id,
      agent_version: value.agent.version, environment_id: value.environmentId, deployment_id: value.deploymentId ?? null, status: value.status });
  }
  let retainedOrphanEvents = 0;
  if (unpinnedEnvironments) warnings.push(`${unpinnedEnvironments} sessions predate stored environment configurations; pinning their current environment configuration. No historical configuration exists to reconstruct.`);
  for (const [sessionId, session] of sessions) {
    const eventRows = source.session_events.filter((row) => row.session_id === sessionId).sort((a, b) => Number(a.seq) - Number(b.seq));
    const ids = new Map<string, string>();
    const eventId = (row: Legacy) => `sevt_v0_${sha(sessionId).slice(0, 16)}_${String(row.seq).padStart(12, "0")}`;
    for (const row of eventRows) {
      const raw = object(row.data, "session event");
      // v0 thinking_id/message_id were stream-local counters and could repeat
      // on every turn. Only persisted raw IDs identify correlation targets.
      for (const original of [raw.id].filter(Boolean)) {
        if (ids.has(original) && ids.get(original) !== eventId(row)) throw new Error(`Session ${sessionId}: ambiguous event identifier`);
        ids.set(original, eventId(row));
      }
    }
    const decoder = new RuntimeEventStreamDecoder(new Set());
    let previousTime = 0;
    for (const row of eventRows) {
      if (Number(row.ts) < previousTime) throw new Error(`Session ${sessionId}: timestamps run backwards; an explicit ordering migration is required`);
      previousTime = Number(row.ts);
      if (row.cancelled_at != null) throw new Error(`Session ${sessionId}: cancelled events require an explicit migration mapping`);
      const raw = object(row.data, `Session ${sessionId} event ${row.seq}`);
      const projected: Legacy = { ...raw, id: eventId(row), processed_at: iso(row.ts) };
      if (typeof raw.content === "string") projected.content = [{ type: "text", text: raw.content }];
      if (raw.type === "session.error" && raw.error?.type === "harness_error") projected.error = { ...raw.error, type: "unknown_error" };
      delete projected.message_id;
      delete projected.thinking_id;
      for (const field of ["tool_use_id", "mcp_tool_use_id", "custom_tool_use_id", "model_request_start_id", "outcome_evaluation_start_id", "parent_event_id"]) {
        if (raw[field] && ids.has(raw[field])) projected[field] = ids.get(raw[field]);
      }
      // Primary-thread attribution was an implementation detail of v0.
      if (row.session_thread_id && row.session_thread_id !== "sthr_primary") throw new Error(`Session ${sessionId}: secondary thread history requires migration`);
      const decoded = decoder.decode(projected)[0] as SessionEventView | undefined;
      if (!decoded) throw new Error(`Session ${sessionId}: unsupported stored event ${raw.type}`);
      if ("input" in raw) (decoded as Legacy).input = structuredClone(raw.input);
      if (raw.providerOptions) (decoded as Legacy).providerOptions = structuredClone(raw.providerOptions);
      let response: object;
      try { response = toSessionEventResponse(decoded); }
      catch { throw new Error(`Session ${sessionId} event ${row.seq} (${raw.type}) cannot be serialized by v1`); }
      const result = sessionStreamEventResponseSchema.safeParse(response);
      if (!result.success) throw new Error(`Session ${sessionId} event ${row.seq} (${raw.type}) violates v1: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      emit("managed_session_events", { workspace_id: session.workspace, session_id: sessionId, id: eventId(row) }, {
        type: decoded.type, document: JSON.stringify(decoded), processed_at: row.ts, thread_id: null,
      });
    }
  }
  retainedOrphanEvents = source.session_events.filter((row) => !sessions.has(row.session_id)).length;
  if (retainedOrphanEvents) warnings.push(`${retainedOrphanEvents} events already have no Session row. They remain intact in the original event log; no workspace ownership is invented.`);
  const schedulePlanner = new CronDeploymentSchedulePlanner();
  for (const row of source.deployments) {
    const owner = row.tenant_id;
    const bound = agents.get(ownerKey(owner, row.agent_id));
    if (!bound || !environments.has(ownerKey(owner, row.environment_id))) throw new Error(`Deployment ${row.id}: missing agent or environment`);
    let schedule = null;
    if (row.trigger_type === "schedule") {
      const planned = await schedulePlanner.plan({ expression: row.cron, timezone: "UTC", after: createdAt });
      if (planned.type !== "planned") throw new Error(`Deployment ${row.id}: invalid schedule`);
      schedule = { ...planned.schedule, lastRunAt: row.last_run_at == null ? null : iso(row.last_run_at),
        ...(row.next_run_at != null && Number(row.next_run_at) > milliseconds(createdAt, "migration time") && { upcomingRunsAt: [iso(row.next_run_at)] }) };
      warnings.push(`Deployment ${row.id}: resume at the next future cron slot; do not replay missed runs during maintenance.`);
    } else if (row.trigger_type !== "manual") throw new Error(`Deployment ${row.id}: unsupported trigger`);
    const vaultIds = array(row.vault_ids, "deployment vaults");
    for (const id of vaultIds) if (!vaults.has(ownerKey(owner, id))) throw new Error(`Deployment ${row.id}: missing vault`);
    const resources = array(row.memory_store_ids, "deployment memory stores").map((id) => {
      if (stores.get(id)?.tenant_id !== owner) throw new Error(`Deployment ${row.id}: missing memory store`);
      return { kind: "memory_store", memoryStoreId: id, access: "read_write" };
    });
    const value = { id: row.id, name: row.name, agent: { id: bound.id, version: bound.version }, environmentId: row.environment_id,
      description: null, metadata: {}, initialEvents: [{ type: "user.message", content: [{ type: "text", text: row.initial_message }] }],
      resources, vaultIds, schedule, status: "active", pausedReason: null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at ?? row.created_at),
      archivedAt: row.archived_at == null ? null : iso(row.archived_at) };
    emit("managed_deployments", { workspace_id: owner, id: row.id }, { ...document(value), revision: 1, agent_id: bound.id, status: "active", sealed_resource_secrets: "[]" });
    const linked = [...sessions.values()].filter((session) => session.workspace === owner && (session.value.deploymentId === row.id || session.value.id === row.last_session_id));
    for (const session of linked) {
      const run = { id: `drun_v0_${sha(`${row.id}:${session.value.id}`).slice(0, 24)}`, deploymentId: row.id,
        agent: { id: session.value.agent.id, version: session.value.agent.version }, sessionId: session.value.id, error: null,
        createdAt: session.value.id === row.last_session_id && row.last_run_at != null ? iso(row.last_run_at) : session.value.createdAt,
        triggerContext: row.trigger_type === "schedule" ? { kind: "schedule", scheduledAt: session.value.createdAt } : { kind: "manual" } };
      emit("managed_deployment_runs", { workspace_id: owner, id: run.id }, { deployment_id: row.id, document: JSON.stringify(run), revision: 1,
        has_error: 0, trigger_type: run.triggerContext.kind, created_at: milliseconds(run.createdAt, "deployment run time") });
    }
  }
  // Native subprocess workspaces are scoped by workspace as well as Session.
  for (const [id, session] of sessions) {
    const directory = `sandboxes/${id}`;
    const walk = async (path: string) => {
      let entries;
      try { entries = (await fs.readdir(safePath(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const sourcePath = `${path}/${entry.name}`;
        const target = `sandboxes/${session.workspace}/${id}/${sourcePath.slice(directory.length + 1)}`;
        if (entry.isDirectory()) await walk(sourcePath);
        else if (entry.isFile()) await inspectFile(sourcePath, target);
        else if (entry.isSymbolicLink()) {
          const link = await fs.readlink(safePath(root, sourcePath));
          files.push({ source: sourcePath, target, symlink: link, sha256: sha(link), size: 0 });
        } else throw new Error(`Unsupported workspace file: ${sourcePath}`);
      }
    };
    await walk(directory);
  }
  const report: MigrationReport = {
    migration: MIGRATION_ID, createdAt,
    sourceSha256: sha(canonical({ tables: source, files: files.map(({ source, sha256, size, symlink }) => ({ source, sha256, size, ...(symlink && { symlink }) })) })),
    destinationSha256: destinationFingerprint(db), keySha256: sha(`migration-key:${options.rootSecret}`), planSha256: "",
    sourceCounts: Object.fromEntries(Object.entries(source).map(([table, values]) => [table, values.length])),
    destinationCounts: rows.reduce<Record<string, number>>((counts, row) => { counts[row.table] = (counts[row.table] ?? 0) + 1; return counts; }, {}),
    fileCount: files.length, fileBytes: files.reduce((total, file) => total + file.size, 0), retainedOrphanEvents, warnings,
  };
  report.planSha256 = sha(canonical({ report, rows, files }));
  return { report, rows, files };
}

async function resolveRepositoryToken(id: string, workspace: string, credentials: Legacy[], rootSecret: string): Promise<string | undefined> {
  const record = credentials.find((row) => row.id === id && row.tenant_id === workspace && row.archived_at == null);
  if (!record) return undefined;
  const raw = record.auth.trim().startsWith("{") ? record.auth : await new WebCryptoAesGcm(rootSecret, "credentials.auth").decrypt(record.auth);
  const auth = object(raw, "repository credential");
  return auth.token ?? auth.access_token;
}
