import { describe, expect, it } from "vitest";
import { bindStoredModelCardCredentials } from "../src/harness/model-card-credentials";
import { createPiModelRuntime, toAiSdkLanguageModel } from "../src/harness/pi-provider";
import { resolveContextWindowTokens } from "../src/harness/default-loop";

describe("bindStoredModelCardCredentials", () => {
  it("carries the card input limit through the shared runtime and SDK adapter", () => {
    const creds = bindStoredModelCardCredentials({ model: "alias", apiKey: "test" }, {
      model: "claude-opus-5-5", provider: "anthropic", base_url: null,
      custom_headers: null, pi_config: null, max_input_tokens: 90_000,
    }, "test");
    const runtime = createPiModelRuntime(creds);
    expect(runtime.model.contextWindow).toBe(90_000);
    expect(resolveContextWindowTokens(toAiSdkLanguageModel(runtime))).toBe(90_000);
  });
  it("uses the stored Pi card budget that /v1/models exposes as max_input_tokens", () => {
    const creds = bindStoredModelCardCredentials({ model: "alias", apiKey: "test" }, {
      model: "claude-opus-5-5", provider: "anthropic", base_url: null,
      custom_headers: null, pi_config: { contextWindow: 70_000 },
    }, "test");
    expect(resolveContextWindowTokens(toAiSdkLanguageModel(createPiModelRuntime(creds)))).toBe(70_000);
  });
  it("does not leak the Anthropic environment endpoint into an official provider card", () => {
    expect(bindStoredModelCardCredentials(
      {
        model: "deepseek-card",
        apiKey: "anthropic-fallback-key",
        baseURL: "https://api.minimaxi.com/anthropic/v1",
      },
      {
        model: "deepseek-v4-flash",
        provider: "deepseek",
        base_url: null,
        custom_headers: null,
        pi_config: null,
      },
      "deepseek-card-key",
    )).toEqual({
      model: "deepseek-v4-flash",
      apiKey: "deepseek-card-key",
      baseURL: undefined,
      provider: "deepseek",
      customHeaders: undefined,
      piConfig: undefined,
    });
  });

  it("preserves an explicit custom provider endpoint", () => {
    expect(bindStoredModelCardCredentials(
      {
        model: "custom-card",
        apiKey: "fallback-key",
        baseURL: "https://fallback.invalid/v1",
      },
      {
        model: "custom-model",
        provider: "my-provider",
        base_url: "https://models.example.test/v1",
        custom_headers: { "x-tenant": "tenant-1" },
        pi_config: { api: "openai-completions" },
      },
      "custom-key",
    )).toMatchObject({
      model: "custom-model",
      apiKey: "custom-key",
      baseURL: "https://models.example.test/v1",
      provider: "my-provider",
      customHeaders: { "x-tenant": "tenant-1" },
      piConfig: { api: "openai-completions" },
    });
  });
});
