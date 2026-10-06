import { describe, expect, it } from "vitest";
import { apiKeyHeaderFor } from "../src/api-key-header";

const providers = [
  ["generativelanguage.googleapis.com", "x-goog-api-key"],
  ["api.anthropic.com", "x-api-key"],
  ["api.elevenlabs.io", "xi-api-key"],
] as const;
const staticBearer = { apiKeyCapable: true };

describe.each(providers)("API-key header for %s", (host, header) => {
  const url = `https://${host}/v1/test`;

  it("selects the provider's header for a static_bearer credential", () => {
    expect(apiKeyHeaderFor(url, { [header]: "placeholder" }, staticBearer)).toBe(header);
  });

  it("keeps Bearer when the request did not send the provider's header", () => {
    expect(apiKeyHeaderFor(url, {}, staticBearer)).toBeUndefined();
    expect(apiKeyHeaderFor(url, { [header]: undefined }, staticBearer)).toBeUndefined();
  });

  it("cannot select a different provider's header", () => {
    const others = Object.fromEntries(providers.filter(([, name]) => name !== header).map(([, name]) => [name, "placeholder"]));
    expect(apiKeyHeaderFor(url, others, staticBearer)).toBeUndefined();
  });

  it.each([false, undefined])("keeps non-static_bearer credentials in Authorization (apiKeyCapable=%s)", (apiKeyCapable) => {
    expect(apiKeyHeaderFor(url, { [header]: "placeholder" }, { apiKeyCapable })).toBeUndefined();
  });
});

describe("API-key header boundaries", () => {
  it.each(["example.com", "api.elevenlabs.io.example.com", "sub.api.elevenlabs.io"])("keeps Bearer for an unmapped host (%s)", (host) => {
    const headers = Object.fromEntries(providers.map(([, name]) => [name, "placeholder"]));
    expect(apiKeyHeaderFor(`https://${host}/v1/test`, headers, staticBearer)).toBeUndefined();
  });

  it("ignores an invalid URL", () => {
    expect(apiKeyHeaderFor("not a URL", { "xi-api-key": "placeholder" }, staticBearer)).toBeUndefined();
  });

  it.each([{ value: "" }, { value: ["proxy"] }])("uses header presence without trusting its value (%j)", ({ value }) => {
    expect(apiKeyHeaderFor("https://api.elevenlabs.io/v1/test", { "xi-api-key": value }, staticBearer)).toBe("xi-api-key");
  });
});
