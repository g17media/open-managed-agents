import type { OAuthCredentialPersistence } from "./index";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type { Credential, CredentialAuth, VaultsApplicationPort } from "@open-managed-agents/managed-agents-application";
import { listManagedVaultCredentials, refreshManagedCredential } from "@open-managed-agents/vault-forward/managed";

export function nativeOAuthCredentials(input: {
  workspaceId: string; store: CredentialStore; vaults: VaultsApplicationPort; nextId(): string;
}): OAuthCredentialPersistence {
  const vaultExists = async (vaultId: string) => {
    const result = await input.vaults.retrieveVault({ vaultId });
    return result.type === "found" && result.vault.archivedAt === null;
  };
  const save = async (vaultId: string, displayName: string, auth: CredentialAuth, credentialId?: string) => {
    if (!await vaultExists(vaultId)) throw new Error("Vault is unavailable");
    const timestamp = new Date().toISOString();
    if (credentialId) {
      const location = { workspaceId: input.workspaceId, vaultId, credentialId };
      const current = await input.store.find(location);
      if (!current || current.credential.archivedAt || current.credential.auth.type !== auth.type) throw new Error("Credential is unavailable");
      const result = await input.store.replace({ ...location, expectedRevision: current.revision,
        next: { ...current.credential, auth, updatedAt: timestamp } });
      if (result.type !== "replaced") throw new Error("Credential changed while authorizing; retry authorization");
      return credentialId;
    }
    const credential: Credential = { id: input.nextId(), vaultId, displayName, auth, createdAt: timestamp,
      updatedAt: timestamp, archivedAt: null, metadata: {} };
    await input.store.insert({ workspaceId: input.workspaceId, credential });
    return credential.id;
  };
  return {
    vaultExists,
    async authorizationSettings(vaultId, credentialId) {
      const record = await input.store.find({ workspaceId: input.workspaceId, vaultId, credentialId });
      const auth = record?.credential.auth;
      if (!record || record.credential.archivedAt || auth?.type !== "mcp_oauth") return null;
      return {
        scope: auth.scope ?? auth.refresh?.scope ?? undefined,
        clientId: auth.refresh?.clientId,
        clientSecret: auth.refresh?.tokenEndpointAuth.type === "none" ? undefined : auth.refresh?.tokenEndpointAuth.clientSecret ?? undefined,
      };
    },
    async saveGrant({ vaultId, credentialId, displayName, auth }) {
      if (!auth.access_token || !auth.mcp_server_url) throw new Error("OAuth grant is incomplete");
      return save(vaultId, displayName, { type: "mcp_oauth", mcpServerUrl: auth.mcp_server_url,
        accessToken: auth.access_token, expiresAt: auth.expires_at, scope: auth.scope,
        ...(auth.refresh_token && auth.token_endpoint && { refresh: {
          clientId: auth.client_id ?? "open-managed-agents", refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint, scope: auth.scope,
          tokenEndpointAuth: auth.client_secret ? { type: "client_secret_post", clientSecret: auth.client_secret } : { type: "none" },
        } }),
      }, credentialId);
    },
    async saveCliGrant({ vaultId, cliId, auth }) {
      if (!auth.token) throw new Error("CLI OAuth grant is incomplete");
      const id = await save(vaultId, `${cliId} (OAuth)`, { type: "cap_cli", cliId, token: auth.token,
        mcpServerUrl: auth.mcp_server_url ?? (cliId === "gh" ? "https://api.github.com" : undefined),
        extras: { ...auth.extras, ...(auth.expires_at && { expires_at: auth.expires_at }) },
      });
      const records = await listManagedVaultCredentials(input.store, input.workspaceId, [vaultId]);
      for (const record of records) {
        if (record.credential.id !== id && record.credential.auth.type === "cap_cli" && record.credential.auth.cliId === cliId) {
          await input.store.archive({ workspaceId: input.workspaceId, vaultId, credentialId: record.credential.id, archivedAt: new Date().toISOString() });
        }
      }
      return id;
    },
    async refresh(vaultId, credentialId) {
      if (!await vaultExists(vaultId)) throw new Error("Vault is unavailable");
      const current = await input.store.find({ workspaceId: input.workspaceId, vaultId, credentialId });
      if (!current || current.credential.archivedAt || current.credential.auth.type !== "mcp_oauth" || !current.credential.auth.refresh?.refreshToken) throw new Error("Credential cannot be refreshed");
      const result = await refreshManagedCredential(input.store, input.workspaceId, current);
      if (result.revision === current.revision) throw new Error("Token refresh failed");
      return { expires_at: result.credential.auth.type === "mcp_oauth" ? result.credential.auth.expiresAt : undefined };
    },
  };
}
