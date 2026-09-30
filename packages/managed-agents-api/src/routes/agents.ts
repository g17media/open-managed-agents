import { Hono, type Context } from "hono";
import type { BetaManagedAgentsSkillParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import {
  resolveApplicationPort,
  type ApplicationPortResolver,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import {
  agentCreateBodySchema,
  agentListQuerySchema,
  agentPageResponseSchema,
  agentResponseSchema,
  agentRetrieveQuerySchema,
  agentUpdateBodySchema,
  agentVersionListQuerySchema,
} from "../contracts/agents";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toAgentResponse,
  toCreateAgentCommand,
  toListAgentsQuery,
  toListAgentVersionsQuery,
  toUpdateAgentCommand,
} from "../mappers/agents";
import type {
  AgentView,
  AgentsApplicationPort,
  ListAgentsPage,
  SkillsApplicationPort,
  SkillVersionsApplicationPort,
} from "../ports";

export type AgentsApplicationPortResolver =
  ApplicationPortResolver<AgentsApplicationPort>;

export type AgentsApplicationPortSource =
  ApplicationPortSource<AgentsApplicationPort>;

export interface AgentSkillBindingSources {
  skills: ApplicationPortSource<Pick<SkillsApplicationPort, "retrieveSkill">>;
  skillVersions: ApplicationPortSource<Pick<SkillVersionsApplicationPort, "retrieveSkillVersion">>;
}

type SkillBindingInput = BetaManagedAgentsSkillParams;

function bindingKey(binding: SkillBindingInput): string {
  return JSON.stringify([
    binding.type,
    binding.skill_id,
    binding.version ?? "latest",
  ]);
}

function changedCustomBindings(
  requested: ReadonlyArray<SkillBindingInput>,
  current: AgentView["skills"],
): SkillBindingInput[] {
  const remaining = new Map<string, number>();
  for (const binding of current) {
    const key = bindingKey({
      skill_id: binding.skillId,
      type: binding.type,
      version: binding.version,
    });
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return requested.filter((binding) => {
    if (binding.type !== "custom") return false;
    const key = bindingKey(binding);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

async function invalidCustomSkillBinding(
  context: Context,
  bindings: ReadonlyArray<SkillBindingInput> | null | undefined,
  sources: AgentSkillBindingSources | undefined,
): Promise<string | null> {
  if (sources === undefined || bindings == null) return null;
  const skills = resolveApplicationPort(sources.skills, context);
  const versions = resolveApplicationPort(sources.skillVersions, context);
  for (const binding of bindings) {
    if (binding.type !== "custom") continue;
    const found = await skills.retrieveSkill({ skillId: binding.skill_id });
    if (found.type === "not_found") {
      return `Custom skill ${binding.skill_id} was not found`;
    }
    const version = binding.version === undefined
        || binding.version === null
        || binding.version === "latest"
      ? found.skill.latestVersion
      : binding.version;
    if (version === null) {
      return `Custom skill ${binding.skill_id} has no latest version`;
    }
    const foundVersion = await versions.retrieveSkillVersion({
      skillId: binding.skill_id,
      version,
    });
    if (foundVersion.type === "not_found") {
      return `Custom skill ${binding.skill_id} version ${version} was not found`;
    }
  }
  return null;
}

function serializeAgent(agent: AgentView): object | null {
  try {
    const parsed = agentResponseSchema.safeParse(toAgentResponse(agent));
    return parsed.success ? (parsed.data as object) : null;
  } catch {
    return null;
  }
}

function serializeAgentPage(page: ListAgentsPage): object | null {
  try {
    const parsed = agentPageResponseSchema.safeParse({
      data: page.agents.map(toAgentResponse),
      next_page: page.nextCursor,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildAgentRoutes(
  source: AgentsApplicationPortSource,
  skillBindings?: AgentSkillBindingSources,
): Hono {
  const app = new Hono();

  app.use("*", requireBeta(MANAGED_AGENTS_BETA));
  app.get("/", async (c) => {
    const query = agentListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      "created_at[gte]": c.req.query("created_at[gte]"),
      "created_at[lte]": c.req.query("created_at[lte]"),
      include_archived: c.req.query("include_archived"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).listAgents(
      toListAgentsQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const page = serializeAgentPage(result.page);
    if (page === null) {
      return c.json(apiError("Application returned an invalid agent page"), 500);
    }

    return c.json(page, 200);
  });

  app.get("/:agentId", async (c) => {
    const query = agentRetrieveQuerySchema.safeParse({
      version: c.req.query("version"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).retrieveAgent({
      agentId: c.req.param("agentId"),
      ...query.data,
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.get("/:agentId/versions", async (c) => {
    const query = agentVersionListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const result = await resolveApplicationPort(source, c).listAgentVersions(
      toListAgentVersionsQuery(c.req.param("agentId"), query.data),
    );
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const page = serializeAgentPage(result.page);
    if (page === null) {
      return c.json(apiError("Application returned an invalid agent page"), 500);
    }

    return c.json(page, 200);
  });

  app.post("/:agentId/archive", async (c) => {
    const result = await resolveApplicationPort(source, c).archiveAgent({
      agentId: c.req.param("agentId"),
    });
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.post("/:agentId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = agentUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const agents = resolveApplicationPort(source, c);
    let bindingsToValidate = parsed.data.skills;
    let comparisonVersion: number | undefined;
    if (bindingsToValidate?.some((binding) => binding.type === "custom")) {
      const current = await agents.retrieveAgent({
        agentId: c.req.param("agentId"),
      });
      if (current.type === "not_found") {
        return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
      }
      comparisonVersion = current.agent.version;
      bindingsToValidate = changedCustomBindings(
        bindingsToValidate,
        current.agent.skills,
      );
    }
    const invalidSkill = await invalidCustomSkillBinding(
      c,
      bindingsToValidate,
      skillBindings,
    );
    if (invalidSkill !== null) {
      return c.json(invalidRequest(invalidSkill), 400);
    }

    const command = toUpdateAgentCommand(c.req.param("agentId"), parsed.data);
    if (comparisonVersion !== undefined && command.expectedVersion === undefined) {
      command.expectedVersion = comparisonVersion;
    }
    const result = await agents.updateAgent(command);
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(notFound(`Agent ${c.req.param("agentId")} was not found`), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 200);
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }

    const parsed = agentCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }

    const invalidSkill = await invalidCustomSkillBinding(
      c,
      parsed.data.skills,
      skillBindings,
    );
    if (invalidSkill !== null) {
      return c.json(invalidRequest(invalidSkill), 400);
    }

    const result = await resolveApplicationPort(source, c).createAgent(
      toCreateAgentCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }

    const agent = serializeAgent(result.agent);
    if (agent === null) {
      return c.json(apiError("Application returned an invalid agent resource"), 500);
    }

    return c.json(agent, 201);
  });

  return app;
}
