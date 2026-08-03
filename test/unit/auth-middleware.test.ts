// createAuthMiddleware: tenant resolution in the cookie-session branch.
// The x-active-tenant header is the Console's normal channel; the
// ?active_tenant= query param covers top-level navigations that can't
// set headers (the /v1/oauth/authorize popup). Both must be validated
// against membership before being honored.
//
// hono isn't resolvable from the test root (pnpm strict deps), so the
// middleware is driven with a minimal hand-rolled context — it only
// touches c.req.path/header/query/raw.headers, c.set, and c.json.

import { describe, it, expect } from "vitest";
import {
  createAuthMiddleware,
  type AuthMiddlewareDeps,
} from "@open-managed-agents/auth";

function buildMw(overrides: Partial<AuthMiddlewareDeps> = {}) {
  return createAuthMiddleware({
    disabled: false,
    resolveSession: async () => ({ userId: "user-1" }),
    resolveApiKey: async () => null,
    defaultTenantForUser: async () => "tenant-default",
    hasMembership: async (_userId, tenantId) => tenantId === "tenant-member",
    ensureTenantForUser: async () => "tenant-minted",
    ...overrides,
  });
}

async function run(
  mw: ReturnType<typeof createAuthMiddleware>,
  req: { path?: string; headers?: Record<string, string>; query?: Record<string, string> },
) {
  const vars: Record<string, string> = {};
  let jsonBody: unknown;
  let jsonStatus: number | undefined;
  let nextCalled = false;
  const c = {
    req: {
      path: req.path ?? "/whoami",
      header: (name: string) => req.headers?.[name.toLowerCase()],
      query: (name: string) => req.query?.[name],
      raw: new Request("http://test.local/", { headers: req.headers }),
    },
    set: (key: string, value: string) => {
      vars[key] = value;
    },
    json: (body: unknown, status?: number) => {
      jsonBody = body;
      jsonStatus = status ?? 200;
      return new Response(JSON.stringify(body), { status: jsonStatus });
    },
  };
  await mw(c as never, async () => {
    nextCalled = true;
  });
  return { vars, jsonBody, jsonStatus, nextCalled };
}

describe("createAuthMiddleware tenant resolution", () => {
  it("falls back to the default tenant with no pin", async () => {
    const r = await run(buildMw(), {});
    expect(r.nextCalled).toBe(true);
    expect(r.vars).toEqual({ tenant_id: "tenant-default", user_id: "user-1" });
  });

  it("honors x-active-tenant header when membership passes", async () => {
    const r = await run(buildMw(), {
      headers: { "x-active-tenant": "tenant-member" },
    });
    expect(r.nextCalled).toBe(true);
    expect(r.vars.tenant_id).toBe("tenant-member");
  });

  it("honors ?active_tenant= query param when membership passes", async () => {
    const r = await run(buildMw(), {
      query: { active_tenant: "tenant-member" },
    });
    expect(r.nextCalled).toBe(true);
    expect(r.vars.tenant_id).toBe("tenant-member");
  });

  it("rejects a query-param tenant the user is not a member of", async () => {
    const r = await run(buildMw(), {
      query: { active_tenant: "tenant-other" },
    });
    expect(r.nextCalled).toBe(false);
    expect(r.jsonStatus).toBe(403);
    expect((r.jsonBody as { error?: { type?: string } }).error?.type).toBe(
      "not_a_member",
    );
  });

  it("prefers the header over the query param", async () => {
    const seen: string[] = [];
    const mw = buildMw({
      hasMembership: async (_userId, tenantId) => {
        seen.push(tenantId);
        return true;
      },
    });
    const r = await run(mw, {
      headers: { "x-active-tenant": "tenant-header" },
      query: { active_tenant: "tenant-query" },
    });
    expect(r.vars.tenant_id).toBe("tenant-header");
    expect(seen).toEqual(["tenant-header"]);
  });
});
