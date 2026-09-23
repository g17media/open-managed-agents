// Unit tests for the web_search backend module: provider selection order,
// agent filter extraction, native server-tool shapes, and each keyed
// backend's request/response mapping against a fake fetch.
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import {
  createWebSearchExecutor,
  filterResultsByDomain,
  hostMatchesDomainList,
  keyedWebSearchFallback,
  nativeWebSearchServerTool,
  readWebSearchFilters,
  resolveWebSearchProvider,
  webSearchEnvFrom,
  webSearchToolTypeOverride,
} from "../src/harness/web-search";

function agent(tools: AgentConfig["tools"] = [{ type: "agent_toolset_20260401" }]): AgentConfig {
  return {
    id: "agent_test",
    name: "t",
    model: "claude-sonnet-5",
    system: "",
    tools,
    version: 1,
    created_at: new Date().toISOString(),
  } as AgentConfig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("webSearchEnvFrom", () => {
  it("keeps only the web search keys and drops blanks", () => {
    expect(webSearchEnvFrom({
      WEB_SEARCH_PROVIDER: " brave ",
      BRAVE_SEARCH_API_KEY: "b",
      TAVILY_API_KEY: "",
      ANTHROPIC_API_KEY: "should-not-leak",
    })).toEqual({ WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "b" });
    expect(webSearchEnvFrom(undefined)).toEqual({});
  });
});

describe("resolveWebSearchProvider", () => {
  it("defaults to DuckDuckGo with nothing configured", () => {
    expect(resolveWebSearchProvider({}, agent())).toEqual({ provider: "ddg", source: "default" });
  });

  it("auto-selects the first keyed provider in tavily > brave > exa > serper order", () => {
    expect(resolveWebSearchProvider({ SERPER_API_KEY: "s", EXA_API_KEY: "e" }, agent()))
      .toEqual({ provider: "exa", source: "key" });
    expect(keyedWebSearchFallback({ SERPER_API_KEY: "s", BRAVE_SEARCH_API_KEY: "b" })).toBe("brave");
    expect(keyedWebSearchFallback({})).toBe("ddg");
  });

  it("WEB_SEARCH_PROVIDER beats key detection; an unknown value is ignored with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "native", TAVILY_API_KEY: "t" }, agent()))
        .toEqual({ provider: "native", source: "env" });
      expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "bing", TAVILY_API_KEY: "t" }, agent()))
        .toEqual({ provider: "tavily", source: "key" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WEB_SEARCH_PROVIDER="bing"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("a legacy web_search_<provider> tool type on the agent beats everything", () => {
    const withTavily = agent([{ type: "agent_toolset_20260401" }, { type: "web_search_tavily" } as never]);
    expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "brave" }, withTavily))
      .toEqual({ provider: "tavily", source: "agent" });
    expect(webSearchToolTypeOverride(agent([{ type: "web_search_20250305" } as never]))).toBe("native");
    expect(webSearchToolTypeOverride(agent([{ type: "web_search_bing" } as never]))).toBeUndefined();
  });
});

describe("readWebSearchFilters", () => {
  it("reads allow/block lists and user location from the web_search config entry", () => {
    const cfg = agent([{
      type: "agent_toolset_20260401",
      configs: [
        { name: "web_search", enabled: true, allowed_domains: ["Docs.Example.com/", "arxiv.org"], user_location: { type: "approximate", country: "GB" } } as never,
      ],
    }]);
    expect(readWebSearchFilters(cfg)).toEqual({
      allowedDomains: ["docs.example.com", "arxiv.org"],
      userLocation: { type: "approximate", country: "GB" },
    });
    expect(readWebSearchFilters(agent())).toEqual({});
  });
});

describe("nativeWebSearchServerTool", () => {
  it("picks the 2026 Anthropic tool on current Claude models and the 2025 one on older ones", () => {
    expect(nativeWebSearchServerTool({ api: "anthropic-messages", providerId: "anthropic", modelId: "claude-sonnet-5" }))
      .toEqual({ type: "web_search_20260209", name: "web_search" });
    expect(nativeWebSearchServerTool({ api: "anthropic-messages", providerId: "anthropic", modelId: "claude-opus-4-7" }))
      .toMatchObject({ type: "web_search_20260209" });
    expect(nativeWebSearchServerTool({ api: "anthropic-messages", providerId: "anthropic", modelId: "claude-haiku-4-5" }))
      .toMatchObject({ type: "web_search_20250305" });
  });

  it("forwards filters, preferring the allow list when both are set", () => {
    expect(nativeWebSearchServerTool(
      { api: "anthropic-messages", providerId: "anthropic", modelId: "claude-opus-5" },
      { allowedDomains: ["a.com"], blockedDomains: ["b.com"], userLocation: { type: "approximate", city: "Berlin", country: null } },
    )).toEqual({
      type: "web_search_20260209",
      name: "web_search",
      allowed_domains: ["a.com"],
      user_location: { type: "approximate", city: "Berlin" },
    });
    expect(nativeWebSearchServerTool(
      { api: "openai-responses", providerId: "openai", modelId: "gpt-5" },
      { allowedDomains: ["a.com"], blockedDomains: ["b.com"] },
    )).toEqual({ type: "web_search", filters: { allowed_domains: ["a.com"] } });
  });

  it("refuses gateways, compatible endpoints and non-Claude models on the Anthropic API", () => {
    expect(nativeWebSearchServerTool({ api: "anthropic-messages", providerId: "anthropic-compatible", modelId: "claude-sonnet-5" })).toBeNull();
    expect(nativeWebSearchServerTool({ api: "anthropic-messages", providerId: "anthropic", modelId: "MiniMax-M2" })).toBeNull();
    expect(nativeWebSearchServerTool({ api: "openai-completions", providerId: "openai-compatible", modelId: "gpt-5" })).toBeNull();
    expect(nativeWebSearchServerTool({ api: "google-generative-ai", providerId: "google", modelId: "gemini-flash-latest" })).toBeNull();
  });
});

describe("domain filtering", () => {
  it("matches hosts and subdomains, ignoring www and path suffixes", () => {
    expect(hostMatchesDomainList("https://docs.example.com/x", ["example.com"])).toBe(true);
    expect(hostMatchesDomainList("https://example.com/x", ["www.example.com"])).toBe(true);
    expect(hostMatchesDomainList("https://notexample.com/x", ["example.com"])).toBe(false);
    expect(hostMatchesDomainList("https://example.com/blog", ["example.com/blog"])).toBe(true);
    expect(hostMatchesDomainList("not a url", ["example.com"])).toBe(false);
  });

  it("applies allow then block lists", () => {
    const rows = [
      { title: "a", url: "https://a.com/1", description: "" },
      { title: "b", url: "https://b.a.com/2", description: "" },
      { title: "c", url: "https://c.com/3", description: "" },
    ];
    expect(filterResultsByDomain(rows, { allowedDomains: ["a.com"], blockedDomains: ["b.a.com"] }).map((r) => r.title))
      .toEqual(["a"]);
  });
});

describe("createWebSearchExecutor", () => {
  it("reports a missing key instead of throwing", async () => {
    await expect(createWebSearchExecutor("brave", {}, {}, vi.fn())("q", 5))
      .resolves.toBe("web_search unavailable: BRAVE_SEARCH_API_KEY not configured");
  });

  it("Tavily: sends the key in both places, forwards domain lists, maps content to description", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse({ results: [{ title: "T", url: "https://docs.example.com/p", content: "snippet" }] });
    });
    const run = createWebSearchExecutor("tavily", { TAVILY_API_KEY: "tv" }, { allowedDomains: ["example.com"] }, fetchImpl);
    const out = JSON.parse(await run("hello", 3));
    expect(out).toEqual([{ title: "T", url: "https://docs.example.com/p", description: "snippet" }]);
    expect(calls[0][0]).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ query: "hello", max_results: 3, include_domains: ["example.com"], api_key: "tv" });
    expect(new Headers(calls[0][1]?.headers).get("authorization")).toBe("Bearer tv");
  });

  it("Brave: GET with the subscription header, country from user_location, post-filtered by domain", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("https://api.search.brave.com/res/v1/web/search?");
      expect(url).toContain("country=DE");
      expect(new Headers(init?.headers).get("x-subscription-token")).toBe("bk");
      return jsonResponse({ web: { results: [
        { title: "keep", url: "https://a.com/1", description: "d1" },
        { title: "drop", url: "https://spam.com/2", description: "d2" },
      ] } });
    });
    const run = createWebSearchExecutor("brave", { BRAVE_SEARCH_API_KEY: "bk" }, { blockedDomains: ["spam.com"], userLocation: { type: "approximate", country: "de" } }, fetchImpl);
    expect(JSON.parse(await run("q", 5))).toEqual([{ title: "keep", url: "https://a.com/1", description: "d1" }]);
  });

  it("Exa: x-api-key header, include/exclude domains, text excerpt as description", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.exa.ai/search");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("ek");
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: "q", numResults: 2, excludeDomains: ["x.com"] });
      return jsonResponse({ results: [{ title: "E", url: "https://e.com", text: "  multi\n line  " }] });
    });
    const run = createWebSearchExecutor("exa", { EXA_API_KEY: "ek" }, { blockedDomains: ["x.com"] }, fetchImpl);
    expect(JSON.parse(await run("q", 2))).toEqual([{ title: "E", url: "https://e.com", description: "multi line" }]);
  });

  it("Serper: X-API-KEY header, gl from country, organic rows mapped", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://google.serper.dev/search");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("sk");
      expect(JSON.parse(String(init?.body))).toMatchObject({ q: "q", gl: "us" });
      return jsonResponse({ organic: [{ title: "S", link: "https://s.com", snippet: "sn" }] });
    });
    const run = createWebSearchExecutor("serper", { SERPER_API_KEY: "sk" }, { userLocation: { type: "approximate", country: "US" } }, fetchImpl);
    expect(JSON.parse(await run("q", 5))).toEqual([{ title: "S", url: "https://s.com", description: "sn" }]);
  });

  it("surfaces upstream HTTP failures as text and an empty page as 'No results found.'", async () => {
    const failing = createWebSearchExecutor("serper", { SERPER_API_KEY: "sk" }, {}, vi.fn(async () => jsonResponse({}, 429)));
    await expect(failing("q", 5)).resolves.toBe("Serper search error: HTTP 429");
    const empty = createWebSearchExecutor("exa", { EXA_API_KEY: "ek" }, {}, vi.fn(async () => jsonResponse({ results: [] })));
    await expect(empty("q", 5)).resolves.toBe("No results found.");
  });

  it("DuckDuckGo: keeps the two-step scrape and names the rate limit", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://duckduckgo.com/")) return new Response("vqd='4-123456789'");
      return new Response("DDG.deep.anomalyDetectionBlock");
    });
    await expect(createWebSearchExecutor("ddg", {}, {}, fetchImpl)("q", 5))
      .resolves.toContain("DuckDuckGo rate limited");
  });
});
