import type { SkillGitHubSource } from "../domain/skill";
export interface SkillUploadFileInput {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface SkillView {
  githubSource?: SkillGitHubSource;
  id: string;
  createdAt: string;
  displayTitle: string | null;
  latestVersion: string | null;
  source: string;
  updatedAt: string;
}

export interface CreateSkillCommand {
  githubSource?: SkillGitHubSource;
  files: SkillUploadFileInput[];
  displayTitle?: string | null;
}

export interface RetrieveSkillQuery {
  skillId: string;
}

export interface ListSkillsQuery {
  pageSize?: number;
  cursor?: string;
  source?: string | null;
}

export interface SkillsPage {
  skills: SkillView[];
  nextCursor: string | null;
}

export interface DeleteSkillCommand {
  skillId: string;
}

export interface UpdateSkillCommand {
  skillId: string;
  displayTitle: string | null;
}

export type CreateSkillResult =
  | { type: "created"; skill: SkillView }
  | { type: "invalid_request"; message: string };

export type RetrieveSkillResult =
  | { type: "found"; skill: SkillView }
  | { type: "not_found" };

export type ListSkillsResult =
  | { type: "page"; page: SkillsPage }
  | { type: "invalid_request"; message: string };

export type DeleteSkillResult =
  | { type: "deleted"; skillId: string }
  | { type: "not_found" };

export type UpdateSkillResult =
  | { type: "updated"; skill: SkillView }
  | { type: "not_found" }
  | { type: "version_conflict"; message: string };

export interface SkillsApplicationPort {
  createSkill(command: CreateSkillCommand): Promise<CreateSkillResult>;
  retrieveSkill(query: RetrieveSkillQuery): Promise<RetrieveSkillResult>;
  listSkills(query: ListSkillsQuery): Promise<ListSkillsResult>;
  updateSkill(command: UpdateSkillCommand): Promise<UpdateSkillResult>;
  deleteSkill(command: DeleteSkillCommand): Promise<DeleteSkillResult>;
}
