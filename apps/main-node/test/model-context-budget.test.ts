import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createNodeModelBuilder } from "../src/lib/node-model-builder";
import { createInMemoryModelCardService } from "@open-managed-agents/model-cards-store/test-fakes";
import { ModelCardCatalogSource } from "@open-managed-agents/managed-agents-adapters-runtime";
import { ModelsApplicationService } from "@open-managed-agents/managed-agents-application";
import { buildModelRoutes } from "@open-managed-agents/managed-agents-api";
import { resolveContextWindowTokens } from "@open-managed-agents/agent/harness/default-loop";
import { eventsToMessages } from "@open-managed-agents/agent/runtime/history";
import { decodeRuntimeProducedSessionEvent, encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionEvent } from "@open-managed-agents/shared";

describe("Node model card context budget", () => {
  it.each([
    { wireModel: "claude-opus-5-5", budget: 48_000 },
    { wireModel: "claude-opus-5-5", budget: 300_000 },
    { wireModel: "claude-sonnet-4-6", budget: 48_000 },
  ])("uses the same stored $budget limit in GET /v1/models and Node model composition ($wireModel)", async ({ wireModel, budget }) => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "tenant", modelId: "card-handle", model: wireModel,
      provider: "anthropic", apiKey: "fake-test-key", piConfig: { contextWindow: budget },
    });
    const app = new Hono().route("/v1/models", buildModelRoutes(new ModelsApplicationService({
      workspaceId: "tenant", catalog: new ModelCardCatalogSource(service),
    })));
    const response = await app.request("/v1/models");
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ max_input_tokens: number }> };
    expect(body.data[0]?.max_input_tokens).toBe(budget);

    const { buildNodeLanguageModel } = createNodeModelBuilder(service, {});
    const model = await buildNodeLanguageModel("tenant", "card-handle");
    expect(model.modelId).toBe(wireModel);
    expect(resolveContextWindowTokens(model)).toBe(body.data[0]?.max_input_tokens);
    expect(model.maxInputTokens).toBe(budget);
  });

  it("clamps a stored budget to the known provider ceiling in both catalog and Node runtime", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "tenant", modelId: "card-handle", model: "claude-sonnet-4-6",
      provider: "anthropic", apiKey: "fake-test-key", piConfig: { contextWindow: 10_000_000 },
    });
    const catalog = await new ModelCardCatalogSource(service).find({ workspaceId: "tenant", modelId: "card-handle" });
    const model = await createNodeModelBuilder(service, {}).buildNodeLanguageModel("tenant", "card-handle");
    expect(catalog!.maxInputTokens).toBeLessThan(10_000_000);
    expect(resolveContextWindowTokens(model)).toBe(catalog!.maxInputTokens);
  });

  it("uses the conservative runtime fallback for an unknown card without limits", async () => {
    const { service } = createInMemoryModelCardService();
    await service.create({
      tenantId: "tenant", modelId: "card-handle", model: "claude-opus-5-5",
      provider: "anthropic", apiKey: "fake-test-key",
    });
    const model = await createNodeModelBuilder(service, {}).buildNodeLanguageModel("tenant", "card-handle");
    expect(resolveContextWindowTokens(model)).toBe(128_000);
  });

  it("keeps tail budgets and elisions after the Node event codec round trip", () => {
    const prefix: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "old".repeat(5_000) }] },
      { type: "agent.tool_use", id: "read", name: "read", input: {} },
      { type: "agent.tool_result", tool_use_id: "read", content: "r".repeat(5_000) },
      { type: "user.message", content: [{ type: "text", text: "continue" }] },
    ];
    const boundary: SessionEvent = {
      id: "boundary", processed_at: "2026-09-27T00:00:00.000Z",
      type: "agent.thread_context_compacted", original_message_count: 4, compacted_message_count: 2,
      summary: [{ type: "text", text: "summary" }],
      metadata: { preserved_tail: { minTokens: 0, maxTokens: 1_000, minMessages: 1 } },
    };
    const roundTrip = encodeRuntimeHistoryEvent(decodeRuntimeProducedSessionEvent(boundary)!) as SessionEvent;
    expect(eventsToMessages([...prefix, roundTrip]).length).toBe(eventsToMessages([...prefix, boundary]).length);
    const elision: SessionEvent = {
      ...boundary, id: "elision", summary: undefined,
      metadata: { kind: "tool_result_elision", tool_result_elisions: [{ tool_call_id: "read", chars: 5_000 }] },
    };
    const replayed = encodeRuntimeHistoryEvent(decodeRuntimeProducedSessionEvent(elision)!) as SessionEvent;
    expect(JSON.stringify(eventsToMessages([...prefix, replayed]))).toContain("[tool result elided during compaction: 5000 chars; re-run the tool if needed]");
  });
});
