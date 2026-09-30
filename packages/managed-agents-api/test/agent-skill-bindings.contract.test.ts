import { describe, expect, it, vi } from "vitest";
import type { AgentsApplicationPort } from "../src";
import { buildAgentsTestApi } from "./test-api";
import { agentView, makeAgentsPort } from "./fixtures";
import {
  makeSkillsPort,
  makeSkillVersionsPort,
  skillVersionView,
  skillView,
} from "./skill-fixtures";

const headers = {
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

function api(overrides: {
  skill?: typeof skillView | null;
  versionFound?: boolean;
} = {}) {
  const createAgent = vi.fn<AgentsApplicationPort["createAgent"]>(async () => ({
    type: "created" as const,
    agent: agentView,
  }));
  const updateAgent = vi.fn<AgentsApplicationPort["updateAgent"]>(async () => ({
    type: "updated" as const,
    agent: agentView,
  }));
  return {
    createAgent,
    updateAgent,
    app: buildAgentsTestApi(makeAgentsPort({ createAgent, updateAgent }), {
      skills: makeSkillsPort({
        retrieveSkill: async () => overrides.skill === null
          ? { type: "not_found" as const }
          : { type: "found" as const, skill: overrides.skill ?? skillView },
      }),
      skillVersions: makeSkillVersionsPort({
        retrieveSkillVersion: async () => overrides.versionFound === false
          ? { type: "not_found" as const }
          : { type: "found" as const, version: skillVersionView },
      }),
    }),
  };
}

describe("Managed Agent custom Skill binding validation", () => {
  it("accepts omitted/latest versions after resolving the current version", async () => {
    const fixture = api();
    const response = await fixture.app.request("/v1/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Coder",
        model: "claude-opus-5",
        skills: [{ type: "custom", skill_id: skillView.id }],
      }),
    });

    expect(response.status).toBe(201);
    expect(fixture.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      skills: [{ type: "custom", skillId: skillView.id }],
    }));
  });

  it("rejects a missing custom Skill before creating the Agent", async () => {
    const fixture = api({ skill: null });
    const response = await fixture.app.request("/v1/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Coder",
        model: "claude-opus-5",
        skills: [{ type: "custom", skill_id: "skill_missing" }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Custom skill skill_missing was not found" },
    });
    expect(fixture.createAgent).not.toHaveBeenCalled();
  });

  it("rejects a missing concrete version before updating the Agent", async () => {
    const fixture = api({ versionFound: false });
    const response = await fixture.app.request(`/v1/agents/${agentView.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        skills: [{ type: "custom", skill_id: skillView.id, version: "404" }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: `Custom skill ${skillView.id} version 404 was not found` },
    });
    expect(fixture.updateAgent).not.toHaveBeenCalled();
  });

  it("does not require pre-built bindings to exist in custom Skill storage", async () => {
    const fixture = api({ skill: null, versionFound: false });
    const response = await fixture.app.request("/v1/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Document agent",
        model: "claude-opus-5",
        skills: [{ type: "anthropic", skill_id: "pdf" }],
      }),
    });

    expect(response.status).toBe(201);
    expect(fixture.createAgent).toHaveBeenCalledOnce();
  });
});
