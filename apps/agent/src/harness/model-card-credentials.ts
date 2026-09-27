import type { PiModelConfig } from "./pi-provider";

export interface ResolvedModelCardCredentials {
  model: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  piConfig?: PiModelConfig;
  maxInputTokens?: number;
}

export interface StoredModelCardProviderConfig {
  model: string;
  provider: string;
  base_url: string | null;
  custom_headers: Record<string, string> | null;
  pi_config: Record<string, unknown> | null;
  max_input_tokens?: number | null;
}

/**
 * Replace the complete environment fallback once a stored card is selected.
 * A missing card endpoint means "use Pi's provider catalog", not "inherit
 * ANTHROPIC_BASE_URL". Keeping this projection pure makes that isolation a
 * testable boundary for every platform composition.
 */
export function bindStoredModelCardCredentials(
  fallback: ResolvedModelCardCredentials,
  card: StoredModelCardProviderConfig,
  apiKey: string,
): ResolvedModelCardCredentials {
  return {
    model: card.model,
    ...(modelCardMaxInputTokens(card) !== undefined ? { maxInputTokens: modelCardMaxInputTokens(card) } : {}),
    apiKey,
    baseURL: card.base_url ?? undefined,
    provider: card.provider,
    customHeaders: card.custom_headers ?? undefined,
    piConfig: (card.pi_config as PiModelConfig | null) ?? undefined,
  };
}

/** /v1/models exposes Pi contextWindow as max_input_tokens. Stored cards
 * use pi_config; accept explicit max_input_tokens from catalog adapters too.
 */
export function modelCardMaxInputTokens(card: { max_input_tokens?: number | null; pi_config: Record<string, unknown> | null }): number | undefined {
  const limit = card.max_input_tokens ?? card.pi_config?.contextWindow;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}
