import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes, type SessionRoutesDeps } from "@open-managed-agents/http-routes";
import { bootOpenAINode, type OpenAINodeProcess } from "./_helpers/openai-node-process";

const headers = {
  "x-api-key": "rate-limit-test-key",
  "content-type": "application/json",
  "anthropic-beta": "managed-agents-2026-04-01",
};
let fixture: OpenAINodeProcess | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

async function boot(env: Record<string, string>) {
  fixture = await bootOpenAINode(undefined, { env: {
    AUTH_DISABLED: "0", API_KEY: headers["x-api-key"],
    BETTER_AUTH_SECRET: "rate-limit-http-test-secret-at-least-32-characters",
    ...env,
  } });
  return fixture;
}

function expectRetryAfter(response: Response) {
  const header = response.headers.get("retry-after");
  expect(header).toMatch(/^[1-9]\d*$/);
  expect(Number(header)).toBeLessThanOrEqual(60);
}

function logEvents(f: OpenAINodeProcess) {
  return f.logs.join("").split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

describe("Node rate-limit HTTP responses", () => {
  it("uses the boot override and preserves the API write 429 body and retry-after", async () => {
    const f = await boot({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: "2", OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE: "invalid" });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${f.baseURL}/v1/agents`, { method: "POST", headers,
        body: JSON.stringify({ name: "Limiter test", model: "claude-sonnet-4-20250514" }) });
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const rejected = await fetch(`${f.baseURL}/v1/agents`, { method: "POST", headers, body: "{}" });
    expect(rejected.status).toBe(429);
    expectRetryAfter(rejected);
    expect(await rejected.json()).toEqual({ error: "Rate limit exceeded" });
    expect((await fetch(`${f.baseURL}/v1/agents`, { headers })).status).toBe(200);
    const events = logEvents(f);
    expect(events).toContainEqual(expect.objectContaining({
      op: "main-node.rate_limit.invalid", name: "OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE", value: "invalid", defaultPoints: 10,
    }));
    const listening = events.find(event => event.op === "main-node.listening");
    expect(listening).toMatchObject({ apiWrite: 2, sessionsTenant: 30 });
  });

  it("limits public session creation per tenant while writes are unlimited", async () => {
    const f = await boot({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: "off", OMA_RATE_LIMIT_SESSIONS_PER_TENANT_PER_MINUTE: "1" });
    expect(logEvents(f)).toContainEqual(expect.objectContaining({ op: "main-node.listening", apiWrite: "unlimited", sessionsTenant: 1 }));
    // Admission happens before body validation, as in the legacy hook.
    const first = await fetch(`${f.baseURL}/v1/sessions`, { method: "POST", headers, body: "{}" });
    expect(first.status).toBe(400);
    for (const path of ["/v1/sessions", "/v1/sessions/", "/v1/oma/sessions"]) {
      const rejected = await fetch(`${f.baseURL}${path}`, { method: "POST", headers, body: "{}" });
      expect(rejected.status).toBe(429);
      expectRetryAfter(rejected);
      expect(await rejected.json()).toEqual({ error: "Too many session creations — wait a minute" });
    }
    const write = await fetch(`${f.baseURL}/v1/agents`, { method: "POST", headers,
      body: JSON.stringify({ name: "Unrestricted write", model: "claude-sonnet-4-20250514" }) });
    expect(write.status, await write.clone().text()).toBe(201);
  });

  it.each([37, undefined])("forwards the legacy tenant retryAfter %s without changing its body", async (retryAfter) => {
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", "default"); await next(); });
    app.route("/sessions", buildSessionRoutes({
      services: {} as SessionRoutesDeps["services"],
      router: {} as SessionRoutesDeps["router"],
      lifecycle: { preCreateRateLimit: async () => ({ status: 429, body: { error: "Too many session creations — wait a minute" }, retryAfter }) },
    }));
    const response = await app.request("/sessions", { method: "POST", body: "{}" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(retryAfter === undefined ? null : "37");
    expect(await response.json()).toEqual({ error: "Too many session creations — wait a minute" });
  });
});
