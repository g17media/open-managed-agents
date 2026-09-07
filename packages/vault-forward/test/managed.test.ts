import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import type { Session } from "@open-managed-agents/domain/sessions";
import { forwardManagedMcpRequest, matchManagedRepositoryResource } from "../src/managed";

const session: Session = {
  id: "session_test", archivedAt: null, environmentId: "env_test", vaultIds: ["vault_test"],
  agent: { id: "agent_test", name: "Agent", version: 1, model: { id: "test" }, description: null, multiagent: null,
    system: null, tools: [], skills: [], mcpServers: [{ type: "url", name: " mcp ", url: "https://example.com/mcp" }] },
  status: "running", createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", title: null,
  budget: null, metadata: {}, resources: [], stats: {}, usage: {}, outcomeEvaluations: [],
};

describe("native vault forwarding", () => {
  it("injects only the current session's vaults and preserves MCP headers while stripping internal metadata", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.insert({ workspaceId: "workspace_test", credential: {
      id: "credential_test", vaultId: "vault_test", auth: { type: "static_bearer", token: "secret", mcpServerUrl: "https://example.com/mcp" },
      metadata: {}, createdAt: session.createdAt, updatedAt: session.updatedAt, archivedAt: null,
    } });
    const request = () => new Request("https://example.com/mcp", { method: "POST", body: '{"method":"tools/list"}',
      headers: { "x-oma-tenant": "workspace_test", "x-oma-session": session.id, "x-oma-mcp-server": "mcp", "authorization": "Bearer placeholder", "Mcp-Session-Id": "mcp-session" } });
    const calls: Headers[] = [];
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push(new Headers(init?.headers));
      expect(init?.redirect).toBe("manual");
      return new Response("ok", { headers: { "Mcp-Session-Id": "rotated-session" } });
    });
    const response = await forwardManagedMcpRequest({ workspaceId: "workspace_test", credentials, session, serverName: "mcp", request: request(), fetch: upstream });
    expect(response.headers.get("Mcp-Session-Id")).toBe("rotated-session");
    expect(calls[0]?.get("authorization")).toBe("Bearer secret");
    expect(calls[0]?.get("Mcp-Session-Id")).toBe("mcp-session");
    expect([...calls[0]!.keys()].filter((key) => key.startsWith("x-oma-"))).toEqual([]);
    await forwardManagedMcpRequest({ workspaceId: "workspace_test", credentials, session: { ...session, vaultIds: [] }, serverName: "mcp", request: request(), fetch: upstream });
    expect(calls[1]?.has("authorization")).toBe(false);
    await forwardManagedMcpRequest({ workspaceId: "other_workspace", credentials, session, serverName: "mcp", request: request(), fetch: upstream });
    expect(calls[2]?.has("authorization")).toBe(false);
    expect((await forwardManagedMcpRequest({ workspaceId: "workspace_test", credentials, session, serverName: "undeclared", request: request(), fetch: upstream })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("limits repository resource tokens to the declared repository", () => {
    const withRepo: Session = { ...session, resources: [{ id: "resource_test", type: "github_repository", createdAt: session.createdAt,
      updatedAt: session.updatedAt, url: "https://github.com/team/repo.git", mountPath: "/workspace/repo" }] };
    for (const url of ["https://github.com/team/repo.git/info/refs?service=git-upload-pack", "https://github.com/team/repo/git-upload-pack", "https://api.github.com/repos/team/repo/issues"]) {
      expect(matchManagedRepositoryResource(withRepo, url)).toMatchObject({ id: "resource_test" });
    }
    for (const url of ["https://github.com/team/other.git/info/refs", "https://api.github.com/user", "https://github.com.attacker.test/team/repo.git/info/refs"]) {
      expect(matchManagedRepositoryResource(withRepo, url)).toBeUndefined();
    }
  });
});
