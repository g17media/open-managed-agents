import { describe, expect, it, vi } from "vitest";
import { CfSessionRouter, type CfSessionRouterDeps } from "../../apps/main/src/lib/cf-session-router";

describe("CfSessionRouter pending events", () => {
  it("uses the authorized native session environment without requiring a retired row", async () => {
    const get = vi.fn(async () => null);
    const body = JSON.stringify({ data: [{ id: "pending_1" }], has_more: false });
    const fetch = vi.fn(async () => new Response(body));
    const router = new CfSessionRouter({
      tenantId: "workspace_1",
      env: { SANDBOX_sandbox_default: { fetch } } as unknown as CfSessionRouterDeps["env"],
      services: { sessions: { get } } as unknown as CfSessionRouterDeps["services"],
    });
    expect(await router.getPending("session_New", { environmentId: "env_1", rawSearch: "?session_thread_id=thread_1" }))
      .toEqual({ status: 200, body });
    expect(fetch).toHaveBeenCalledWith("https://sandbox/sessions/session_New/pending?session_thread_id=thread_1", { method: "GET" });
    expect(get).not.toHaveBeenCalled();
  });
});
