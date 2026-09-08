import type { FileService } from "@open-managed-agents/files-store";
import type { RouteServices } from "@open-managed-agents/http-routes";
import { generateFileId, fileR2Key, skillFileR2Key } from "@open-managed-agents/shared";
import { listAll as kvListAll } from "@open-managed-agents/kv-store";
import { resolveSessionMemoryBindings, type SessionRegistryDeps } from "../registry.js";
import type { nodeOutputsAdapter } from "./node-outputs-adapter.js";

type NodeSessionPreparationDeps = Pick<SessionRegistryDeps, "sql" | "sessionsService" | "memoryService"> & {
  getKv(): RouteServices["kv"];
  filesBlob: NonNullable<RouteServices["filesBlob"]>;
  filesService: FileService;
  environmentsService: NonNullable<RouteServices["environments"]>;
  sessionOutputs: ReturnType<typeof nodeOutputsAdapter>;
  logger: NonNullable<RouteServices["logger"]>;
};

/** Resource and prompt additions for the existing Node SessionRegistry. */
export function createNodeSessionPreparation(deps: NodeSessionPreparationDeps) {
  const { sql, sessionsService, memoryService, getKv, filesBlob, filesService,
    environmentsService, sessionOutputs, logger } = deps;

  // Shell single-quote escape for values interpolated into sandbox exec
  // commands (repo URLs, mount paths, branch names). Wrapping in single
  // quotes and escaping embedded quotes is the standard POSIX-safe form.
  function qsh(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  // ── Skill resolution (Node) ──────────────────────────────────────────────
  // The Node runtime resolves agent.skills the way the CF SessionDO does:
  // inline each skill's SKILL.md into the system prompt and mount its files
  // into the sandbox. Skills live as tenant skills in KV (t:<tenant>:skill:<id>
  // metadata + :skillver:<id>:<ver> manifest; bytes in the blob store, keyed by
  // skillFileR2Key). Anthropic-hosted skills (pdf/docx/xlsx/pptx) are imported
  // into the deployment via POST /v1/skills, where they get id skill_<random>
  // and keep their frontmatter name — so an agent ref like
  // {type:"anthropic", skill_id:"pdf"} is matched to the imported skill by NAME
  // (id won't match) and the ref's `type` is ignored.
  interface NodeSkillMeta {
    id: string;
    name?: string;
    display_title?: string;
    description?: string;
    latest_version?: string;
  }
  interface ResolvedNodeSkill {
    name: string;
    addition: string;
    files: Array<{ filename: string; bytes: Uint8Array }>;
  }

  async function resolveNodeSkills(
    tenantId: string,
    skillRefs: Array<{ skill_id: string; type?: string; version?: string }>,
  ): Promise<ResolvedNodeSkill[]> {
    if (!skillRefs.length || !filesBlob) return [];
    const kv = getKv();

    // Index the tenant's skills by id and by name so a ref matches either.
    const byId = new Map<string, NodeSkillMeta>();
    const byName = new Map<string, NodeSkillMeta>();
    const listed = await kvListAll(kv, `t:${tenantId}:skill:`);
    for (const k of listed) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw) as NodeSkillMeta;
        if (m.id) byId.set(m.id, m);
        if (m.name) byName.set(m.name, m);
      } catch {
        /* skip unparseable skill metadata */
      }
    }

    const resolved: ResolvedNodeSkill[] = [];
    const seen = new Set<string>();
    for (const ref of skillRefs) {
      const meta = byId.get(ref.skill_id) ?? byName.get(ref.skill_id);
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      const version =
        ref.version && ref.version !== "latest" ? ref.version : meta.latest_version;
      if (!version) continue;
      const verRaw = await kv.get(`t:${tenantId}:skillver:${meta.id}:${version}`);
      if (!verRaw) continue;
      let fileList: Array<{ filename: string }> = [];
      try {
        fileList = ((JSON.parse(verRaw) as { files?: Array<{ filename: string }> }).files ?? []);
      } catch {
        /* skip skills with an unparseable manifest */
      }
      const files: Array<{ filename: string; bytes: Uint8Array }> = [];
      let skillMd = "";
      for (const f of fileList) {
        const obj = await filesBlob.get(skillFileR2Key(tenantId, meta.id, version, f.filename));
        if (!obj) continue;
        const bytes = await obj.bytes();
        files.push({ filename: f.filename, bytes });
        if (f.filename === "SKILL.md") skillMd = new TextDecoder().decode(bytes);
      }
      const name = meta.name || meta.display_title || ref.skill_id;
      // Inline the full SKILL.md (AMA-aligned: the model sees the instructions
      // up front). Fall back to a metadata line if SKILL.md is missing.
      const addition = skillMd
        ? `<skill name="${name}">\n${skillMd}\n</skill>`
        : `[Skill: ${name}]${meta.description ? " " + meta.description : ""}`;
      resolved.push({ name, addition, files });
    }
    return resolved;
  }

  async function mountNodeSessionResources({ sessionId, tenantId, sandbox, strict = false }: {
    sessionId: string; tenantId: string;
    sandbox: import("@open-managed-agents/sandbox").SandboxExecutor;
    strict?: boolean;
  }): Promise<void> {
      if (!filesBlob) return;
      const rows = await sessionsService.listResourcesBySession({ sessionId });
      for (const row of rows) {
        try {
          if (row.type === "file" && row.resource.file_id) {
            const fileId = row.resource.file_id;
            const meta = await filesService.get({ tenantId, fileId });
            if (!meta) { if (strict) throw new Error(`File ${fileId} is unavailable`); continue; }
            const obj = await filesBlob.get(meta.r2_key);
            if (!obj) { if (strict) throw new Error(`File ${fileId} content is unavailable`); continue; }
            const bytes = await obj.bytes();
            // Default mount path matches the Anthropic Managed Agents
            // convention the ff-agents bot relies on (/workspace/<name>).
            const path = row.resource.mount_path || `/workspace/${meta.filename}`;
            const slash = path.lastIndexOf("/");
            const dir = slash > 0 ? path.slice(0, slash) : "";
            // belljar's write endpoint does not create parent dirs; ensure
            // the target directory exists first (no-op for /workspace).
            if (dir) await sandbox.exec(`mkdir -p ${qsh(dir)}`, 5000).catch(() => undefined);
            if (sandbox.writeFileBytes) await sandbox.writeFileBytes(path, bytes);
            else await sandbox.writeFile(path, new TextDecoder().decode(bytes));
          } else if (row.type === "github_repository" || row.type === "github_repo") {
            const repoUrl = row.resource.url || row.resource.repo_url;
            if (!repoUrl) continue;
            // Clone into a subdir when mount_path is unset or the bare
            // /workspace (belljar seeds /workspace with the vault CA, so git
            // clone into it would fail "directory not empty").
            const repoName = (repoUrl.split("/").pop() || "repo").replace(/\.git$/, "") || "repo";
            const mp = row.resource.mount_path;
            const targetDir = mp && mp !== "/workspace" ? mp : `/workspace/${repoName}`;
            const parentDir = targetDir.slice(0, Math.max(0, targetDir.lastIndexOf("/"))) || "/";
            // Idempotency: this hook runs every turn — skip once cloned.
            const present = await sandbox
              .exec(`test -d ${qsh(`${targetDir}/.git`)} && echo present || echo absent`, 5000)
              .catch(() => "absent");
            if (present.includes("present")) continue;
            // Under BELLJAR_ISOLATION the sandbox's only egress is the
            // oma-vault proxy: exec already carries HTTPS_PROXY, but git needs
            // the vault CA (it ignores NODE_EXTRA_CA_CERTS) or TLS verification
            // fails. The native sandbox.gitCheckout endpoint is NOT usable here
            // — it runs git without the proxy env, so github.com won't resolve.
            // Configuring the CA is a no-op on a non-isolated sandbox (the env
            // var is unset), so this one path covers belljar + subprocess.
            const clone = [
              `CA="$NODE_EXTRA_CA_CERTS"`,
              `if [ -n "$CA" ] && [ -f "$CA" ]; then git config --global http.sslCAInfo "$CA"; fi`,
              // Fail fast instead of hanging on an auth prompt when the proxy
              // can't satisfy a private repo (public repos need no auth).
              `git config --global core.askpass /bin/true`,
              `git config --global credential.helper "" 2>/dev/null || true`,
              `mkdir -p ${qsh(parentDir)}`,
              `git clone ${qsh(repoUrl)} ${qsh(targetDir)}`,
              `cd ${qsh(targetDir)} && git config user.name Agent && git config user.email "agent@managed-agents.dev"`,
            ].join("; ");
            await sandbox.exec(clone, 180000);
            // Optional branch/commit checkout (mirrors the CF resource-mounter):
            // DWIM a remote branch, else create it locally off the default HEAD.
            const checkout = row.resource.checkout;
            if (checkout?.type === "branch" && checkout.name) {
              const branch = checkout.name.replace(/[^A-Za-z0-9._/-]/g, "");
              if (branch) {
                await sandbox.exec(
                  `cd ${qsh(targetDir)} && (git fetch origin ${qsh(branch)}:refs/remotes/origin/${qsh(branch)} 2>/dev/null && git checkout ${qsh(branch)}) || git checkout -b ${qsh(branch)}`,
                  60000,
                );
              }
            } else if (checkout?.type === "commit" && checkout.sha) {
              const sha = checkout.sha.replace(/[^A-Za-z0-9]/g, "");
              if (sha) await sandbox.exec(`cd ${qsh(targetDir)} && git checkout ${qsh(sha)}`, 60000);
            }
            // Verify the clone actually landed; log if not (belljar surfaces
            // clone failures as a thrown exec error caught below, but a
            // partial/edge failure should still be visible).
            const ok = await sandbox
              .exec(`test -d ${qsh(`${targetDir}/.git`)} && echo present || echo absent`, 5000)
              .catch(() => "absent");
            if (!ok.includes("present")) {
              if (strict) throw new Error(`Repository checkout failed: ${repoUrl}`);
              logger.warn(
                { op: "node.mount_git_repo", session_id: sessionId, resource_id: row.resource.id, target_dir: targetDir },
                "github_repository clone did not produce a checkout",
              );
            }
          }
        } catch (err) {
          if (strict) throw err;
          logger.warn(
            { op: "node.mount_session_resource", session_id: sessionId, resource_id: row.resource.id, resource_type: row.type, err },
            "session resource mount failed",
          );
        }
      }
  }

  const promoteSessionOutputs: NonNullable<SessionRegistryDeps["promoteSessionOutputs"]> = async ({ sessionId, tenantId }) => {
    if (!filesBlob) return;
    const listed = await sessionOutputs.list(tenantId, sessionId);
    if (listed.length === 0) return;
    const existing = await filesService.list({ tenantId, sessionId, limit: 1000 });
    const seen = new Set(existing.map((r) => `${r.filename}:${r.size_bytes}`));
    for (const out of listed) {
      const key = `${out.filename}:${out.size_bytes}`;
      if (seen.has(key)) continue;
      try {
        const obj = await sessionOutputs.read(tenantId, sessionId, out.filename);
        if (!obj) continue;
        const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
        const id = generateFileId();
        const r2Key = fileR2Key(tenantId, id);
        await filesBlob.put(r2Key, bytes, { httpMetadata: { contentType: out.media_type } });
        await filesService.create({
          id,
          tenantId,
          sessionId,
          filename: out.filename,
          mediaType: out.media_type,
          sizeBytes: bytes.byteLength,
          r2Key,
          downloadable: true,
        });
        seen.add(key);
      } catch (err) {
        logger.warn(
          { op: "node.promote_output", session_id: sessionId, filename: out.filename, err },
          "session output promote failed",
        );
      }
    }
  };

  async function reminders(input: Parameters<SessionRegistryDeps["buildHarnessContext"]>[0]) {
    // Memory-store mount descriptors → system prompt, mirroring the CF
    // SessionDO's platformReminders block format. Resolved per turn from
    // the same binding union the mounter uses, so stores attached
    // mid-session are announced on the next turn.
    const memoryReminders: Array<{ source: string; text: string }> = [];
    try {
      const bindings = await resolveSessionMemoryBindings(
        { sql, sessionsService, memoryService },
        input.sessionId,
        input.tenantId,
      );
      for (const b of bindings) {
        const accessLabel = b.readOnly ? "read-only" : "read-write";
        const lines = [
          `## Memory store: ${b.storeName}`,
          `Mounted at /mnt/memory/${b.storeName}/ (${accessLabel})`,
        ];
        if (b.description) lines.push(b.description);
        if (b.instructions) lines.push(b.instructions);
        if (b.readOnly) {
          lines.push("(read-only mount — write attempts to this directory will fail)");
        }
        memoryReminders.push({ source: `memory:${b.storeId}`, text: lines.join("\n") });
      }
    } catch (err) {
      logger.warn(
        { err, op: "main-node.memory_reminders_failed", session_id: input.sessionId },
        "memory store metadata fetch failed; prompt omits mount descriptors",
      );
    }
    // belljar recycles idle sandbox containers but keeps /workspace on a
    // volume for a retention window (server defaults: destroy after ~1h
    // idle, retain ~7 days), transparently reattaching it on the next
    // request. Tell the agent what that means for where to put files.
    if ((process.env.SANDBOX_PROVIDER ?? "").toLowerCase() === "belljar") {
      memoryReminders.push({
        source: "sandbox:workspace",
        text: [
          "## Workspace: /workspace",
          "Semi-persistent scratch space. The sandbox container is recycled after roughly an hour",
          "of inactivity, but /workspace survives recycling and comes back on the next request for",
          "about 7 days of inactivity — after that it is deleted and the session starts with a fresh,",
          "empty workspace. Use /workspace for checkouts, build artifacts and working files; keep",
          "anything that must outlive it in /mnt/memory or /mnt/session/outputs.",
        ].join("\n"),
      });
    }
    // Environment-level custom context (environments.config.context) —
    // injected for every agent running a session in this environment.
    try {
      const sessionRow = await sessionsService.getById({ sessionId: input.sessionId });
      const envId = sessionRow?.environment_id;
      if (envId) {
        const envRow = await environmentsService.get({
          tenantId: input.tenantId,
          environmentId: envId,
        });
        const envContext = envRow?.config?.context;
        if (typeof envContext === "string" && envContext.trim()) {
          memoryReminders.push({ source: `environment:${envId}`, text: envContext });
        }
      }
    } catch (err) {
      logger.warn(
        { err, op: "main-node.environment_context_failed", session_id: input.sessionId },
        "environment context fetch failed; prompt omits it",
      );
    }

    // Resolve agent.skills → inline SKILL.md into the system prompt and mount
    // each skill's files into the sandbox (progressive disclosure). The Node
    // runtime did neither before, so declared skills were inert. Best-effort:
    // a failure here must not break the turn — the agent just loses the skill.
    if (input.agent.skills?.length) {
      try {
        const skills = await resolveNodeSkills(input.tenantId, input.agent.skills);
        for (const skill of skills) {
          if (skill.addition) {
            memoryReminders.push({ source: `skill:${skill.name}`, text: skill.addition });
          }
          if (!skill.files.length) continue;
          // Mount once per session: writing every skill file on every turn
          // would be dozens of round-trips per turn. The .skills dir under the
          // agent's home matches the CF SessionDO's mount location.
          const skillDir = `/home/user/.skills/${skill.name}`;
          const present = await input.sandbox
            .exec(`test -d ${qsh(skillDir)} && echo present || echo absent`, 5000)
            .catch(() => "absent");
          if (present.includes("present")) continue;
          for (const f of skill.files) {
            const dest = `${skillDir}/${f.filename}`;
            const slash = dest.lastIndexOf("/");
            const dir = slash > 0 ? dest.slice(0, slash) : "";
            try {
              if (dir) await input.sandbox.exec(`mkdir -p ${qsh(dir)}`, 5000).catch(() => undefined);
              if (input.sandbox.writeFileBytes) await input.sandbox.writeFileBytes(dest, f.bytes);
              else await input.sandbox.writeFile(dest, new TextDecoder().decode(f.bytes));
            } catch (err) {
              logger.warn(
                { err, op: "main-node.skill_file_mount", session_id: input.sessionId, file: dest },
                "skill file mount failed; skipping",
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          { err, op: "main-node.skills_failed", session_id: input.sessionId },
          "skill resolution failed; prompt omits skills",
        );
      }
    }

    return memoryReminders;
  }

  return { mountSessionResources: mountNodeSessionResources, promoteSessionOutputs, reminders };
}
