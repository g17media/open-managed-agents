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
    for (const path of ["/v1/sessions", "/v1/sessions/"]) {
      const session = await fetch(`${f.baseURL}${path}`, { method: "POST", headers, body: "{}" });
      expect(session.status).toBe(429);
      expectRetryAfter(session);
      expect(await session.json()).toEqual({ error: "Rate limit exceeded" });
    }
    expect((await fetch(`${f.baseURL}/v1/agents`, { headers })).status).toBe(200);
    const events = logEvents(f);
    expect(events).toContainEqual(expect.objectContaining({
      op: "main-node.rate_limit.invalid", name: "OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE", value: "invalid", defaultPoints: 10,
    }));
    const listening = events.find(event => event.op === "main-node.listening");
    expect(listening).toMatchObject({ apiWrite: 2, sessionsTenant: 30 });
  });

  it("limits only legacy session creation per tenant while writes are unlimited", async () => {
    const f = await boot({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: "off", OMA_RATE_LIMIT_SESSIONS_PER_TENANT_PER_MINUTE: "1" });
    expect(logEvents(f)).toContainEqual(expect.objectContaining({ op: "main-node.listening", apiWrite: "unlimited", sessionsTenant: 1 }));
    // Admission happens before body validation, as in the legacy hook.
    const first = await fetch(`${f.baseURL}/v1/oma/sessions`, { method: "POST", headers, body: "{}" });
    expect(first.status).toBe(400);
    const rejected = await fetch(`${f.baseURL}/v1/oma/sessions`, { method: "POST", headers, body: "{}" });
    expect(rejected.status).toBe(429);
    expectRetryAfter(rejected);
    expect(await rejected.json()).toEqual({ error: "Too many session creations — wait a minute" });
    for (const { path, status } of [
      { path: "/v1/sessions", status: 400 },
      { path: "/v1/sessions/", status: 404 },
    ]) {
      const managed = await fetch(`${f.baseURL}${path}`, { method: "POST", headers, body: "{}" });
      expect(managed.status, await managed.text()).toBe(status);
    }
    const write = await fetch(`${f.baseURL}/v1/agents`, { method: "POST", headers,
      body: JSON.stringify({ name: "Unrestricted write", model: "claude-sonnet-4-20250514" }) });
    expect(write.status, await write.clone().text()).toBe(201);
  });

  it("admits more than 30 managed session creates within a minute when writes are plentiful", async () => {
    const f = await boot({ OMA_RATE_LIMIT_API_WRITES_PER_MINUTE: "600" });
    expect(logEvents(f)).toContainEqual(expect.objectContaining({ op: "main-node.listening", apiWrite: 600, sessionsTenant: 30 }));
    const started = Date.now();
    for (let i = 0; i < 32; i++) {
      const response = await fetch(`${f.baseURL}/v1/sessions`, { method: "POST", headers, body: "{}" });
      // Invalid creates reach managed validation instead of a tenant limiter.
      expect(response.status, `request ${i + 1}: ${await response.text()}`).toBe(400);
    }
    expect(Date.now() - started).toBeLessThan(60_000);
    // Managed requests must not consume the legacy tenant bucket either.
    const legacy = await fetch(`${f.baseURL}/v1/oma/sessions`, { method: "POST", headers, body: "{}" });
    expect(legacy.status, await legacy.text()).toBe(400);
  });

  it.each([
    { gate: "OMA_RATE_LIMIT_AUTH_IP_PER_MINUTE", path: "/auth/get-session", method: "GET", error: "Too many requests" },
    { gate: "OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE", path: "/auth/sign-in/email", method: "POST", error: "Too many email requests from this IP" },
    { gate: "OMA_RATE_LIMIT_AUTH_SEND_EMAIL_PER_MINUTE", path: "/auth/sign-in/email", method: "POST", error: "Please wait a minute before requesting another email" },
  ])("sends retry-after and preserves the rejection body for $gate", async ({ gate, path, method, error }) => {
    const f = await boot({
      OMA_RATE_LIMIT_AUTH_IP_PER_MINUTE: "off",
      OMA_RATE_LIMIT_AUTH_SEND_IP_PER_MINUTE: "off",
      OMA_RATE_LIMIT_AUTH_SEND_EMAIL_PER_MINUTE: "off",
      [gate]: "1",
    });
    const request = {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.1" },
      ...(method === "POST" ? { body: JSON.stringify({ email: "limiter@example.test", password: "invalid-test-password" }) } : {}),
    };
    const first = await fetch(`${f.baseURL}${path}`, request);
    expect(first.status, await first.text()).not.toBe(429);
    const rejected = await fetch(`${f.baseURL}${path}`, request);
    expect(rejected.status).toBe(429);
    expectRetryAfter(rejected);
    expect(await rejected.json()).toEqual({ error });
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
