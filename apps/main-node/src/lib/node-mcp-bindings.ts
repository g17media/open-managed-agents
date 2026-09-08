import { resolveProxyTargetByTenant, forwardWithRefresh } from "@open-managed-agents/vault-forward/proxy";
import { forwardManagedMcpRequest } from "@open-managed-agents/vault-forward/managed";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { RouteServices } from "@open-managed-agents/http-routes";
import type { SessionExecutionContextSourcePort } from "@open-managed-agents/session-runtime-contract/context";

/** In-process counterparts of the Cloudflare MCP service binding. */
export function createNodeMcpBindings(deps: {
  sql: SqlClient;
  legacy: Pick<RouteServices, "sessions" | "credentials">;
  execution(): SessionExecutionContextSourcePort;
  nativeCredentials(): Parameters<typeof forwardManagedMcpRequest>[0]["credentials"];
}) {
  const { sql, legacy, execution, nativeCredentials } = deps;
  const mcpProxyServices = legacy;

  async function mcpBindingFetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return new Response(
        '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const target = await resolveProxyTargetByTenant(
      mcpProxyServices,
      tenantId,
      sessionId,
      serverName,
    );
    if (!target) {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardWithRefresh(
      mcpProxyServices,
      tenantId,
      target,
      request.method,
      inboundHeaders,
      body,
      { sessionId, serverName, callerKind: "rpc-mcp" },
    );
  }

  async function managedMcpBindingFetch(request: Request): Promise<Response> {
    const workspaceId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!workspaceId || !sessionId || !serverName) return new Response("Missing session attribution", { status: 400 });
    const context = await execution().find({ workspaceId, sessionId });
    if (!context) return new Response("Forbidden", { status: 403 });
    const vaultIds = [];
    const vaults = new SqlVaultStore(sql);
    for (const vaultId of context.session.vaultIds) {
      const record = await vaults.find({ workspaceId, vaultId });
      if (record?.vault.archivedAt === null) vaultIds.push(vaultId);
    }
    return forwardManagedMcpRequest({ request, workspaceId, session: { ...context.session, vaultIds }, serverName, credentials: nativeCredentials() });
  }

  return { mcpBindingFetch, managedMcpBindingFetch };
}
