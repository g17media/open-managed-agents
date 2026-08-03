// resolveProxyTargetByTenant: server-name matching against the session's
// agent_snapshot. The harness transports the name in the x-oma-mcp-server
// header, whose value the Fetch spec whitespace-normalizes — so a stored
// name with edge whitespace ("dendrite ") arrives without it, and the
// match must trim both sides or every request 403s.

import { describe, it, expect } from "vitest";
import { resolveProxyTargetByTenant } from "../../packages/vault-forward/src/proxy";
import type { ProxyServices } from "../../packages/vault-forward/src/proxy";

const TENANT = "tn_test";
const SESSION = "sess_test";
const URL = "https://dendrite.example/mcp";

function makeServices(serverName: string): ProxyServices {
  return {
    sessions: {
      get: async () => ({
        id: SESSION,
        archived_at: null,
        vault_ids: ["vlt_1"],
        agent_snapshot: {
          mcp_servers: [{ name: serverName, type: "http", url: URL }],
        },
      }),
    },
    credentials: {
      listByVaults: async () => [
        {
          vault_id: "vlt_1",
          credentials: [
            {
              id: "cred_1",
              auth: { type: "static_bearer", mcp_server_url: URL, token: "tok_1" },
            },
          ],
        },
      ],
    },
  } as unknown as ProxyServices;
}

describe("resolveProxyTargetByTenant server-name matching", () => {
  it("matches a stored name with trailing whitespace against the header-normalized name", async () => {
    // Stored: "dendrite " — the header arrives as "dendrite".
    const target = await resolveProxyTargetByTenant(
      makeServices("dendrite "),
      TENANT,
      SESSION,
      "dendrite",
    );
    expect(target).toEqual({ upstreamUrl: URL, upstreamToken: "tok_1" });
  });

  it("matches an exact clean name", async () => {
    const target = await resolveProxyTargetByTenant(
      makeServices("dendrite"),
      TENANT,
      SESSION,
      "dendrite",
    );
    expect(target?.upstreamToken).toBe("tok_1");
  });

  it("returns null for an undeclared server name", async () => {
    const target = await resolveProxyTargetByTenant(
      makeServices("dendrite"),
      TENANT,
      SESSION,
      "axon",
    );
    expect(target).toBeNull();
  });

  it("does not conflate distinct names that trim to different values", async () => {
    const target = await resolveProxyTargetByTenant(
      makeServices("dendrite prod"),
      TENANT,
      SESSION,
      "dendrite",
    );
    expect(target).toBeNull();
  });
});
