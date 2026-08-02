// Environment networking limits as enforced by the oma-vault proxy —
// apps/oma-vault/src/egress-policy.ts. The DB plumbing (session →
// environment → config.networking) lives in apps/oma-vault/src/index.ts;
// this covers the policy semantics, which mirror the web_fetch tool's
// in-harness check (exact hostname or subdomain suffix).

import { describe, it, expect } from "vitest";
import {
  evaluateEgress,
  PACKAGE_MANAGER_HOSTS,
} from "../../apps/oma-vault/src/egress-policy";

describe("evaluateEgress", () => {
  it("allows everything when there is no policy", () => {
    expect(evaluateEgress("evil.example.com", null)).toBeNull();
    expect(evaluateEgress("evil.example.com", undefined)).toBeNull();
  });

  it("allows everything for unrestricted networking", () => {
    expect(evaluateEgress("anything.dev", { type: "unrestricted" })).toBeNull();
    // Unknown/absent type is treated as unrestricted, matching web_fetch.
    expect(evaluateEgress("anything.dev", {})).toBeNull();
  });

  it("limited: allows exact hostname matches", () => {
    const policy = { type: "limited", allowed_hosts: ["api.github.com"] };
    expect(evaluateEgress("api.github.com", policy)).toBeNull();
    expect(evaluateEgress("github.com", policy)).not.toBeNull();
    expect(evaluateEgress("example.com", policy)).not.toBeNull();
  });

  it("limited: allows subdomains of an allowed host", () => {
    const policy = { type: "limited", allowed_hosts: ["github.com"] };
    expect(evaluateEgress("api.github.com", policy)).toBeNull();
    expect(evaluateEgress("github.com", policy)).toBeNull();
    // Suffix must be on a label boundary — no "evilgithub.com".
    expect(evaluateEgress("evilgithub.com", policy)).not.toBeNull();
  });

  it("limited: is case-insensitive and ignores a trailing dot", () => {
    const policy = { type: "limited", allowed_hosts: ["API.GitHub.com"] };
    expect(evaluateEgress("api.github.COM", policy)).toBeNull();
    expect(evaluateEgress("api.github.com.", policy)).toBeNull();
  });

  it("limited with no allowed_hosts denies everything", () => {
    expect(evaluateEgress("example.com", { type: "limited" })).not.toBeNull();
    expect(evaluateEgress("example.com", { type: "limited", allowed_hosts: [] })).not.toBeNull();
  });

  it("allow_package_managers admits the registries and nothing else", () => {
    const policy = { type: "limited", allowed_hosts: [], allow_package_managers: true };
    for (const host of PACKAGE_MANAGER_HOSTS) {
      expect(evaluateEgress(host, policy)).toBeNull();
    }
    expect(evaluateEgress("registry.npmjs.org", policy)).toBeNull();
    expect(evaluateEgress("example.com", policy)).not.toBeNull();
    // Off (default) means registries are subject to allowed_hosts like
    // any other destination.
    expect(
      evaluateEgress("registry.npmjs.org", { type: "limited", allowed_hosts: [] }),
    ).not.toBeNull();
  });

  it("denial message names the host and the allowlist", () => {
    const denial = evaluateEgress("evil.dev", {
      type: "limited",
      allowed_hosts: ["api.github.com"],
      allow_package_managers: true,
    });
    expect(denial).toContain('"evil.dev"');
    expect(denial).toContain("api.github.com");
    expect(denial).toContain("package managers");
  });
});
