// Web search backends for the built-in `web_search` tool.
//
// The harness historically scraped DuckDuckGo from the OMA host, which
// DuckDuckGo's bot detection blocks as soon as one egress IP searches
// regularly. This module makes the backend a deployment choice:
//
//   - keyed HTTP providers (Tavily, Brave, Exa, Serper) run as an ordinary
//     function tool executed by the harness process;
//   - "native" hands the search to the model provider itself (Anthropic's
//     `web_search` server tool, OpenAI's Responses `web_search` tool). The
//     harness then defines NO function tool — the pi runtime injects the
//     server tool into the request payload instead (see pi-provider.ts).
//
// Selection order: an explicit `web_search_<provider>` tool type on the agent
// beats WEB_SEARCH_PROVIDER, which beats "first provider with a key", which
// beats the DuckDuckGo default. Domain allow/block lists and user location
// configured on the agent's `web_search` toolset entry are honoured by every
// backend: forwarded when the provider supports them, otherwise applied as a
// post-filter on the returned URLs.

import type { AgentConfig, ToolsetConfig } from "@open-managed-agents/shared";

export const WEB_SEARCH_PROVIDERS = ["ddg", "tavily", "brave", "exa", "serper", "native"] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDERS)[number];

/** Keyed providers in the order they are auto-selected when no explicit choice is made. */
const KEYED_PROVIDER_ORDER: Array<Exclude<WebSearchProviderId, "ddg" | "native">> = [
  "tavily",
  "brave",
  "exa",
  "serper",
];

/** Env-derived backend configuration. Every field is optional on purpose:
 *  an unset provider falls back to key detection, and an unset key simply
 *  removes that provider from the auto-selection order. */
export interface WebSearchEnv {
  WEB_SEARCH_PROVIDER?: string;
  TAVILY_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  EXA_API_KEY?: string;
  SERPER_API_KEY?: string;
}

const WEB_SEARCH_ENV_KEYS: Array<keyof WebSearchEnv> = [
  "WEB_SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "EXA_API_KEY",
  "SERPER_API_KEY",
];

/**
 * Pick the web-search variables out of an env-like object (process.env on
 * Node, the Worker binding object on Cloudflare). Empty strings count as
 * unset so a blank line in a .env file does not select a provider.
 */
export function webSearchEnvFrom(source: Record<string, unknown> | undefined): WebSearchEnv {
  const out: WebSearchEnv = {};
  if (!source) return out;
  for (const key of WEB_SEARCH_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

export interface WebSearchUserLocation {
  type: "approximate";
  city?: string | null;
  region?: string | null;
  /** Two-letter ISO 3166-1 country code, as the agent API validates it. */
  country?: string | null;
  timezone?: string | null;
}

/** Per-agent search constraints from the `web_search` toolset config entry. */
export interface WebSearchFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: WebSearchUserLocation;
}

/** The `web_search` config entry carries fields the shared ToolsetConfig type
 *  does not declare (they arrive through the strict API codec or raw on the
 *  legacy route), so read them through this local shape. */
interface WebSearchToolConfigEntry {
  name?: string;
  enabled?: boolean;
  allowed_domains?: string[] | null;
  blocked_domains?: string[] | null;
  user_location?: WebSearchUserLocation | null;
}

function webSearchConfigEntry(agentConfig: AgentConfig): WebSearchToolConfigEntry | undefined {
  for (const tool of agentConfig.tools ?? []) {
    if (tool.type !== "agent_toolset_20260401") continue;
    const entry = (tool as ToolsetConfig).configs?.find((c) => c.name === "web_search");
    if (entry) return entry as WebSearchToolConfigEntry;
  }
  return undefined;
}

function cleanDomains(list: string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const cleaned = list
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim().toLowerCase().replace(/\/$/, ""))
    .filter((d) => d.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Extract allow/block lists and user location for the `web_search` tool. */
export function readWebSearchFilters(agentConfig: AgentConfig): WebSearchFilters {
  const entry = webSearchConfigEntry(agentConfig);
  if (!entry) return {};
  const filters: WebSearchFilters = {};
  const allowed = cleanDomains(entry.allowed_domains);
  const blocked = cleanDomains(entry.blocked_domains);
  if (allowed) filters.allowedDomains = allowed;
  if (blocked) filters.blockedDomains = blocked;
  if (entry.user_location && typeof entry.user_location === "object") {
    filters.userLocation = { ...entry.user_location, type: "approximate" };
  }
  return filters;
}

/**
 * Legacy per-agent override: a `web_search_<provider>` entry in `tools`.
 * `web_search_20250305` is the pre-existing spelling for Anthropic's server
 * tool and maps to "native". Only the legacy `/v1/oma/agents` route lets these
 * through — the strict `/v1/agents` contract rejects unknown tool types.
 */
export function webSearchToolTypeOverride(agentConfig: AgentConfig): WebSearchProviderId | undefined {
  for (const tool of agentConfig.tools ?? []) {
    const type = tool.type;
    if (type === "web_search_20250305") return "native";
    if (!type.startsWith("web_search_")) continue;
    const candidate = type.slice("web_search_".length);
    if ((WEB_SEARCH_PROVIDERS as readonly string[]).includes(candidate)) {
      return candidate as WebSearchProviderId;
    }
  }
  return undefined;
}

function hasKeyFor(provider: WebSearchProviderId, env: WebSearchEnv | undefined): boolean {
  switch (provider) {
    case "tavily": return Boolean(env?.TAVILY_API_KEY);
    case "brave": return Boolean(env?.BRAVE_SEARCH_API_KEY);
    case "exa": return Boolean(env?.EXA_API_KEY);
    case "serper": return Boolean(env?.SERPER_API_KEY);
    default: return true;
  }
}

/** First keyed provider that has a credential, else the DuckDuckGo default.
 *  Used both for auto-selection and as the fallback when "native" was
 *  requested but the model provider cannot host a search tool. */
export function keyedWebSearchFallback(env: WebSearchEnv | undefined): Exclude<WebSearchProviderId, "native"> {
  for (const provider of KEYED_PROVIDER_ORDER) {
    if (hasKeyFor(provider, env)) return provider;
  }
  return "ddg";
}

export interface WebSearchSelection {
  provider: WebSearchProviderId;
  /** Where the choice came from — surfaced in logs so a surprising backend is explainable. */
  source: "agent" | "env" | "key" | "default";
}

/**
 * Decide which backend serves `web_search` for this agent. An explicit agent
 * tool type wins, then WEB_SEARCH_PROVIDER, then the first provider whose key
 * is present, then DuckDuckGo. An unknown WEB_SEARCH_PROVIDER value is
 * ignored with a warning rather than failing the session: a typo in a
 * deployment variable should degrade to the old behaviour, not take agents down.
 */
export function resolveWebSearchProvider(
  env: WebSearchEnv | undefined,
  agentConfig: AgentConfig,
): WebSearchSelection {
  const override = webSearchToolTypeOverride(agentConfig);
  if (override) return { provider: override, source: "agent" };

  const configured = env?.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (configured) {
    if ((WEB_SEARCH_PROVIDERS as readonly string[]).includes(configured)) {
      return { provider: configured as WebSearchProviderId, source: "env" };
    }
    console.warn(
      `[web_search] WEB_SEARCH_PROVIDER="${configured}" is not one of ${WEB_SEARCH_PROVIDERS.join(", ")}; ignoring it`,
    );
  }

  const keyed = keyedWebSearchFallback(env);
  return keyed === "ddg" ? { provider: "ddg", source: "default" } : { provider: keyed, source: "key" };
}

// ---------------------------------------------------------------------------
// Native (provider-hosted) search
// ---------------------------------------------------------------------------

/** Claude models on which Anthropic's newer web search tool version exists.
 *  Older Claude models still take the 2025-03-05 variant; the API rejects
 *  the newer type on them. */
const ANTHROPIC_WEB_SEARCH_2026_MODELS = /^claude-(opus-4-[6-9]|opus-4-\d{2,}|opus-5|sonnet-4-[6-9]|sonnet-4-\d{2,}|sonnet-5|fable|mythos)/;

export interface NativeWebSearchTarget {
  /** pi-ai wire API id, e.g. "anthropic-messages" or "openai-responses". */
  api: string;
  /** pi-ai provider id, e.g. "anthropic", "openai", "openai-compatible". */
  providerId: string;
  /** Wire-level model id sent to the provider. */
  modelId: string;
}

/**
 * Build the provider-hosted search tool object to splice into the request
 * payload, or null when this model provider cannot host one. Null is the
 * signal for callers to fall back to a function-tool backend.
 *
 * Only first-party endpoints qualify: Anthropic-compatible and
 * OpenAI-compatible gateways speak the wire protocol but almost never
 * implement the vendor's server tools, and a silent 400 mid-turn is worse
 * than a keyed fallback.
 */
export function nativeWebSearchServerTool(
  target: NativeWebSearchTarget,
  filters: WebSearchFilters = {},
): Record<string, unknown> | null {
  if (target.api === "anthropic-messages" && target.providerId === "anthropic" && target.modelId.startsWith("claude-")) {
    const type = ANTHROPIC_WEB_SEARCH_2026_MODELS.test(target.modelId)
      ? "web_search_20260209"
      : "web_search_20250305";
    return {
      type,
      name: "web_search",
      ...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
      // Anthropic rejects both lists on one tool; allow wins because it is the stricter contract.
      ...(!filters.allowedDomains && filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
      ...(filters.userLocation ? { user_location: compactLocation(filters.userLocation) } : {}),
    };
  }
  if (target.api === "openai-responses" && target.providerId === "openai") {
    return {
      type: "web_search",
      ...(filters.allowedDomains ? { filters: { allowed_domains: filters.allowedDomains } } : {}),
      ...(filters.userLocation ? { user_location: compactLocation(filters.userLocation) } : {}),
    };
  }
  return null;
}

function compactLocation(location: WebSearchUserLocation): Record<string, string> {
  const out: Record<string, string> = { type: "approximate" };
  for (const key of ["city", "region", "country", "timezone"] as const) {
    const value = location[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Function-tool backends
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

/** True when the URL's host is one of `domains` or a subdomain of one. */
export function hostMatchesDomainList(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const bare = domain.replace(/^www\./, "").split("/")[0];
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/** Apply the agent's allow/block lists to results a provider could not filter itself. */
export function filterResultsByDomain(results: WebSearchResult[], filters: WebSearchFilters): WebSearchResult[] {
  return results.filter((r) => {
    if (filters.allowedDomains && !hostMatchesDomainList(r.url, filters.allowedDomains)) return false;
    if (filters.blockedDomains && hostMatchesDomainList(r.url, filters.blockedDomains)) return false;
    return true;
  });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Runs one search and returns the JSON text handed to the model. */
export type WebSearchExecutor = (query: string, maxResults: number) => Promise<string>;

/** Model-facing description per backend, so the model knows which engine answers. */
export function webSearchToolDescription(provider: Exclude<WebSearchProviderId, "native">): string {
  const engine = {
    ddg: "DuckDuckGo",
    tavily: "Tavily",
    brave: "Brave Search",
    exa: "Exa",
    serper: "Google (via Serper)",
  }[provider];
  return `Search the web using ${engine}. Returns titles, URLs, and descriptions.`;
}

const DEFAULT_MAX_RESULTS = 5;

/**
 * Build the executor for a function-tool backend. Missing credentials
 * produce a model-readable message instead of a thrown error so the agent
 * can tell the user what is unconfigured and move on.
 */
export function createWebSearchExecutor(
  provider: Exclude<WebSearchProviderId, "native">,
  env: WebSearchEnv | undefined,
  filters: WebSearchFilters = {},
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): WebSearchExecutor {
  switch (provider) {
    case "tavily": return tavilyExecutor(env?.TAVILY_API_KEY, filters, fetchImpl);
    case "brave": return braveExecutor(env?.BRAVE_SEARCH_API_KEY, filters, fetchImpl);
    case "exa": return exaExecutor(env?.EXA_API_KEY, filters, fetchImpl);
    case "serper": return serperExecutor(env?.SERPER_API_KEY, filters, fetchImpl);
    case "ddg": return ddgExecutor(filters, fetchImpl);
  }
}

function finish(results: WebSearchResult[], filters: WebSearchFilters, maxResults: number): string {
  const kept = filterResultsByDomain(results, filters).slice(0, maxResults);
  if (kept.length === 0) return "No results found.";
  return JSON.stringify(kept);
}

/** Over-fetch when a post-filter will drop rows, so an allow-list still yields a full page. */
function requestCount(filters: WebSearchFilters, maxResults: number, providerFilters: boolean): number {
  if (providerFilters || (!filters.allowedDomains && !filters.blockedDomains)) return maxResults;
  return Math.min(maxResults * 4, 20);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tavilyExecutor(apiKey: string | undefined, filters: WebSearchFilters, fetchImpl: FetchLike): WebSearchExecutor {
  return async (query, maxResults) => {
    if (!apiKey) return "web_search unavailable: TAVILY_API_KEY not configured";
    const res = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults || DEFAULT_MAX_RESULTS,
        ...(filters.allowedDomains ? { include_domains: filters.allowedDomains } : {}),
        ...(filters.blockedDomains ? { exclude_domains: filters.blockedDomains } : {}),
      }),
    });
    if (!res.ok) return `Tavily search error: HTTP ${res.status}`;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = (data.results ?? []).map((r) => ({
      title: asString(r.title),
      url: asString(r.url),
      description: asString(r.content),
    }));
    return finish(results, filters, maxResults || DEFAULT_MAX_RESULTS);
  };
}

function braveExecutor(apiKey: string | undefined, filters: WebSearchFilters, fetchImpl: FetchLike): WebSearchExecutor {
  return async (query, maxResults) => {
    if (!apiKey) return "web_search unavailable: BRAVE_SEARCH_API_KEY not configured";
    const count = requestCount(filters, maxResults || DEFAULT_MAX_RESULTS, false);
    const params = new URLSearchParams({ q: query, count: String(count) });
    // Brave takes a country code for result localisation; city/region have no equivalent.
    const country = filters.userLocation?.country;
    if (country) params.set("country", country.toUpperCase());
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return `Brave search error: HTTP ${res.status}`;
    const data = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    const results = (data.web?.results ?? []).map((r) => ({
      title: asString(r.title),
      url: asString(r.url),
      description: asString(r.description),
    }));
    return finish(results, filters, maxResults || DEFAULT_MAX_RESULTS);
  };
}

function exaExecutor(apiKey: string | undefined, filters: WebSearchFilters, fetchImpl: FetchLike): WebSearchExecutor {
  return async (query, maxResults) => {
    if (!apiKey) return "web_search unavailable: EXA_API_KEY not configured";
    const res = await fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query,
        numResults: maxResults || DEFAULT_MAX_RESULTS,
        ...(filters.allowedDomains ? { includeDomains: filters.allowedDomains } : {}),
        ...(filters.blockedDomains ? { excludeDomains: filters.blockedDomains } : {}),
        // A short text excerpt stands in for the snippet Exa does not return by default.
        contents: { text: { maxCharacters: 400 } },
      }),
    });
    if (!res.ok) return `Exa search error: HTTP ${res.status}`;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = (data.results ?? []).map((r) => ({
      title: asString(r.title),
      url: asString(r.url),
      description: asString(r.text).replace(/\s+/g, " ").trim(),
    }));
    return finish(results, filters, maxResults || DEFAULT_MAX_RESULTS);
  };
}

function serperExecutor(apiKey: string | undefined, filters: WebSearchFilters, fetchImpl: FetchLike): WebSearchExecutor {
  return async (query, maxResults) => {
    if (!apiKey) return "web_search unavailable: SERPER_API_KEY not configured";
    const num = requestCount(filters, maxResults || DEFAULT_MAX_RESULTS, false);
    const country = filters.userLocation?.country;
    const res = await fetchImpl("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        q: query,
        num,
        ...(country ? { gl: country.toLowerCase() } : {}),
      }),
    });
    if (!res.ok) return `Serper search error: HTTP ${res.status}`;
    const data = (await res.json()) as { organic?: Array<Record<string, unknown>> };
    const results = (data.organic ?? []).map((r) => ({
      title: asString(r.title),
      url: asString(r.link),
      description: asString(r.snippet),
    }));
    return finish(results, filters, maxResults || DEFAULT_MAX_RESULTS);
  };
}

/** The original scraper, kept as the zero-config default. It is the backend
 *  most likely to be rate limited: DuckDuckGo blocks by egress IP, and every
 *  session on one host shares that IP. */
function ddgExecutor(filters: WebSearchFilters, fetchImpl: FetchLike): WebSearchExecutor {
  return async (query, maxResults) => {
    const count = requestCount(filters, maxResults || DEFAULT_MAX_RESULTS, false);
    // Step 1: the results endpoint needs a per-query `vqd` token from the HTML page.
    const vqdRes = await fetchImpl(`https://duckduckgo.com/?${new URLSearchParams({ q: query, ia: "web" })}`);
    if (!vqdRes.ok) return `DuckDuckGo error: ${vqdRes.status}`;
    const vqdText = await vqdRes.text();
    const vqd = /vqd=['"](\d+-\d+(?:-\d+)?)['"]/.exec(vqdText)?.[1];
    if (!vqd) return "DuckDuckGo: failed to get search token";

    // Step 2: fetch the JSONP-ish results document.
    const params = new URLSearchParams({
      q: query, l: "en-us", kl: "wt-wt", s: "0", dl: "en",
      ct: "US", ss_mkt: "us", vqd, sp: "1", bpa: "1",
    });
    const searchRes = await fetchImpl(`https://links.duckduckgo.com/d.js?${params}`);
    if (!searchRes.ok) return `DuckDuckGo search error: ${searchRes.status}`;
    const body = await searchRes.text();

    if (body.includes("DDG.deep.anomalyDetectionBlock")) {
      return "DuckDuckGo rate limited. Try again in a moment, or ask the operator to configure a keyed search provider (WEB_SEARCH_PROVIDER).";
    }

    // Step 3: the results live inside a DDG.pageLayout.load('d', [...]) call.
    const match = /DDG\.pageLayout\.load\('d',(\[.+?\])\);DDG\.duckbar\.load/.exec(body);
    if (!match) return "DuckDuckGo: no results found";

    const raw = JSON.parse(match[1].replace(/\t/g, "    ")) as Array<Record<string, unknown>>;
    const results = raw
      // Rows with an `n` key are navigation/pagination markers, not hits.
      .filter((r) => r.u && !("n" in r))
      .slice(0, count)
      .map((r) => ({
        title: asString(r.t),
        url: asString(r.u),
        description: asString(r.a).replace(/<\/?b>/g, ""),
      }));
    return finish(results, filters, maxResults || DEFAULT_MAX_RESULTS);
  };
}
