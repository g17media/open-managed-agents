// DeploymentService — stored launch recipes (packages/deployments-store).
// Uses the in-memory repo + manual clock so cron next-run math is
// deterministic.

import { describe, it, expect } from "vitest";
import {
  DeploymentAgentMissingError,
  DeploymentInvalidInputError,
  DeploymentNotFoundError,
  nextRunFromCron,
} from "@open-managed-agents/deployments-store";
import {
  createInMemoryDeploymentService,
  ManualClock,
} from "@open-managed-agents/deployments-store/test-fakes";

const TENANT = "tn_test";
// 2023-11-14T22:13:20.000Z — the fakes' default ManualClock epoch.
const T0 = 1_700_000_000_000;

describe("DeploymentService — create", () => {
  it("creates a manual deployment with defaults", async () => {
    const { service } = createInMemoryDeploymentService();
    const row = await service.create({
      tenantId: TENANT,
      name: "Nightly triage",
      agentId: "agent-1",
      initialMessage: "Triage the inbox.",
      trigger: { type: "manual" },
    });
    expect(row.id).toBe("dpl-0001");
    expect(row.trigger).toEqual({ type: "manual" });
    expect(row.next_run_at).toBeNull();
    expect(row.vault_ids).toEqual([]);
    expect(row.memory_store_ids).toEqual([]);
  });

  it("computes next_run_at from the cron at create", async () => {
    const clock = new ManualClock(T0);
    const { service } = createInMemoryDeploymentService({ clock });
    const row = await service.create({
      tenantId: TENANT,
      name: "Hourly",
      agentId: "agent-1",
      initialMessage: "go",
      trigger: { type: "schedule", cron: "0 * * * *" },
    });
    expect(row.trigger).toEqual({ type: "schedule", cron: "0 * * * *" });
    expect(row.next_run_at).toBe(new Date(nextRunFromCron("0 * * * *", T0)).toISOString());
  });

  it("rejects schedule triggers without a cron and bad cron expressions", async () => {
    const { service } = createInMemoryDeploymentService();
    await expect(
      service.create({
        tenantId: TENANT,
        name: "x",
        agentId: "a",
        initialMessage: "m",
        trigger: { type: "schedule" },
      }),
    ).rejects.toBeInstanceOf(DeploymentInvalidInputError);
    await expect(
      service.create({
        tenantId: TENANT,
        name: "x",
        agentId: "a",
        initialMessage: "m",
        trigger: { type: "schedule", cron: "not a cron" },
      }),
    ).rejects.toBeInstanceOf(DeploymentInvalidInputError);
  });

  it("verifies the agent exists when a checker is wired", async () => {
    const { service } = createInMemoryDeploymentService({
      verifyAgentExists: async (_t, agentId) => agentId === "agent-real",
    });
    await expect(
      service.create({
        tenantId: TENANT,
        name: "x",
        agentId: "agent-ghost",
        initialMessage: "m",
        trigger: { type: "manual" },
      }),
    ).rejects.toBeInstanceOf(DeploymentAgentMissingError);
  });
});

describe("DeploymentService — trigger changes + runs", () => {
  it("switching schedule → manual clears cron + next_run_at", async () => {
    const { service } = createInMemoryDeploymentService();
    const row = await service.create({
      tenantId: TENANT,
      name: "x",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "schedule", cron: "*/5 * * * *" },
    });
    const updated = await service.update({
      tenantId: TENANT,
      deploymentId: row.id,
      trigger: { type: "manual" },
    });
    expect(updated.trigger).toEqual({ type: "manual" });
    expect(updated.next_run_at).toBeNull();
  });

  it("recordRun stamps bookkeeping and advances next_run_at for schedules", async () => {
    const clock = new ManualClock(T0);
    const { service } = createInMemoryDeploymentService({ clock });
    const row = await service.create({
      tenantId: TENANT,
      name: "x",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "schedule", cron: "0 * * * *" },
    });
    const ranAt = T0 + 60_000;
    const after = await service.recordRun({
      tenantId: TENANT,
      deploymentId: row.id,
      sessionId: "sess-run-1",
      ranAtMs: ranAt,
    });
    expect(after.last_session_id).toBe("sess-run-1");
    expect(after.last_run_at).toBe(new Date(ranAt).toISOString());
    expect(after.next_run_at).toBe(new Date(nextRunFromCron("0 * * * *", ranAt)).toISOString());
  });

  it("listDue returns only due, non-archived scheduled deployments", async () => {
    const clock = new ManualClock(T0);
    const { service } = createInMemoryDeploymentService({ clock });
    const due = await service.create({
      tenantId: TENANT,
      name: "due",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "schedule", cron: "* * * * *" },
    });
    await service.create({
      tenantId: TENANT,
      name: "manual",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "manual" },
    });
    const archived = await service.create({
      tenantId: TENANT,
      name: "archived",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "schedule", cron: "* * * * *" },
    });
    await service.archive({ tenantId: TENANT, deploymentId: archived.id });

    clock.set(T0 + 10 * 60_000);
    const dueRows = await service.listDue({});
    expect(dueRows.map((d) => d.id)).toEqual([due.id]);
  });

  it("deferNextRun pushes next_run_at past now without recording a run", async () => {
    const clock = new ManualClock(T0);
    const { service } = createInMemoryDeploymentService({ clock });
    const row = await service.create({
      tenantId: TENANT,
      name: "x",
      agentId: "a",
      initialMessage: "m",
      trigger: { type: "schedule", cron: "* * * * *" },
    });
    clock.set(T0 + 10 * 60_000);
    await service.deferNextRun({ tenantId: TENANT, deploymentId: row.id });
    const after = await service.get({ tenantId: TENANT, deploymentId: row.id });
    expect(after!.last_run_at).toBeNull();
    expect(Date.parse(after!.next_run_at!)).toBeGreaterThan(T0 + 10 * 60_000);
    expect(await service.listDue({})).toEqual([]);
  });

  it("throws DeploymentNotFoundError for unknown ids", async () => {
    const { service } = createInMemoryDeploymentService();
    await expect(
      service.recordRun({ tenantId: TENANT, deploymentId: "missing", sessionId: "s" }),
    ).rejects.toBeInstanceOf(DeploymentNotFoundError);
  });
});
