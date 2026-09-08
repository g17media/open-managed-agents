import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { SqlDeploymentStore } from "@open-managed-agents/deployment-store-sql";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import {
  CredentialsApplicationService, DeploymentsApplicationService, MemoriesApplicationService,
  SkillsApplicationService, SkillVersionsApplicationService,
  type Agent, type Environment, type FilesApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type { Session } from "@open-managed-agents/managed-agents-application";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { CronDeploymentSchedulePlanner, WebCryptoMemoryContentDescriptor, ZipSkillPackageCompiler } from "@open-managed-agents/managed-agents-adapters-runtime";
import { nativeGitHubSkillPersistence, nativeOAuthCredentials } from "@open-managed-agents/http-routes";
import { listManagedVaultCredentials, matchManagedCredential, refreshManagedCredential } from "@open-managed-agents/vault-forward/managed";
import { InMemoryMemoryDocumentStore } from "../../../packages/memory-document-store-memory/src/index";
import { credentialCreateBodySchema, credentialUpdateBodySchema } from "../../../packages/managed-agents-api/src/contracts/credentials";
import { toCreateCredentialCommand, toUpdateCredentialCommand, toCredentialResponse } from "../../../packages/managed-agents-api/src/mappers/credentials";
import { ManagedMemoryFiles } from "../src/lib/managed-memory-files";
import { mountManagedSessionResources, promoteManagedSessionOutputs } from "../src/lib/managed-session-preparation";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";

const workspaceId = "workspace_test";
const timestamp = "2026-09-07T09:00:00.000Z";
const clock = { now: () => new Date(timestamp) };
const vault = { id: "vault_test", displayName: "Secrets", archivedAt: null, createdAt: timestamp, updatedAt: timestamp, metadata: {} };
const memoryStore = { id: "store_test", name: "Notes", archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
const agent: Agent = { id: "agent_test", version: 1, name: "Agent", model: { id: "test" }, system: null,
  description: null, multiagent: null, skills: [], mcpServers: [], tools: [], metadata: {}, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
const environment: Environment = { id: "env_test", name: "Environment", config: { type: "cloud" },
  description: null, metadata: {}, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };

describe("fork features using upstream application and SQL stores", () => {
  let db: TestDb;
  beforeEach(async () => { db = await bootstrapTestDb(); });
  afterEach(() => { db.cleanup(); vi.restoreAllMocks(); });

  function cipher(purpose: string) {
    const crypto = new WebCryptoAesGcm("integration-test-only-secret", purpose);
    return { seal: async ({ plaintext }: { plaintext: string }) => ({ ciphertext: await crypto.encrypt(plaintext) }),
      open: async ({ ciphertext }: { ciphertext: string }) => ({ plaintext: await crypto.decrypt(ciphertext) }) };
  }

  it("round trips registry and handled Git credentials without exposing secrets in API or SQL documents", async () => {
    const store = new SqlCredentialStore(db.sql, cipher("managed.vault.credentials"));
    let id = 0;
    const app = new CredentialsApplicationService({ workspaceId, store, vaults: { find: async () => vault },
      validation: { validate: async () => { throw new Error("unused"); } }, clock, ids: { nextCredentialId: () => `credential_${++id}` } });
    for (const auth of [
      { type: "container_registry", registry: "ghcr.io", username: "april", password: "registry-secret" },
      { type: "static_bearer", mcp_server_url: "https://github.com", handle: "work", token: "git-secret" },
      { type: "cap_cli", cli_id: "git", mcp_server_url: "https://github.com", handle: "second", token: "cli-secret" },
    ]) {
      const wire = credentialCreateBodySchema.parse({ auth });
      const result = await app.createCredential(toCreateCredentialCommand(vault.id, wire));
      expect(result.type).toBe("created");
      if (result.type !== "created") throw new Error("create failed");
      const response = JSON.stringify(toCredentialResponse(result.credential));
      expect(response).not.toMatch(/registry-secret|git-secret|cli-secret/);
    }
    const rows = await db.sql.prepare("SELECT sealed_document FROM managed_credentials").all<{ sealed_document: string }>();
    expect(JSON.stringify(rows.results)).not.toMatch(/registry-secret|git-secret|cli-secret/);
    const credentials = (await listManagedVaultCredentials(store, workspaceId, [vault.id])).map((record) => record.credential);
    expect(matchManagedCredential(credentials, "https://github.com/team/repo.git/info/refs", "work")?.auth)
      .toMatchObject({ token: "git-secret", handle: "work" });
    expect(matchManagedCredential(credentials, "https://github.com/team/repo.git/info/refs", "second")?.auth)
      .toMatchObject({ token: "cli-secret", handle: "second" });
    expect(await listManagedVaultCredentials(store, "another_workspace", [vault.id])).toEqual([]);
    expect(await listManagedVaultCredentials(store, workspaceId, [])).toEqual([]);
    const updated = await app.updateCredential(toUpdateCredentialCommand(vault.id, "credential_2",
      credentialUpdateBodySchema.parse({ auth: { type: "static_bearer", handle: null } })));
    expect(updated.type).toBe("updated");
    const saved = await store.find({ workspaceId, vaultId: vault.id, credentialId: "credential_2" });
    expect(saved?.credential.auth).toEqual({ type: "static_bearer", mcpServerUrl: "https://github.com", token: "git-secret" });
  });

  it("saves OAuth grants into the same encrypted store and retains added scopes during token rotation", async () => {
    const store = new SqlCredentialStore(db.sql, cipher("managed.vault.credentials"));
    const persistence = nativeOAuthCredentials({ workspaceId, store, nextId: () => "credential_oauth",
      vaults: { retrieveVault: async () => ({ type: "found", vault }) } as never });
    await persistence.saveGrant({ vaultId: vault.id, displayName: "MCP", auth: {
      type: "mcp_oauth", mcp_server_url: "https://example.com/mcp", access_token: "old-token", refresh_token: "refresh-secret",
      token_endpoint: "https://example.com/token", client_id: "client", scope: "read write extra",
    } });
    expect(await persistence.authorizationSettings(vault.id, "credential_oauth"))
      .toEqual({ scope: "read write extra", clientId: "client", clientSecret: undefined });
    const current = await store.find({ workspaceId, vaultId: vault.id, credentialId: "credential_oauth" });
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new URLSearchParams(init?.body as URLSearchParams).get("scope")).toBe("read write extra");
      return Response.json({ access_token: "new-token", refresh_token: "rotated-secret" });
    });
    const updated = await refreshManagedCredential(store, workspaceId, current!, request);
    expect(updated.credential.auth).toMatchObject({ accessToken: "new-token", refresh: { refreshToken: "rotated-secret", scope: "read write extra" } });
    const second = await refreshManagedCredential(store, workspaceId, current!, request);
    expect(second.revision).toBe(updated.revision);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("admits a cron slot only once and advances it after a failed launch", async () => {
    const store = new SqlDeploymentStore(db.sql, cipher("managed.deployments.resources"));
    const runs = new SqlDeploymentRunStore(db.sql);
    let runId = 0;
    const launch = vi.fn(async () => ({ type: "rejected" as const, errorType: "unknown_error" as const, message: "runtime unavailable" }));
    const app = new DeploymentsApplicationService({ workspaceId, store, runs, clock,
      agents: { find: async () => agent }, environments: { find: async () => environment },
      files: { find: async () => null }, memoryStores: { find: async () => memoryStore }, vaults: { find: async () => vault },
      schedules: new CronDeploymentSchedulePlanner(), sessions: { launch },
      ids: { nextDeploymentId: () => "deployment_test", nextDeploymentRunId: () => `run_${++runId}` } });
    const created = await app.createDeployment({ agent: { kind: "latest", agentId: agent.id }, environmentId: environment.id,
      name: "Scheduled job", initialEvents: [{ type: "user.message", content: [{ type: "text", text: "Start" }] }] });
    expect(created.type).toBe("created");
    const original = await store.find({ workspaceId, deploymentId: "deployment_test" });
    await store.replace({ workspaceId, deploymentId: "deployment_test", expectedRevision: original!.revision,
      next: { ...original!, deployment: { ...original!.deployment, schedule: { expression: "* * * * *", timezone: "UTC", upcomingRunsAt: [timestamp] } } } });
    const results = await Promise.all([app.runDeployment({ deploymentId: "deployment_test", scheduledAt: timestamp }),
      app.runDeployment({ deploymentId: "deployment_test", scheduledAt: timestamp })]);
    expect(results.filter((result) => result.type === "started")).toHaveLength(1);
    expect(launch).toHaveBeenCalledTimes(1);
    const records = await runs.list({ workspaceId, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]?.run.error).toMatchObject({ message: "runtime unavailable" });
    const saved = await store.find({ workspaceId, deploymentId: "deployment_test" });
    expect(saved?.deployment.schedule?.upcomingRunsAt?.[0]).toBe("2026-09-07T09:01:00.000Z");
    expect((await app.runDeployment({ deploymentId: "deployment_test", scheduledAt: timestamp })).type).toBe("conflict");
  });

  it("imports GitHub packages into native skill versions with binary files and folded descriptions intact", async () => {
    const store = new SqlSkillStore(db.sql);
    let sequence = 0;
    const dependencies = { workspaceId, store, compiler: new ZipSkillPackageCompiler(), clock,
      ids: { nextSkillId: () => "skill_test", nextSkillVersionId: () => `version_${++sequence}`, nextSkillVersion: () => String(++sequence) } };
    const skills = new SkillsApplicationService(dependencies);
    const versions = new SkillVersionsApplicationService(dependencies);
    const persistence = nativeGitHubSkillPersistence(skills, versions);
    const files = [{ filename: "SKILL.md", content: "---\nname: guide\ndescription: >-\n  Read this\n  before editing\n---\nInstructions", encoding: "utf8" as const },
      { filename: "asset.bin", content: "AP+A", encoding: "base64" as const }];
    const source = { repo: "team/repo", commit: "1234567", content_hash: "hash", synced_at: timestamp };
    const created = await persistence.save({ name: "guide", description: "Read this before editing", provenance: source, files });
    const listed = await persistence.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, description: "Read this before editing", github_source: source });
    const firstVersion = listed[0]!.latest_version!;
    const archive = await versions.downloadSkillVersion({ skillId: created.id, version: firstVersion });
    expect(archive.type).toBe("found");
    if (archive.type !== "found") throw new Error("archive missing");
    expect(Array.from(unzipSync(archive.file.content)["guide/asset.bin"]!)).toEqual([0, 255, 128]);
    await persistence.save({ existing: listed[0], name: "guide", description: "Read this before editing", provenance: { ...source, commit: "7654321" },
      files: files.map((file) => file.filename === "SKILL.md" ? { ...file, content: file.content + "\nMore instructions" } : file) });
    expect((await persistence.list())[0]?.latest_version).not.toBe(firstVersion);
    expect((await versions.downloadSkillVersion({ skillId: created.id, version: firstVersion })).type).toBe("found");
  });
});

describe("native session filesystem persistence", () => {
  it("preserves edits to an attached file between turns and after reconnecting to a restored workspace", async () => {
    const writes = new Map<string, Uint8Array>();
    const downloadFile = vi.fn(async () => ({ type: "found", file: { content: new Uint8Array([0, 255, 128]) } }));
    const files = { downloadFile } as unknown as FilesApplicationPort;
    const session = { resources: [{ id: "resource_1", type: "file", fileId: "file_1", mountPath: "/workspace/input.bin" }] } as Session;
    const sandbox = { exec: async () => "", writeFileBytes: async (path: string, bytes: Uint8Array) => { writes.set(path, bytes); } } as unknown as SandboxPort;
    await mountManagedSessionResources({ session, files, sandbox });
    expect(writes.get("/workspace/input.bin")).toEqual(new Uint8Array([0, 255, 128]));
    writes.set("/workspace/input.bin", new Uint8Array([1, 2, 3]));
    await mountManagedSessionResources({ session, files, sandbox });
    const restored = { ...sandbox, exec: async (command: string) => {
      // Old workspaces have the edited file but no .oma-resource-mounts marker.
      return command.includes(".oma-resource-mounts") ? "" : "mounted";
    } } as SandboxPort;
    await mountManagedSessionResources({ session, files, sandbox: restored });
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writes.get("/workspace/input.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("exports memories, versions sandbox writes, and preserves both sides of an API edit conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "oma-native-memory-"));
    try {
      const store = new InMemoryMemoryDocumentStore();
      let id = 0;
      const app = new MemoriesApplicationService({ workspaceId, store, memoryStores: { find: async () => memoryStore },
        content: new WebCryptoMemoryContentDescriptor(), actor: { kind: "session", sessionId: "session_test" }, clock,
        ids: { nextMemoryId: () => `memory_${++id}`, nextMemoryVersionId: () => `memory_version_${++id}` } });
      const created = await app.createMemory({ memoryStoreId: memoryStore.id, path: "/notes.md", content: "initial" });
      if (created.type !== "created") throw new Error("memory create failed");
      const mounts = new ManagedMemoryFiles(root);
      await mounts.prepare(workspaceId, memoryStore.id, app, false);
      const path = join(root, workspaceId, memoryStore.id, "notes.md");
      expect(await readFile(path, "utf8")).toBe("initial");
      await writeFile(path, "agent edit");
      await mounts.flush(workspaceId, memoryStore.id, app);
      expect(await app.retrieveMemory({ memoryStoreId: memoryStore.id, memoryId: created.memory.id, projection: "full" }))
        .toMatchObject({ type: "found", memory: { content: "agent edit" } });
      await app.updateMemory({ memoryStoreId: memoryStore.id, memoryId: created.memory.id, content: "API edit" });
      await writeFile(path, "uncommitted agent edit");
      await expect(mounts.prepare(workspaceId, memoryStore.id, app, false)).rejects.toThrow("preserved");
      expect(await readFile(path, "utf8")).toBe("uncommitted agent edit");
      expect(await app.retrieveMemory({ memoryStoreId: memoryStore.id, memoryId: created.memory.id, projection: "full" }))
        .toMatchObject({ type: "found", memory: { content: "API edit" } });
      const versions = await store.listVersions({ workspaceId, memoryStoreId: memoryStore.id, memoryId: created.memory.id, limit: 10 });
      expect(versions).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("promotes changed outputs even when their byte length is unchanged", async () => {
    const upload = vi.fn(async () => ({ type: "uploaded" as const }));
    const files = { listFiles: async () => ({ type: "page", page: { files: [{ id: "file_old", filename: "result.txt" }], hasMore: false } }),
      downloadFile: async () => ({ type: "found", file: { content: new TextEncoder().encode("old") } }), uploadFile: upload } as unknown as FilesApplicationPort;
    await promoteManagedSessionOutputs({ sessionId: "session_test", files,
      outputs: ["old", "new", "new"].map((text) => ({ filename: "result.txt", mediaType: "text/plain", content: new TextEncoder().encode(text) })) });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ scope: { type: "session", id: "session_test" }, content: new TextEncoder().encode("new") }));
  });
});
