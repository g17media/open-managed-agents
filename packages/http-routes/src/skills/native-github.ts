import type { SkillsApplicationPort, SkillVersionsApplicationPort } from "@open-managed-agents/managed-agents-application";
import type { GitHubSkillPersistence } from "./github";
import type { SkillMeta } from "./index";

export function nativeGitHubSkillPersistence(skills: SkillsApplicationPort, versions: SkillVersionsApplicationPort): GitHubSkillPersistence {
  return {
    async list() {
      const result: SkillMeta[] = [];
      let cursor: string | undefined;
      do {
        const page = await skills.listSkills({ pageSize: 100, cursor });
        if (page.type !== "page") throw new Error(page.message);
        for (const skill of page.page.skills) {
          if (!skill.latestVersion) continue;
          const version = await versions.retrieveSkillVersion({ skillId: skill.id, version: skill.latestVersion });
          if (version.type !== "found") continue;
          const source = skill.githubSource;
          result.push({ id: skill.id, name: version.version.name, description: version.version.description,
            display_title: skill.displayTitle ?? version.version.name,
            source: skill.source === "anthropic" ? "anthropic" : "custom", latest_version: skill.latestVersion,
            created_at: skill.createdAt, updated_at: skill.updatedAt,
            ...(source && { github_source: { repo: source.repo, ref: source.ref, path: source.path,
              skill_dir: source.skillDir, commit: source.commit, content_hash: source.contentHash, synced_at: source.syncedAt } }),
          });
        }
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      return result;
    },
    async save(input) {
      const files = input.files.map((file) => ({ filename: file.filename, mimeType: "application/octet-stream",
        content: file.encoding === "base64" ? Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)) : new TextEncoder().encode(file.content) }));
      const source = input.provenance;
      const githubSource = { repo: source.repo, ref: source.ref, path: source.path, skillDir: source.skill_dir,
        commit: source.commit, contentHash: source.content_hash, syncedAt: source.synced_at };
      if (input.existing) {
        const result = await versions.createSkillVersion({ skillId: input.existing.id, files, githubSource });
        if (result.type !== "created") throw new Error("message" in result ? result.message : "Skill is unavailable");
        return { id: input.existing.id };
      }
      const result = await skills.createSkill({ files, displayTitle: input.name, githubSource });
      if (result.type !== "created") throw new Error(result.message);
      return { id: result.skill.id };
    },
  };
}
