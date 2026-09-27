import { modelCardMaxInputTokens } from "@open-managed-agents/agent/harness/model-card-credentials";
import {
  createPiModelRuntime, modelThinkingLevel, toAiSdkLanguageModel,
  type PiModelConfig,
} from "@open-managed-agents/agent/harness/pi-provider";
import type { WebSearchFilters } from "@open-managed-agents/agent/harness/web-search";
import type { ModelCardService } from "@open-managed-agents/model-cards-store";

/** Node's shared production composition for primary and auxiliary models. */
export function createNodeModelBuilder(
  modelCardsService: Pick<ModelCardService, "findByModelId" | "getApiKey">,
  env: Record<string, string | undefined>,
) {
  /** Resolve agent.model (a model_id handle) → wire model + credentials.
   *  Prefer a matching model card; fall back to ANTHROPIC_* env vars. */
  async function resolveNodeModelCreds(
    tenantId: string,
    agentModel: import("@open-managed-agents/shared").AgentConfig["model"],
  ): Promise<{
    wireModel: string;
    apiKey: string;
    baseURL?: string;
    provider?: string;
    customHeaders?: Record<string, string>;
    piConfig?: PiModelConfig;
    maxInputTokens?: number;
  }> {
    const handle = typeof agentModel === "string" ? agentModel : agentModel.id;
    try {
      const card = await modelCardsService.findByModelId({ tenantId, modelId: handle });
      if (card && !card.archived_at) {
        const key = await modelCardsService.getApiKey({ tenantId, cardId: card.id });
        if (key) {
          return {
            wireModel: card.model,
            maxInputTokens: modelCardMaxInputTokens(card),
            apiKey: key,
            baseURL: card.base_url ?? undefined,
            provider: card.provider,
            customHeaders: card.custom_headers ?? undefined,
            piConfig: card.pi_config
              ? card.pi_config as PiModelConfig
              : undefined,
          };
        }
      }
    } catch (err) {
      console.warn(
        `[model-card] lookup failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No model card matched and ANTHROPIC_API_KEY is unset — configure a model card or set the env var",
      );
    }
    return {
      wireModel: handle,
      apiKey,
      baseURL: env.ANTHROPIC_BASE_URL,
      customHeaders: parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    };
  }

  async function buildNodeLanguageModel(
    tenantId: string,
    agentModel: import("@open-managed-agents/shared").AgentConfig["model"],
    webSearch?: { filters: WebSearchFilters },
  ) {
    const creds = await resolveNodeModelCreds(tenantId, agentModel);
    const configuredProviderOptions =
      typeof agentModel === "string"
        ? undefined
        : agentModel.providerOptions ?? agentModel.provider_options;
    const piProviderOptions = configuredProviderOptions?.pi;
    return toAiSdkLanguageModel(createPiModelRuntime({
      model: creds.wireModel,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      maxInputTokens: creds.maxInputTokens,
      providerOptions:
        piProviderOptions &&
        typeof piProviderOptions === "object" &&
        !Array.isArray(piProviderOptions)
          ? piProviderOptions as Record<string, unknown>
          : undefined,
      thinkingLevel: modelThinkingLevel(agentModel),
      speed: typeof agentModel === "string"
        ? undefined
        : agentModel.speed === "fast" ? "fast" : "standard",
      webSearch,
    }));
  }

  return { resolveNodeModelCreds, buildNodeLanguageModel };
}

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
