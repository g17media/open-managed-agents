import { describe, expect, it, vi } from "vitest";
import type {
  AgentsApplicationPort,
  AgentView,
  SkillsApplicationPort,
} from "../src";
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
  currentAgent?: AgentView | null;
} = {}) {
  const createAgent = vi.fn<AgentsApplicationPort["createAgent"]>(async () => ({
    type: "created" as const,
    agent: agentView,
  }));
  const updateAgent = vi.fn<AgentsApplicationPort["updateAgent"]>(async () => ({
    type: "updated" as const,
    agent: agentView,
  }));
  const retrieveAgent = vi.fn<AgentsApplicationPort["retrieveAgent"]>(async () => {
    const current = overrides.currentAgent === undefined
      ? agentView
      : overrides.currentAgent;
    return current === null
      ? { type: "not_found" as const }
      : { type: "found" as const, agent: current };
  });
  const retrieveSkill = vi.fn<SkillsApplicationPort["retrieveSkill"]>(async () =>
    overrides.skill === null
      ? { type: "not_found" as const }
      : { type: "found" as const, skill: overrides.skill ?? skillView });
  return {
    createAgent,
    retrieveAgent,
    retrieveSkill,
    updateAgent,
    app: buildAgentsTestApi(makeAgentsPort({
      createAgent,
      retrieveAgent,
      updateAgent,
    }), {
      skills: makeSkillsPort({
        retrieveSkill,
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

  it("allows an unchanged binding to a subsequently deleted Skill on update", async () => {
    const missingBinding = {
      type: "custom" as const,
      skillId: "skill_deleted",
      version: "latest",
    };
    const fixture = api({
      skill: null,
      currentAgent: { ...agentView, skills: [missingBinding] },
    });
    const response = await fixture.app.request(`/v1/agents/${agentView.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Renamed agent",
        skills: [{
          type: "custom",
          skill_id: missingBinding.skillId,
          version: "latest",
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(fixture.retrieveSkill).not.toHaveBeenCalled();
    expect(fixture.updateAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "Renamed agent",
      skills: [missingBinding],
    }));
  });

  it("rejects a newly added binding to a missing Skill on update", async () => {
    const fixture = api({ skill: null });
    const response = await fixture.app.request(`/v1/agents/${agentView.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        skills: [{ type: "custom", skill_id: "skill_missing" }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Custom skill skill_missing was not found" },
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
