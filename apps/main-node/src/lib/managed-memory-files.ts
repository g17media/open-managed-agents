import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoriesApplicationPort, MemoryView } from "@open-managed-agents/managed-agents-application";

type Index = Record<string, { id: string; sha: string }>;
const sha = (content: string) => createHash("sha256").update(content).digest("hex");

/** Connect the sandbox's filesystem mounts to native memory records and version history. */
export class ManagedMemoryFiles {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  private paths(workspaceId: string, storeId: string) {
    if (![workspaceId, storeId].every((value) => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error("Invalid memory mount identity");
    return { directory: join(this.root, workspaceId, storeId), index: join(this.root, workspaceId, ".indexes", `${storeId}.json`) };
  }

  private serialize(key: string, task: () => Promise<void>): Promise<void> {
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.pending.set(key, next);
    void next.finally(() => { if (this.pending.get(key) === next) this.pending.delete(key); }).catch(() => {});
    return next;
  }

  private async readIndex(path: string): Promise<Index> {
    try { return JSON.parse(await fs.readFile(path, "utf8")) as Index; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  private async saveIndex(path: string, index: Index) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(`${path}.tmp`, JSON.stringify(index), { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
  }

  private async readFiles(directory: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const walk = async (prefix: string) => {
      let entries;
      try { entries = await fs.readdir(join(directory, prefix), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error("Memory stores may not contain symbolic links");
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(join(directory, path));
          files.set(`/${path}`, new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
        }
      }
    };
    await walk("");
    return files;
  }

  private async flushFiles(storeId: string, files: Map<string, string>, index: Index, memories: MemoriesApplicationPort) {
    for (const [path, previous] of Object.entries(index)) {
      const content = files.get(path);
      if (content !== undefined && sha(content) === previous.sha) continue;
      const result = content === undefined
        ? await memories.deleteMemory({ memoryStoreId: storeId, memoryId: previous.id, expectedContentSha256: previous.sha })
        : await memories.updateMemory({ memoryStoreId: storeId, memoryId: previous.id, content, contentPrecondition: { expectedSha256: previous.sha } });
      if (result.type === "deleted" || (result.type === "not_found" && content === undefined)) delete index[path];
      else if (result.type === "updated") index[path] = { id: result.memory.id, sha: result.memory.contentSha256 };
      else throw new Error(`Memory ${path} changed concurrently; the sandbox file has been preserved`);
    }
    for (const [path, content] of files) {
      if (index[path]) continue;
      const result = await memories.createMemory({ memoryStoreId: storeId, path, content });
      if (result.type === "created") index[path] = { id: result.memory.id, sha: result.memory.contentSha256 };
      else if (result.type === "path_conflict" && result.conflict.conflictingMemoryId) {
        const existing = await memories.retrieveMemory({ memoryStoreId: storeId, memoryId: result.conflict.conflictingMemoryId, projection: "full" });
        if (existing.type !== "found" || existing.memory.contentSha256 !== sha(content)) throw new Error(`Memory ${path} changed concurrently; the sandbox file has been preserved`);
        index[path] = { id: existing.memory.id, sha: existing.memory.contentSha256 };
      } else throw new Error(`Could not persist memory ${path}: ${result.type}`);
    }
  }

  flush(workspaceId: string, storeId: string, memories: MemoriesApplicationPort): Promise<void> {
    const paths = this.paths(workspaceId, storeId);
    return this.serialize(paths.directory, async () => {
      const index = await this.readIndex(paths.index);
      try { await this.flushFiles(storeId, await this.readFiles(paths.directory), index, memories); }
      finally { await this.saveIndex(paths.index, index); }
    });
  }

  prepare(workspaceId: string, storeId: string, memories: MemoriesApplicationPort, readOnly: boolean): Promise<void> {
    const paths = this.paths(workspaceId, storeId);
    return this.serialize(paths.directory, async () => {
      const index = await this.readIndex(paths.index);
      const files = await this.readFiles(paths.directory);
      if (!readOnly) {
        try { await this.flushFiles(storeId, files, index, memories); }
        finally { await this.saveIndex(paths.index, index); }
      }
      const current: MemoryView[] = [];
      let cursor: string | undefined;
      do {
        const page = await memories.listMemories({ memoryStoreId: storeId, pageSize: 100, cursor, depth: 0, projection: "full" });
        if (page.type !== "page") throw new Error(`Memory store ${storeId} is unavailable`);
        current.push(...page.page.items.filter((item): item is MemoryView => item.kind === "memory"));
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      const next: Index = {};
      for (const memory of current) {
        const content = memory.content ?? "";
        const local = files.get(memory.path);
        if (local !== undefined && local !== content && (!index[memory.path] || sha(local) !== index[memory.path]!.sha)) {
          throw new Error(`Memory ${memory.path} has uncommitted filesystem changes; its file has been preserved`);
        }
        if (local !== content) {
          const relative = memory.path.replace(/^\/+/, "");
          if (!relative || relative.split("/").includes("..") || relative.includes("\\")) throw new Error("Invalid memory file path");
          const path = join(paths.directory, relative);
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(path, content);
        }
        next[memory.path] = { id: memory.id, sha: memory.contentSha256 };
      }
      for (const path of Object.keys(index)) {
        if (!next[path] && files.has(path) && sha(files.get(path)!) === index[path]!.sha) await fs.unlink(join(paths.directory, path.replace(/^\/+/, "")));
      }
      await this.saveIndex(paths.index, next);
    });
  }
}
