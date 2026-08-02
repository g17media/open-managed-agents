// Environment networking limits, enforced at the vault.
//
// EnvironmentConfig.config.networking (packages/api-types) mirrors the
// Managed Agents API's environment networking config:
//
//   networking?: {
//     type: "unrestricted" | "limited";
//     allowed_hosts?: string[];
//     allow_mcp_servers?: boolean;
//     allow_package_managers?: boolean;
//   }
//
// Until now the only enforcement was the web_fetch tool's in-harness
// hostname check (apps/agent/src/harness/tools.ts) — advisory, since
// anything running in the sandbox shell bypasses it. On self-host the
// vault proxy is the sandbox's sole egress (kernel-enforced when belljar
// isolation is on), which makes it the right place to enforce the policy
// for real: every outbound request is attributed to a session, the
// session names its environment, the environment names its policy.
//
// Notes on fidelity:
//  - allowed_hosts matches exact hostname or any subdomain, same as
//    web_fetch (`host === h || host.endsWith("." + h)`).
//  - allow_package_managers admits the well-known registries below.
//  - allow_mcp_servers is NOT enforced here: on self-host, MCP calls run
//    from the main-node process and never traverse the vault proxy.
//  - Attribution rides in-band (proxy auth). A sandbox that strips it
//    becomes "unattributed", which OMA_VAULT_UNATTRIBUTED_EGRESS governs
//    (default "allow" for compat; set "deny" + OMA_VAULT_PROXY_KEY for a
//    real lockdown). belljar's own egressAllow remains the network-layer
//    backstop.

export interface NetworkingPolicy {
  type?: string;
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

/** Registries the standard package managers talk to (pip, npm, apt on
 *  debian/ubuntu, cargo, gem, go). Subdomains match too. */
export const PACKAGE_MANAGER_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "rubygems.org",
  "proxy.golang.org",
  "sum.golang.org",
  "index.golang.org",
];

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

/**
 * Evaluate a request hostname against an environment networking policy.
 * Returns null when allowed, or a human-readable denial reason.
 * No policy / "unrestricted" always allows.
 */
export function evaluateEgress(
  hostname: string,
  networking: NetworkingPolicy | null | undefined,
): string | null {
  if (!networking || networking.type !== "limited") return null;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const allowedHosts = networking.allowed_hosts ?? [];
  if (allowedHosts.some((h) => hostMatches(host, h.toLowerCase()))) return null;
  if (
    networking.allow_package_managers === true &&
    PACKAGE_MANAGER_HOSTS.some((h) => hostMatches(host, h))
  ) {
    return null;
  }
  return (
    `host "${host}" is not allowed by this session's environment networking ` +
    `policy (limited; allowed: ${allowedHosts.length > 0 ? allowedHosts.join(", ") : "none"}` +
    `${networking.allow_package_managers ? " + package managers" : ""})`
  );
}
