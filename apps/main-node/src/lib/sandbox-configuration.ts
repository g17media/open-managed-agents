import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import { startupEnabled } from "@open-managed-agents/sandbox/startup";
import type { SqlCredentialStore } from "@open-managed-agents/credential-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { RouteServices } from "@open-managed-agents/http-routes";
import type { Environment } from "@open-managed-agents/managed-agents-application";
import type { SandboxFactoryContext } from "@open-managed-agents/sandbox";

/** Resolve sandbox image and startup settings before provisioning. */
export function createSandboxConfiguration(deps: {
  sql: SqlClient;
  sessionsService: RouteServices["sessions"];
  credentialService: RouteServices["credentials"];
  environmentsService: NonNullable<RouteServices["environments"]>;
  nativeCredentials(): SqlCredentialStore;
  logger: NonNullable<RouteServices["logger"]>;
}) {
  const { sql, sessionsService, credentialService, environmentsService, nativeCredentials, logger } = deps;
  /**
   * Environment-level sandbox overrides: the session's environment may name
   * a custom `config.image` plus a vault credential (`image_registry_auth`)
   * to pull it from a private registry. The credential is resolved here,
   * control-plane-side, and handed to the adapter for the pull only — it
   * never enters the sandbox and is never persisted in any snapshot.
   */
  async function environmentImageOverrides(
    sessionId: string,
  ): Promise<Pick<SandboxFactoryContext, "image" | "registryAuth">> {
    try {
      const session = await sessionsService.getById({ sessionId });
      const envId = session?.environment_id;
      if (!session || !envId) return {};
      const env = await environmentsService.get({
        tenantId: session.tenant_id,
        environmentId: envId,
      });
      const image = env?.config?.image;
      if (!image) return {};
      const ref = env.config.image_registry_auth;
      if (!ref?.vault_id || !ref?.credential_id) return { image };
      const cred = await credentialService.get({
        tenantId: session.tenant_id,
        vaultId: ref.vault_id,
        credentialId: ref.credential_id,
      });
      if (!cred || cred.archived_at || cred.auth.type !== "container_registry") {
        // Don't fail provisioning — the pull can still succeed from the
        // engine's image cache or the belljar server's own fallback creds.
        logger.warn(
          {
            op: "main-node.image_registry_auth_unusable",
            session_id: sessionId,
            environment_id: envId,
            credential_id: ref.credential_id,
          },
          "environment's image_registry_auth credential is missing, archived, or not container_registry — pulling without credentials",
        );
        return { image };
      }
      return {
        image,
        registryAuth: cred.auth.token
          ? { identityToken: cred.auth.token, serveraddress: cred.auth.registry }
          : {
              username: cred.auth.username,
              password: cred.auth.password,
              serveraddress: cred.auth.registry,
            },
      };
    } catch (err) {
      logger.warn(
        { err, op: "main-node.environment_image_overrides_failed", session_id: sessionId },
        "environment image override resolution failed; using provider defaults",
      );
      return {};
    }
  }

  return async (sessionId: string, provider: string, managed?: { workspaceId: string; environment: Environment }) => {
    const session = managed ? null : await sessionsService.getById({ sessionId });
    const config = managed?.environment.config;
    const startupManaged = config?.type === "cloud" ? startupEnabled(config.startup) : startupEnabled(session?.environment_snapshot?.config?.startup);
    let overrides: Pick<SandboxFactoryContext, "image" | "registryAuth"> = {};
    if (provider === "belljar" && managed && config?.type === "cloud" && config.image) {
      overrides.image = config.image;
      if (config.imageRegistryAuth) {
        const ref = config.imageRegistryAuth;
        const vault = await new SqlVaultStore(sql).find({ workspaceId: managed.workspaceId, vaultId: ref.vaultId });
        const record = await nativeCredentials().find({ workspaceId: managed.workspaceId, vaultId: ref.vaultId, credentialId: ref.credentialId });
        if (!vault || vault.vault.archivedAt || !record || record.credential.archivedAt || record.credential.auth.type !== "container_registry") throw new Error("Environment registry credential is unavailable");
        const auth = record.credential.auth;
        overrides.registryAuth = auth.token ? { identityToken: auth.token, serveraddress: auth.registry }
          : { username: auth.username ?? undefined, password: auth.password ?? undefined, serveraddress: auth.registry };
      }
    } else if (!managed && provider === "belljar") overrides = await environmentImageOverrides(sessionId);
    if (startupManaged && provider !== "belljar") throw new Error("Startup scripts require the Belljar sandbox provider");
    if (startupManaged && !process.env.BELLJAR_TOKEN) throw new Error("Startup scripts require BELLJAR_TOKEN for authenticated lifecycle callbacks");
    return { startupManaged, ...overrides };
  };
}
