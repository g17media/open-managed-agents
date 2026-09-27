import { credentialCreateBodySchema, credentialUpdateBodySchema } from "../src/contracts/credentials";
import { generateKeyPairSync } from "node:crypto";
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
    ids: { nextCredentialId: () => "vcrd_sa" },
  });
  const api = buildCredentialsTestApi(service);
  const request = (path = "", method = "GET", body?: unknown) => api.request(`/v1/vaults/vlt_01/credentials${path}`, {
    method, headers: { "content-type": "application/json", "anthropic-beta": MANAGED_AGENTS_BETA }, ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { store, request };
}
const privateKey = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const key = privateKey();
const auth = { type: "service_account_jwt", mcp_server_url: "https://www.googleapis.com/", client_email: "bot@example.iam.gserviceaccount.com", private_key: key, scopes: "drive documents" };
const view = { type: auth.type, mcp_server_url: auth.mcp_server_url, client_email: auth.client_email, scopes: auth.scopes, token_uri: "https://oauth2.googleapis.com/token" };

describe("service account JWT credential contract", () => {
  it("preserves synchronous schema validation for existing credential kinds", () => {
    expect(credentialCreateBodySchema.safeParse({ auth: { type: "static_bearer", token: "placeholder", mcp_server_url: "https://example.test" } }).success).toBe(true);
    expect(credentialUpdateBodySchema.safeParse({ auth: { type: "mcp_oauth", access_token: "placeholder" } }).success).toBe(true);
  });
  it.each(["fields", "object", "string"])("creates from %s, masks get/list, rotates, edits and deletes", async (shape) => {
    const { request, store } = setup();
    const keyJson = { type: "service_account", client_email: auth.client_email, private_key: key, private_key_id: "kid", project_id: "ignored-project", token_uri: view.token_uri };
    const input = shape === "fields" ? auth : { type: auth.type, mcp_server_url: auth.mcp_server_url, scopes: auth.scopes, key_json: shape === "object" ? keyJson : JSON.stringify(keyJson) };
    const expected = { ...view, ...(shape !== "fields" && { private_key_id: "kid" }) };
    const created = await request("", "POST", { auth: input });
    expect(created.status).toBe(201);
    expect((await created.json()).auth).toEqual(expected);
    expect((await (await request("/vcrd_sa")).json()).auth).toEqual(expected);
    expect((await (await request()).json()).data[0].auth).toEqual(expected);
    const replacement = privateKey();
    expect((await request("/vcrd_sa", "POST", { auth: { type: auth.type, key_json: { ...keyJson, private_key: replacement, private_key_id: "rotated" } } })).status).toBe(200);
    const updated = await request("/vcrd_sa", "POST", { auth: { type: auth.type, scopes: "new-scope", subject: "delegate@example.test", audience: "https://audience.example.test", mcp_server_url: "https://docs.googleapis.com" } });
    expect(updated.status).toBe(200);
    expect((await updated.json()).auth).toEqual({ ...view, private_key_id: "rotated", scopes: "new-scope", subject: "delegate@example.test", audience: "https://audience.example.test", mcp_server_url: "https://docs.googleapis.com" });
    const saved = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_sa" });
    expect(saved?.credential.auth).toMatchObject({ privateKey: replacement, privateKeyId: "rotated", scopes: "new-scope" });
    expect(saved?.credential.auth).not.toHaveProperty("key_json");
    expect((await request("/vcrd_sa", "POST", { auth: { type: auth.type, subject: null, audience: null, private_key_id: null } })).status).toBe(200);
    expect((await (await request("/vcrd_sa")).json()).auth).not.toHaveProperty("subject");
    expect((await request("/vcrd_sa", "DELETE")).status).toBe(200);
    expect((await request("/vcrd_sa")).status).toBe(404);
  });

  it.each([{ private_key: "bad PEM" }, { scopes: undefined }, { scopes: "   " }, { token_uri: "http://tokens.test" }, { token_uri: "not-a-url" }, { token_uri: "" }, { token_uri: "https://user:password@tokens.test" }, { client_email: "" }, { unexpected: true }, { key_json: "invalid-json" }, { key_json: [] }, { key_json: { private_key: 123 } }])("rejects invalid create without leaking input", async (patch) => {
    const response = await setup().request("", "POST", { auth: { ...auth, ...patch } });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(key);
  });

  it("accepts PKCS#1 RSA keys and supports disabling a stored key", async () => {
    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const { request, store } = setup();
    expect((await request("", "POST", { auth: { ...auth, private_key: pkcs1 } })).status).toBe(201);
    const cleared = await request("/vcrd_sa", "POST", { auth: { type: auth.type, private_key: null } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).auth).toEqual(view);
    expect((await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_sa" }))?.credential.auth).toHaveProperty("privateKey", null);
  });

  it("rejects non-RSA PEM and invalid rotations atomically", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await setup().request("", "POST", { auth: { ...auth, private_key: ec } })).status).toBe(400);
    const { request, store } = setup();
    expect((await request("", "POST", { auth })).status).toBe(201);
    for (const patch of [{ private_key: "bad" }, { private_key: "" }, { scopes: "" }, { token_uri: "http://bad.test" }, { mcp_server_url: "file:///tmp/key" }, { access_token: "cannot-inject" }]) {
      expect((await request("/vcrd_sa", "POST", { display_name: "must-not-save", auth: { type: auth.type, ...patch } })).status).toBe(400);
    }
    const saved = await store.find({ workspaceId: "workspace_01", vaultId: "vlt_01", credentialId: "vcrd_sa" });
    expect(saved?.credential.auth).toMatchObject({ privateKey: key, scopes: auth.scopes });
    expect(saved?.revision).toBe(1);
  });
});
