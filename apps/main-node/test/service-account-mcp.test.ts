import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-node";
import { createNodeMcpBindings } from "../src/lib/node-mcp-bindings";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";

afterEach(() => vi.unstubAllGlobals());

it("native Node MCP mints and refreshes JWT tokens while sealing keys and tokens in SQL", async () => {
  const db = await bootstrapTestDb();
  try {
    const time = new Date().toISOString();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const cipher = new WebCryptoAesGcm("throwaway-test-secret", "managed.vault.credentials");
    const store = new SqlCredentialStore(db.sql, {
      seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }),
      open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }),
    });
    await new SqlVaultStore(db.sql).insert({ workspaceId: "workspace", vault: {
      id: "vault", metadata: {}, createdAt: time, updatedAt: time, archivedAt: null,
    } });
    await store.insert({ workspaceId: "workspace", credential: {
      id: "credential", vaultId: "vault", metadata: {}, createdAt: time, updatedAt: time, archivedAt: null,
      auth: { type: "service_account_jwt", mcpServerUrl: "https://google.example.test/mcp", clientEmail: "bot@example.test",
        privateKey: pem, tokenUri: "https://tokens.example.test/token", scopes: "drive documents" },
    } });
    let mints = 0;
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "https://tokens.example.test/token") {
        const form = new URLSearchParams(init.body as URLSearchParams);
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const [header, claims, signature] = form.get("assertion")!.split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
        return Response.json({ access_token: `synthetic-mint-${++mints}`, expires_in: 3600 });
      }
      const headers = new Headers(init.headers);
      expect(headers.has("x-oma-tenant")).toBe(false);
      authorizations.push(headers.get("authorization")!);
      return new Response("upstream", { status: authorizations.length === 1 ? 401 : 200 });
    });
    const binding = createNodeMcpBindings({ sql: db.sql, legacy: {} as never,
      nativeCredentials: () => store,
      execution: () => ({ find: async () => ({ session: { archivedAt: null, vaultIds: ["vault"],
        agent: { mcpServers: [{ name: "google", type: "url", url: "https://google.example.test/mcp" }] },
      } }) }) as never,
    });
    const response = await binding.managedMcpBindingFetch(new Request("https://internal.test/", {
      method: "POST", body: "{}", headers: { "x-oma-tenant": "workspace", "x-oma-session": "session", "x-oma-mcp-server": "google" },
    }));
    expect(response.status).toBe(200);
    expect(authorizations).toEqual(["Bearer synthetic-mint-1", "Bearer synthetic-mint-2"]);
    expect(mints).toBe(2);
    const saved = await store.find({ workspaceId: "workspace", vaultId: "vault", credentialId: "credential" });
    expect(saved?.credential.auth).toMatchObject({ accessToken: "synthetic-mint-2" });
    const rows = await db.sql.prepare("SELECT sealed_document FROM managed_credentials").all();
    expect(JSON.stringify(rows.results)).not.toContain(pem);
    expect(JSON.stringify(rows.results)).not.toContain("synthetic-mint");
  } finally { db.cleanup(); }
});
