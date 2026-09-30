import type { Skill, SkillVersion } from "@open-managed-agents/domain/skills";
import type { SkillStore } from "@open-managed-agents/skill-store";
import type {
  CreateSkillCommand,
  CreateSkillResult,
  DeleteSkillCommand,
  DeleteSkillResult,
  ListSkillsQuery,
  ListSkillsResult,
  RetrieveSkillQuery,
  RetrieveSkillResult,
  SkillsApplicationPort,
  UpdateSkillCommand,
  UpdateSkillResult,
} from "../ports/skills";
import type { SkillPackageCompilerPort } from "./package-compiler";

export interface SkillsApplicationServiceDependencies {
  workspaceId: string;
  store: SkillStore;
  compiler: SkillPackageCompilerPort;
  clock: { now(): Date };
  ids: {
    nextSkillId(): string;
    nextSkillVersionId(): string;
    nextSkillVersion(): string;
  };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeSkillCursor(skill: Skill): string {
  return `skills.${encodeCursorPart(skill.createdAt)}.${encodeCursorPart(skill.id)}`;
}

function decodeSkillCursor(
  value: string,
): { createdAt: string; skillId: string } | null {
  const [scope, createdAtPart, skillIdPart, extra] = value.split(".");
  if (
    scope !== "skills" ||
    createdAtPart === undefined ||
    skillIdPart === undefined ||
    extra !== undefined
  ) return null;
  const createdAt = decodeCursorPart(createdAtPart);
  const skillId = decodeCursorPart(skillIdPart);
  if (
    createdAt === null ||
    skillId === null ||
    skillId.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) return null;
  return { createdAt, skillId };
}

export class SkillsApplicationService implements SkillsApplicationPort {
  constructor(
    private readonly dependencies: SkillsApplicationServiceDependencies,
  ) {}

  async createSkill(command: CreateSkillCommand): Promise<CreateSkillResult> {
    const compiled = await this.dependencies.compiler.compile({
      files: command.files.map((file) => ({ ...file })),
    });
    if (compiled.type === "invalid_request") return compiled;

    const timestamp = this.dependencies.clock.now().toISOString();
    const skillId = this.dependencies.ids.nextSkillId();
    const versionValue = this.dependencies.ids.nextSkillVersion();
    const skill: Skill = {
      ...(command.githubSource !== undefined && { githubSource: structuredClone(command.githubSource) }),
      id: skillId,
      createdAt: timestamp,
      displayTitle: command.displayTitle?.trim() || compiled.package.name,
      latestVersion: versionValue,
      source: "custom",
      updatedAt: timestamp,
    };
    const version: SkillVersion = {
      id: this.dependencies.ids.nextSkillVersionId(),
      createdAt: timestamp,
      description: compiled.package.description,
      directory: compiled.package.directory,
      name: compiled.package.name,
      skillId,
      version: versionValue,
    };
    const inserted = await this.dependencies.store.insertWithInitialVersion({
      workspaceId: this.dependencies.workspaceId,
      skill,
      version,
      archive: compiled.package.archive,
    });
    return { type: "created", skill: inserted.skill.skill };
  }

  async retrieveSkill(
    query: RetrieveSkillQuery,
  ): Promise<RetrieveSkillResult> {
    const record = await this.dependencies.store.findSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: query.skillId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", skill: await this.withDisplayTitle(record.skill) };
  }

  async listSkills(query: ListSkillsQuery): Promise<ListSkillsResult> {
    const position =
      query.cursor === undefined ? undefined : decodeSkillCursor(query.cursor);
    if (position === null) {
      return { type: "invalid_request", message: "Invalid skill page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.listSkills({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      ...(query.source !== undefined && query.source !== null && {
        source: query.source,
      }),
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const visible = records.slice(0, pageSize);
    const last = visible.at(-1);
    return {
      type: "page",
      page: {
        skills: await Promise.all(visible.map((record) =>
          this.withDisplayTitle(record.skill))),
        nextCursor:
          hasMore && last !== undefined ? encodeSkillCursor(last.skill) : null,
      },
    };
  }

  async updateSkill(command: UpdateSkillCommand): Promise<UpdateSkillResult> {
    const current = await this.dependencies.store.findSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
    });
    if (current === null) return { type: "not_found" };
    const next = {
      ...current.skill,
      displayTitle: command.displayTitle,
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    const result = await this.dependencies.store.replaceSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
      expectedSkillRevision: current.revision,
      nextSkill: next,
    });
    if (result.type === "not_found") return result;
    if (result.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Skill changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return {
      type: "updated",
      skill: await this.withDisplayTitle(result.skill.skill),
    };
  }

  async deleteSkill(command: DeleteSkillCommand): Promise<DeleteSkillResult> {
    const result = await this.dependencies.store.deleteSkill({
      workspaceId: this.dependencies.workspaceId,
      skillId: command.skillId,
    });
    return result.type === "not_found"
      ? result
      : { type: "deleted", skillId: command.skillId };
  }

  private async withDisplayTitle(skill: Skill): Promise<Skill> {
    if (skill.displayTitle?.trim()) return skill;
    const version = skill.latestVersion === null
      ? null
      : await this.dependencies.store.findVersion({
          workspaceId: this.dependencies.workspaceId,
          skillId: skill.id,
          version: skill.latestVersion,
        });
    return {
      ...skill,
      displayTitle: version?.version.name || skill.id,
    };
  }
}
