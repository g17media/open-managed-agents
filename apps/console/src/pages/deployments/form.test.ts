import { describe, expect, it } from "vitest";
import type { BetaManagedAgentsDeployment as Deployment } from "@anthropic-ai/sdk/resources/beta/deployments";
import { deploymentInitialMessage, deploymentMemoryResources, updateDeploymentMessage } from "./form";

describe("deployment editing", () => {
  const deployment = {
    initial_events: [
      { type: "user.message", content: [{ type: "text", text: "First message" }, { type: "text", text: "Extra context" }] },
      { type: "system.message", content: [{ type: "text", text: "System context" }] },
      { type: "user.define_outcome", description: "Finish", rubric: { type: "inline", content: [] } },
    ],
    resources: [
      { type: "github_repository", url: "https://github.com/team/repo", checkout: { type: "branch", name: "work" } },
      { type: "file", file_id: "file_01", mount_path: "/workspace/input.txt" },
      { type: "memory_store", memory_store_id: "mem_01", access: "read_only", instructions: "Read first" },
    ],
  } as Deployment;

  it("changes only the editable text block", () => {
    expect(deploymentInitialMessage(deployment)).toBe("First message");
    const next = updateDeploymentMessage(deployment, "Revised message");
    expect(next).toEqual([
      { type: "user.message", content: [{ type: "text", text: "Revised message" }, { type: "text", text: "Extra context" }] },
      ...deployment.initial_events.slice(1),
    ]);
    expect(deploymentInitialMessage(deployment)).toBe("First message");
  });

  it("retains file and repository attachments and existing memory permissions", () => {
    expect(deploymentMemoryResources(deployment, ["mem_01", "mem_02"])).toEqual([
      ...deployment.resources,
      { type: "memory_store", memory_store_id: "mem_02", access: "read_write" },
    ]);
  });
});
