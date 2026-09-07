import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import type { Environment, Session, FilesApplicationPort, SkillVersionsApplicationPort } from "@open-managed-agents/managed-agents-application";

const mountedResources = new WeakMap<SandboxPort, Set<string>>();
const mountedSkills = new WeakMap<SandboxPort, Set<string>>();

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function writeBytes(sandbox: SandboxPort, path: string, content: Uint8Array): Promise<void> {
  await sandbox.exec(`mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")) || "/")}`, 5000);
  if (sandbox.writeFileBytes) await sandbox.writeFileBytes(path, content);
  else await sandbox.writeFile(path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(content));
}

export async function mountManagedSessionResources(input: {
  session: Session; sandbox: SandboxPort; files: FilesApplicationPort;
}): Promise<void> {
  let mounted = mountedResources.get(input.sandbox);
  if (!mounted) { mounted = new Set(); mountedResources.set(input.sandbox, mounted); }
  for (const resource of input.session.resources) {
    if (resource.type === "file") {
      if (mounted.has(resource.id)) continue;
      const marker = `/workspace/.oma-resource-mounts/${createHash("sha256").update(resource.id).digest("hex")}`;
      const restored = await input.sandbox.exec(`test -f ${quote(marker)} && test -e ${quote(resource.mountPath)} && echo mounted || true`, 5000);
      if (restored.trim() === "mounted") { mounted.add(resource.id); continue; }
      const file = await input.files.downloadFile({ fileId: resource.fileId });
      if (file.type !== "found") throw new Error(`File ${resource.fileId} is unavailable`);
      await writeBytes(input.sandbox, resource.mountPath, file.file.content);
      await writeBytes(input.sandbox, marker, new TextEncoder().encode(resource.id));
      mounted.add(resource.id);
    } else if (resource.type === "github_repository") {
      const repo = new URL(resource.url);
      if (repo.protocol !== "https:" || repo.username || repo.password) throw new Error("Repository resources require an HTTPS URL without embedded credentials");
      const name = repo.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "") || "repo";
      const path = resource.mountPath === "/workspace" ? `/workspace/${name}` : resource.mountPath;
      const present = await input.sandbox.exec(`test -d ${quote(`${path}/.git`)} && echo present || echo absent`, 5000);
      if (present.trim() === "present") continue;
      // The proxy owns authentication. No token is written into the process environment or git config.
      await input.sandbox.exec([
        "set -e",
        'if [ -n "$NODE_EXTRA_CA_CERTS" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then git config --global http.sslCAInfo "$NODE_EXTRA_CA_CERTS"; fi',
        "git config --global core.askpass /bin/true",
        'git config --global credential.helper ""',
        `mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")) || "/")}`,
        `git clone -- ${quote(resource.url)} ${quote(path)}`,
        `cd ${quote(path)}`,
        "git config user.name Agent",
        "git config user.email agent@managed-agents.dev",
      ].join("; "), 180000);
      if (resource.checkout?.type === "branch") {
        const branch = quote(resource.checkout.name);
        await input.sandbox.exec(`cd ${quote(path)} && git check-ref-format --branch ${branch} >/dev/null && (git checkout ${branch} || git checkout -b ${branch})`, 60000);
      } else if (resource.checkout?.type === "commit") {
        if (!/^[a-fA-F0-9]{7,40}$/.test(resource.checkout.sha)) throw new Error("Invalid repository commit");
        await input.sandbox.exec(`cd ${quote(path)} && git checkout --detach ${quote(resource.checkout.sha)}`, 60000);
      }
    }
  }
}

export async function managedSessionReminders(input: {
  session: Session; environment: Environment; sandbox: SandboxPort; versions: SkillVersionsApplicationPort;
}): Promise<Array<{ source: string; text: string }>> {
  const reminders: Array<{ source: string; text: string }> = [];
  if (input.environment.config.type === "cloud" && input.environment.config.context?.trim()) {
    reminders.push({ source: `environment:${input.environment.id}`, text: input.environment.config.context });
  }
  for (const resource of input.session.resources) {
    if (resource.type !== "memory_store") continue;
    const name = resource.name ?? resource.memoryStoreId;
    reminders.push({ source: `memory:${resource.memoryStoreId}`, text: [
      `## Memory store: ${name}`,
      `Mounted at ${resource.mountPath ?? `/mnt/memory/${name}`} (${resource.access === "read_only" ? "read-only" : "read-write"})`,
      resource.description, resource.instructions,
    ].filter(Boolean).join("\n") });
  }
  let mounted = mountedSkills.get(input.sandbox);
  if (!mounted) { mounted = new Set(); mountedSkills.set(input.sandbox, mounted); }
  for (const binding of input.session.agent.skills) {
    const location = { skillId: binding.skillId, version: binding.version };
    const version = await input.versions.retrieveSkillVersion(location);
    const archive = await input.versions.downloadSkillVersion(location);
    if (version.type !== "found" || archive.type !== "found") throw new Error(`Skill ${binding.skillId}@${binding.version} is unavailable`);
    const entries = unzipSync(archive.file.content);
    const root = `${version.version.directory}/`;
    const destination = `/home/user/.skills/${version.version.name}`;
    const manifest = entries[`${root}SKILL.md`];
    if (!manifest) throw new Error(`Skill ${binding.skillId} is missing SKILL.md`);
    const bindingKey = `${binding.skillId}@${binding.version}`;
    if (!mounted.has(bindingKey)) {
      const installed = await input.sandbox.exec(`cat ${quote(`${destination}/.oma-version`)} 2>/dev/null || true`, 5000);
      if (installed.trim() === bindingKey) mounted.add(bindingKey);
    }
    if (!mounted.has(bindingKey)) for (const [path, bytes] of Object.entries(entries)) {
      if (path.endsWith("/")) continue;
      if (!path.startsWith(root) || path.split("/").some((segment) => segment === ".." || segment === ".") || path.includes("\\")) throw new Error("Invalid skill archive path");
      await writeBytes(input.sandbox, `${destination}/${path.slice(root.length)}`, bytes);
    }
    if (!mounted.has(bindingKey)) await writeBytes(input.sandbox, `${destination}/.oma-version`, new TextEncoder().encode(bindingKey));
    mounted.add(bindingKey);
    reminders.push({ source: `skill:${binding.skillId}`, text: `## Skill: ${version.version.name}\nFiles: ${destination}/\n\n${new TextDecoder().decode(manifest)}` });
  }
  return reminders;
}

export async function promoteManagedSessionOutputs(input: {
  sessionId: string; files: FilesApplicationPort;
  outputs: Array<{ filename: string; mediaType: string; content: Uint8Array }>;
}): Promise<void> {
  if (!input.outputs.length) return;
  const fingerprints = new Set<string>();
  const digest = (filename: string, bytes: Uint8Array) => `${filename}:${createHash("sha256").update(bytes).digest("hex")}`;
  let afterId: string | undefined;
  do {
    const page = await input.files.listFiles({ scopeId: input.sessionId, pageSize: 100, afterId });
    if (page.type !== "page") throw new Error(page.message);
    for (const metadata of page.page.files) {
      const file = await input.files.downloadFile({ fileId: metadata.id });
      if (file.type === "found") fingerprints.add(digest(metadata.filename, file.file.content));
    }
    afterId = page.page.hasMore ? page.page.lastId ?? undefined : undefined;
  } while (afterId);
  for (const output of input.outputs) {
    const fingerprint = digest(output.filename, output.content);
    if (fingerprints.has(fingerprint)) continue;
    const result = await input.files.uploadFile({ ...output, mimeType: output.mediaType, scope: { type: "session", id: input.sessionId } });
    if (result.type !== "uploaded") throw new Error(result.message);
    fingerprints.add(fingerprint);
  }
}
