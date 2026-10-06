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
    { username: undefined }, { username: "" }, { username: "bad:name" }, { username: "bad\nname" }, { username: "bad\x85name" },
    { token: undefined }, { token: "" }, { mcp_server_url: "not-a-url" },
    { mcp_server_url: "file:///tmp/local" }, { handle: "not-supported" },
  ])("rejects invalid Basic auth input %j", async (patch) => {
    const { request } = setup();
    expect((await request("", "POST", { auth: { ...auth, ...patch } })).status).toBe(400);
  });
  it.each(["username", "token"] as const)("identifies missing %s without echoing secrets", async (field) => {
    const { request } = setup();
    const response = await request("", "POST", { auth: { ...auth, [field]: undefined } });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain(`auth.${field}`);
    expect(body.includes(auth.token)).toBe(false);
  });
  it.each(["static_basic", "static_bearer"] as const)("rejects unknown create and rotation fields consistently (%s)", async (type) => {
    const { request, store } = setup();
    const input = type === "static_basic" ? auth : { type, token: auth.token, mcp_server_url: auth.mcp_server_url };
    expect((await request("", "POST", { auth: { ...input, unexpected: true } })).status).toBe(400);
    expect((await request("", "POST", { auth: input })).status).toBe(201);
    const response = await request("/vcrd_basic", "POST", { auth: { type, token: "replacement", unexpected: true } });
    expect(response.status).toBe(400);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token: auth.token });
  });
});


describe("credential metadata editing", () => {
  it.each(["static_basic", "static_bearer", "cap_cli"])("rejects empty %s tokens atomically and preserves exact secret bytes", async (type) => {
    const { request, store } = setup();
    const token = " exact:synthetic-token\t ";
    const original = { type, token, mcp_server_url: "https://before.example.test", ...(type === "static_basic" ? { username: "user" } : { handle: "before" }), ...(type === "cap_cli" && { cli_id: "git" }) };
    expect((await request("", "POST", { auth: original, display_name: "Before" })).status).toBe(201);
    const rejected = await request("/vcrd_basic", "POST", { display_name: "Invalid", auth: { type, token: "", mcp_server_url: "https://invalid.example.test" } });
    expect(rejected.status).toBe(400);
    const unchanged = await (await request("/vcrd_basic")).json();
    expect(unchanged.display_name).toBe("Before");
    expect(unchanged.auth.mcp_server_url).toBe(original.mcp_server_url);
    const updated = await request("/vcrd_basic", "POST", { auth: { type, mcp_server_url: "https://after.example.test" } });
    expect(updated.status).toBe(200);
    const publicAuth = (await updated.json()).auth;
    expect(publicAuth).not.toHaveProperty("token");
    expect(publicAuth).not.toHaveProperty("password");
    const saved = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" });
    expect("token" in saved!.credential.auth && saved!.credential.auth.token === token).toBe(true);
    expect((await setup().request("", "POST", { auth: { ...original, token: "" } })).status).toBe(400);
    // Tightening empty-string validation must not remove explicit disable/rotation support.
    const disabled = await request("/vcrd_basic", "POST", { auth: { type, token: null } });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).auth).not.toHaveProperty("token");
    const disabledRecord = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" });
    expect(disabledRecord?.credential.auth).toHaveProperty("token", null);
    expect((await request("/vcrd_basic", "POST", { auth: { type, token } })).status).toBe(200);
    const rotated = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" });
    expect("token" in rotated!.credential.auth && rotated!.credential.auth.token === token).toBe(true);
  });

  it.each([
    { type: "static_basic", username: "public" },
    { type: "static_bearer", handle: "before" },
    { type: "cap_cli", cli_id: "git", handle: "before" },
  ])("updates $type metadata while preserving omitted secrets", async (kind) => {
    const { request, store } = setup();
    const original = { ...kind, token: "keep-this-secret", mcp_server_url: "https://before.example.test" };
    expect((await request("", "POST", { auth: original, display_name: "Before" })).status).toBe(201);
    const patch = kind.type === "static_basic" ? { username: "after" } : { handle: "after" };
    const updated = await request("/vcrd_basic", "POST", {
      display_name: "After", auth: { type: kind.type, mcp_server_url: "https://after.example.test", ...patch },
    });
    expect(updated.status).toBe(200);
    const expected = { ...kind, ...patch, mcp_server_url: "https://after.example.test" };
    expect(await updated.json()).toMatchObject({ display_name: "After", auth: expected });
    const retrieved = await (await request("/vcrd_basic")).json();
    expect(retrieved.auth).toEqual(expected);
    expect((await (await request()).json()).data[0].auth).toEqual(expected);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token: "keep-this-secret", mcpServerUrl: "https://after.example.test" });
    if (kind.type !== "static_basic") {
      const cleared = await request("/vcrd_basic", "POST", { display_name: null, auth: { type: kind.type, handle: null } });
      expect(cleared.status).toBe(200);
      const body = await cleared.json();
      expect(body.display_name).toBeNull();
      expect(body.auth).not.toHaveProperty("handle");
      expect(body.auth.mcp_server_url).toBe("https://after.example.test");
    }
  });

  it.each(["static_basic", "static_bearer", "cap_cli"])("validates %s create and update URLs identically", async (type) => {
    const { request } = setup();
    const original = { type, token: "secret", mcp_server_url: "https://valid.example.test", ...(type === "static_basic" && { username: "user" }), ...(type === "cap_cli" && { cli_id: "git" }) };
    expect((await request("", "POST", { auth: original })).status).toBe(201);
    for (const mcp_server_url of ["", "not-a-url", "file:///tmp/secret", null]) {
      expect((await setup().request("", "POST", { auth: { ...original, mcp_server_url } })).status).toBe(400);
      expect((await request("/vcrd_basic", "POST", { auth: { type, mcp_server_url } })).status).toBe(400);
    }
  });

  it.each(["static_bearer", "cap_cli"])("validates %s handles without overwriting saved metadata", async (type) => {
    const { request } = setup();
    const original = { type, token: "secret", handle: "valid.handle-1", mcp_server_url: "https://valid.example.test", ...(type === "cap_cli" && { cli_id: "git" }) };
    expect((await request("", "POST", { auth: original })).status).toBe(201);
    for (const handle of ["", "space here", "bad:handle", "a".repeat(129)]) {
      expect((await request("", "POST", { auth: { ...original, handle } })).status).toBe(400);
      expect((await request("/vcrd_basic", "POST", { auth: { type, handle } })).status).toBe(400);
    }
    expect((await (await request("/vcrd_basic")).json()).auth.handle).toBe("valid.handle-1");
  });

  it("returns configured registry usernames without passwords or tokens", async () => {
    const { request } = setup();
    const created = await request("", "POST", { auth: { type: "container_registry", registry: "ghcr.io", username: "robot", password: "private-password", token: "private-token" } });
    expect(created.status).toBe(201);
    const expected = { type: "container_registry", registry: "ghcr.io", username: "robot" };
    expect((await created.json()).auth).toEqual(expected);
    expect((await (await request("/vcrd_basic")).json()).auth).toEqual(expected);
    expect((await (await request()).json()).data[0].auth).toEqual(expected);
  });

  it("keeps OAuth endpoint and auth type immutable", async () => {
    const { request, store } = setup();
    expect((await request("", "POST", { auth: { type: "mcp_oauth", access_token: "secret", mcp_server_url: "https://oauth.example.test" } })).status).toBe(201);
    const before = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" });
    expect((await request("/vcrd_basic", "POST", { auth: { type: "mcp_oauth", mcp_server_url: "https://changed.example.test" } })).status).toBe(400);
    expect((await request("/vcrd_basic", "POST", { auth: { type: "static_bearer", handle: "changed" } })).status).toBe(400);
    const after = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" });
    expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    expect((await (await request("/vcrd_basic")).json()).auth).toEqual({ type: "mcp_oauth", mcp_server_url: "https://oauth.example.test" });
  });
});


describe("header-safe static credentials (High-1)", () => {
  it("preserves Unicode Basic passwords because they are encoded before injection", async () => {
    const { request, store } = setup();
    const token = "exact-🔑-password";
    expect((await request("", "POST", { auth: { ...auth, token } })).status).toBe(201);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token });
    expect((await request("/vcrd_basic", "POST", { auth: { type: "static_basic", token: `${token}-rotated` } })).status).toBe(200);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token: `${token}-rotated` });
  });
  it.each(["static_bearer", "static_basic", "cap_cli"])("rejects invalid %s tokens on create and update without echoing or storing them", async (type) => {
    const { request, store } = setup();
    const input = { type, token: "safe-token", mcp_server_url: auth.mcp_server_url,
      ...(type === "static_basic" && { username: "public" }), ...(type === "cap_cli" && { cli_id: "git" }) };
    const invalidCharacters = ["\r\n", "\0", "\x1f", "\x7f", "\x85", "\x9f", ...(type !== "static_basic" ? ["\u0100", "\u2028", "🔑"] : [])];
    for (const character of invalidCharacters) {
      const token = `synthetic-invalid-secret${character}second-line`;
      const response = await request("", "POST", { auth: { ...input, token } });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("Credential token contains invalid header characters");
      expect(body).not.toContain("synthetic-invalid-secret");
      expect(await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" })).toBeNull();
    }
    expect((await request("", "POST", { auth: input })).status).toBe(201);
    for (const character of invalidCharacters) {
      const response = await request("/vcrd_basic", "POST", { auth: { type, token: `synthetic-invalid-secret${character}second-line` } });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("synthetic-invalid-secret");
      expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_basic" }))?.credential.auth).toMatchObject({ token: "safe-token" });
    }
  });
});
