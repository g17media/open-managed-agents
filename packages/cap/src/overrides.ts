// Per-deployment overrides for builtin specs.
//
// Spec modules are static data; values that differ per deployment (a
// registered OAuth client_id, an internal metadata host, a tenant-specific
// scope) are merged in here at registry-construction time. Cap stays
// runtime-agnostic: the caller hands in its env map (Workers `env`,
// `process.env`), nothing is read from the environment directly.

import type { CapSpec, OAuthDeviceFlowSpec } from "./types";

export interface CapSpecOverride {
  readonly endpoints?: readonly string[];
  readonly oauth?: { readonly device_flow?: Partial<OAuthDeviceFlowSpec> };
}

/** Merges per-cli_id overrides onto builtin specs. Unmatched specs pass through unchanged. */
export function applyCapOverrides(
  specs: readonly CapSpec[],
  overrides: Readonly<Record<string, CapSpecOverride>>,
): CapSpec[] {
  return specs.map((spec) => {
    const o = overrides[spec.cli_id];
    if (!o) return spec;
    return {
      ...spec,
      ...(o.endpoints ? { endpoints: o.endpoints } : {}),
      ...(o.oauth?.device_flow && spec.oauth
        ? { oauth: { device_flow: { ...spec.oauth.device_flow, ...o.oauth.device_flow } } }
        : {}),
    };
  });
}

/**
 * Reads CAP_OVERRIDE_<CLI_ID>_{ENDPOINTS,CLIENT_ID,SCOPES,INITIATE_URL,TOKEN_URL}
 * for each known cli_id (uppercased, e.g. "feedforward" →
 * CAP_OVERRIDE_FEEDFORWARD_*). ENDPOINTS and SCOPES are space-separated.
 * Only known cli_ids are scanned, so an unrelated env var can never create
 * an override for a spec that does not exist.
 */
export function parseCapOverridesFromEnv(
  knownCliIds: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, CapSpecOverride> {
  const out: Record<string, CapSpecOverride> = {};
  for (const cliId of knownCliIds) {
    const prefix = `CAP_OVERRIDE_${cliId.toUpperCase()}_`;
    const endpoints = splitList(env[`${prefix}ENDPOINTS`]);
    const clientId = trimmed(env[`${prefix}CLIENT_ID`]);
    const initiateUrl = trimmed(env[`${prefix}INITIATE_URL`]);
    const tokenUrl = trimmed(env[`${prefix}TOKEN_URL`]);
    const scopes = splitList(env[`${prefix}SCOPES`]);
    const deviceFlow: Partial<OAuthDeviceFlowSpec> = {
      ...(clientId ? { client_id: clientId } : {}),
      ...(initiateUrl ? { initiate_url: initiateUrl } : {}),
      ...(tokenUrl ? { token_url: tokenUrl } : {}),
      ...(scopes ? { scopes } : {}),
    };
    const hasDeviceFlow = Object.keys(deviceFlow).length > 0;
    if (!endpoints && !hasDeviceFlow) continue;
    out[cliId] = {
      ...(endpoints ? { endpoints } : {}),
      ...(hasDeviceFlow ? { oauth: { device_flow: deviceFlow } } : {}),
    };
  }
  return out;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  const items = value?.trim().split(/\s+/).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}
