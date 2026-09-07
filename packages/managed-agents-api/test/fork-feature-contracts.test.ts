import { describe, expect, it } from "vitest";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { environmentCreateBodySchema } from "../src/contracts/environments";
import { sessionEventPageResponseSchema, sessionEventSendBodySchema, sessionStreamEventResponseSchema } from "../src/contracts/session-events";
import { deploymentCreateBodySchema, deploymentUpdateBodySchema } from "../src/contracts/deployments";
import { toCreateEnvironmentCommand } from "../src/mappers/environments";
import { toSendSessionEventsCommand, toSessionEventResponse, toStreamSessionEventResponse } from "../src/mappers/session-events";

describe("fork features in upstream v1 contracts", () => {
  it("accepts environment image, registry reference, context and startup settings through the native contract", () => {
    const input = { name: "Environment", config: { type: "cloud", image: "ghcr.io/team/image:tag",
      image_registry_auth: { vault_id: "vault_1", credential_id: "credential_1" }, context: "Environment facts",
      startup: { script: "echo ready", triggers: ["create", "revive"], timeout_seconds: 45 } } };
    expect(toCreateEnvironmentCommand(environmentCreateBodySchema.parse(input))).toMatchObject({ config: {
      image: "ghcr.io/team/image:tag", imageRegistryAuth: { vaultId: "vault_1", credentialId: "credential_1" },
      context: "Environment facts", startup: { script: "echo ready", triggers: ["create", "revive"], timeoutSeconds: 45 },
    } });
    expect(environmentCreateBodySchema.safeParse({ ...input, config: { ...input.config, startup: { script: "echo ready", timeout_seconds: 601 } } }).success).toBe(false);
  });

  it("preserves startup output through runtime decoding, history and streaming responses", () => {
    const wire = { id: "event_startup", type: "session.sandbox_startup", processed_at: "2026-09-07T09:00:00.000Z",
      boot_id: "boot_1", trigger: "revive", status: "failed", duration_ms: 420, exit_code: 1, stdout: "Preparing", stderr: "Failed" };
    const event = decodeRuntimeProducedSessionEvent(wire);
    expect(event).toMatchObject({ type: "session.sandbox_startup", bootId: "boot_1", durationMs: 420, exitCode: 1 });
    if (!event) throw new Error("startup event was dropped");
    expect(toSessionEventResponse(event)).toEqual(wire);
    expect(sessionEventPageResponseSchema.parse({ data: [toSessionEventResponse(event)], next_page: null }).data).toEqual([wire]);
    expect(sessionStreamEventResponseSchema.parse(toStreamSessionEventResponse(event))).toEqual(wire);
  });

  it("retains an explicit empty per-interaction vault list", () => {
    const body = sessionEventSendBodySchema.parse({ vault_ids: [], events: [{ type: "user.message", content: [{ type: "text", text: "Continue" }] }] });
    expect(toSendSessionEventsCommand("session_1", body)).toMatchObject({ vaultIds: [] });
  });

  it("permits retaining repository credentials on update while requiring credentials for new definitions", () => {
    const resources = [{ type: "github_repository", url: "https://github.com/team/repo" }];
    expect(deploymentUpdateBodySchema.safeParse({ resources }).success).toBe(true);
    expect(deploymentCreateBodySchema.safeParse({ agent: "agent_1", environment_id: "env_1", name: "Deploy",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "Go" }] }], resources }).success).toBe(false);
  });
});
