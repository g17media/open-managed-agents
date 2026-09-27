import { MANAGED_AGENTS_BETA } from "../src/beta";
import { describe, expect, it } from "vitest";
import { CredentialsApplicationService } from "../../managed-agents-application/src/index";
import { IndeterminateCredentialValidationProbe } from "../../managed-agents-adapters-runtime/src/credential-validation-probe";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { buildCredentialsTestApi } from "./test-api";

function setup() {
  const store = new MemoryCredentialStore();
  const service = new CredentialsApplicationService({
    workspaceId: "workspace_01", store,
    vaults: { find: async () => ({ id: "vlt_01", archivedAt: null, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z", metadata: {} }) },
    validation: new IndeterminateCredentialValidationProbe(),
    clock: { now: () => new Date("2026-09-27T00:00:00.000Z") },
    ids: { nextCredentialId: () => "vcrd_basic" },
  });
  const api = buildCredentialsTestApi(service);
  const request = (path = "", method = "GET", body?: unknown) => api.request(`/v1/vaults/vlt_01/credentials${path}`, {
    method, headers: { "content-type": "application/json", "anthropic-beta": MANAGED_AGENTS_BETA }, ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { store, request };
}
const auth = { type: "static_basic", mcp_server_url: "https://langfuse.example.test", username: "public", token: "test-password" };

describe("static Basic credentials API and application", () => {
  it("creates, masks, validates, rotates and deletes a password without losing the username", async () => {
    const { store, request } = setup();
    const created = await request("", "POST", { auth });
    expect(created.status).toBe(201);
    const view = { type: "static_basic", mcp_server_url: auth.mcp_server_url, username: "public" };
    expect((await created.json()).auth).toEqual(view);
    expect((await (await request("/vcrd_basic")).json()).auth).toEqual(view);
    expect((await (await request()).json()).data[0].auth).toEqual(view);
    const validated = await request("/vcrd_basic/mcp_oauth_validate", "POST", {});
    expect(validated.status).toBe(200);
    expect(await validated.json()).toMatchObject({ has_refresh_token: false, status: "unknown" });
    const rotated = await request("/vcrd_basic", "POST", { auth: { type: "static_basic", token: " rotated:test-password " } });
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).auth).toEqual(view);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toEqual({ type: "static_basic", username: "public", token: " rotated:test-password ", mcpServerUrl: auth.mcp_server_url });
    expect((await request("/vcrd_basic", "POST", { auth: { type: "static_basic", username: "bad:name" } })).status).toBe(400);
    const cleared = await request("/vcrd_basic", "POST", { auth: { type: "static_basic", token: null } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).auth).toEqual(view);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token: null });
    expect((await request("/vcrd_basic", "DELETE")).status).toBe(200);
    expect((await request("/vcrd_basic")).status).toBe(404);
  });

  it.each([
    { username: undefined }, { username: "" }, { username: "bad:name" }, { username: "bad\nname" },
    { token: undefined }, { token: "" }, { mcp_server_url: "not-a-url" },
    { mcp_server_url: "file:///tmp/local" }, { handle: "not-supported" },
  ])("rejects invalid Basic auth input %j", async (patch) => {
    const { request } = setup();
    expect((await request("", "POST", { auth: { ...auth, ...patch } })).status).toBe(400);
  });
});
