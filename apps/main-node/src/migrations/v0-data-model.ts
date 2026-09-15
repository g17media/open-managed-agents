import type { Agent, Environment, CredentialAuth } from "@open-managed-agents/managed-agents-application";

// Historical JSON has several shapes. Validate at the conversion boundary;
// never pass an unrecognised setting through as if the new runtime supported it.
export type Legacy = Record<string, any>;
export const MIGRATION_ID = "20260907-v0-data-to-v1-sqlite-1";

export function object(value: unknown, label: string): Legacy {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}: expected an object`);
  return parsed as Legacy;
}

export function array(value: unknown, label: string): any[] {
  if (value == null) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label}: expected an array`);
  return parsed;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`${label}: expected a nonempty string`);
  return value;
}

export function milliseconds(value: unknown, label: string): number {
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Date.parse(String(value));
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}: invalid timestamp`);
  return result;
}

export function iso(value: unknown, label = "timestamp"): string {
  return new Date(milliseconds(value, label)).toISOString();
}

export function metadata(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(value == null ? {} : object(value, "metadata"))
    .map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)]));
}

export function camel(value: unknown, opaque = false): any {
  if (opaque) return structuredClone(value);
  if (Array.isArray(value)) return value.map((item) => camel(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase()),
    camel(item, ["input", "input_schema", "metadata", "providerOptions", "provider_options", "custom_headers", "extras"].includes(key)),
  ]));
}

export function environment(row: Legacy): Environment {
  const config = object(row.config ?? { type: "cloud" }, `Environment ${row.id}`);
  if (!["cloud", "self_hosted"].includes(config.type)) throw new Error(`Environment ${row.id}: unsupported type`);
  const converted = camel(config);
  if (config.type === "cloud") {
    converted.packages = Object.fromEntries(["apt", "cargo", "gem", "go", "npm", "pip"].map((name) => [name, array(config.packages?.[name], `Environment ${row.id} packages`)]));
    const networking = config.networking ?? { type: "unrestricted" };
    if (networking.type === "limited") converted.networking = {
      type: "limited", allowedHosts: array(networking.allowed_hosts, "allowed hosts"),
      allowMcpServers: networking.allow_mcp_servers ?? false,
      allowPackageManagers: networking.allow_package_managers ?? false,
    };
    else if (networking.type === "unrestricted") converted.networking = { type: "unrestricted" };
    else throw new Error(`Environment ${row.id}: unsupported networking policy`);
  }
  return {
    id: string(row.id, "environment ID"), name: string(row.name, "environment name"),
    description: row.description ?? null, config: converted,
    metadata: metadata(row.metadata), createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at), archivedAt: row.archived_at == null ? null : iso(row.archived_at),
  };
}

/** Built-in tools a v1 agent toolset can carry. The config name is the discriminator. */
export const TOOLSET_TOOL_NAMES = ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"];

export function agent(row: Legacy, config: Legacy, resolveSkill: (binding: Legacy) => Agent["skills"][number], versions: Map<string, number>, warn?: (message: string) => void): Agent {
  for (const key of ["aux_model", "aux_model_card_id", "runtime_binding", "appendable_prompts", "_oma"]) {
    if (config[key] != null) throw new Error(`Agent ${row.id}: ${key} requires an explicit migration mapping`);
  }
  if (config.enable_general_subagent === true || (config.harness && config.harness !== "default")) {
    throw new Error(`Agent ${row.id}: custom harness/general-subagent configuration requires an explicit migration mapping`);
  }
  if (config.model_card_id) throw new Error(`Agent ${row.id}: explicit model_card_id requires an explicit model binding migration`);
  const model = typeof config.model === "string" ? { id: config.model } : object(config.model, `Agent ${row.id} model`);
  const effort = model.effort?.type ?? model.effort ?? model.reasoning;
  if (effort != null && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Agent ${row.id}: unsupported model effort`);
  const tools = array(config.tools, "agent tools").map((raw) => {
    const tool = camel(raw);
    if (raw.type === "custom") return tool;
    if (!["agent_toolset_20260401", "mcp_toolset"].includes(raw.type)) throw new Error(`Agent ${row.id}: unsupported tool type ${raw.type}`);
    const defaults = { enabled: raw.default_config?.enabled ?? true, permissionPolicy: raw.default_config?.permission_policy ?? { type: "always_allow" } };
    if (!["always_allow", "always_ask"].includes(defaults.permissionPolicy.type)) throw new Error(`Agent ${row.id}: unsupported tool permission`);
    return { ...tool, defaultConfig: defaults, configs: array(raw.configs, "tool configs").flatMap((item) => {
      // The toolset discriminator is the config name, so a v0 built-in that v1
      // dropped would otherwise be written as a tool type no reader accepts.
      if (raw.type === "agent_toolset_20260401" && !TOOLSET_TOOL_NAMES.includes(item.name)) {
        warn?.(`Agent ${row.id}: dropped ${item.enabled ?? defaults.enabled ? "enabled" : "disabled"} tool ${item.name}, which has no v1 equivalent.`);
        return [];
      }
      return [{
        ...camel(item), ...(raw.type === "agent_toolset_20260401" && { type: item.name }),
        enabled: item.enabled ?? defaults.enabled, permissionPolicy: item.permission_policy ?? defaults.permissionPolicy,
      }];
    }) };
  });
  const roster = config.multiagent?.agents ?? config.callable_agents ?? [];
  const multiagent = roster.length ? { type: "coordinator" as const, agents: array(roster, "agent roster").map((entry) => {
    if (entry.type === "advisor") return { type: "advisor" as const, model: string(entry.model, "advisor model") };
    const id = typeof entry === "string" ? entry : entry.type === "self" ? row.id : entry.id ?? entry.agent_id;
    const version = entry.version ?? versions.get(id);
    if (!version) throw new Error(`Agent ${row.id}: unresolved callable agent ${id}`);
    return { type: "agent" as const, agentId: id, version };
  }) } : null;
  return {
    id: string(row.id, "agent ID"), name: string(config.name, "agent name"), version: Number(row.version ?? config.version ?? 1),
    description: config.description ?? null, system: config.system ?? null, metadata: metadata(config.metadata),
    model: { id: string(model.id, "model ID"), ...(effort && { effort }), ...(model.speed && { speed: model.speed }), ...(model.inference_geo && { inferenceGeo: model.inference_geo }) },
    tools, mcpServers: array(config.mcp_servers, "MCP servers").map((server) => {
      if (server.type != null && !["url", "sse", "http"].includes(server.type)) throw new Error(`Agent ${row.id}: unsupported MCP transport`);
      return { type: "url" as const, name: string(server.name, "MCP name").trim(), url: string(server.url, "MCP URL") };
    }),
    skills: array(config.skills, "agent skills").map(resolveSkill), multiagent,
    createdAt: iso(row.created_at ?? config.created_at), updatedAt: iso(row.updated_at ?? config.updated_at ?? row.created_at),
    archivedAt: row.archived_at == null ? null : iso(row.archived_at),
  };
}

export function credentialAuth(raw: Legacy): CredentialAuth {
  if (raw.type === "static_bearer" || raw.type === "container_registry" || raw.type === "cap_cli") return camel(raw);
  if (raw.type === "mcp_oauth") {
    const refresh = raw.refresh ?? (raw.token_endpoint && raw.client_id ? {
      client_id: raw.client_id, token_endpoint: raw.token_endpoint, refresh_token: raw.refresh_token ?? null,
      token_endpoint_auth: raw.client_secret ? { type: "client_secret_post", client_secret: raw.client_secret } : { type: "none" },
      ...(raw.resource && { resource: raw.resource }), ...(raw.scope && { scope: raw.scope }),
    } : null);
    return { type: "mcp_oauth", mcpServerUrl: string(raw.mcp_server_url, "OAuth server URL"),
      accessToken: raw.access_token ?? null, ...(raw.expires_at != null && { expiresAt: iso(raw.expires_at) }),
      ...(raw.scope && { scope: raw.scope }), refresh: refresh ? camel(refresh) : null };
  }
  if (raw.type === "environment_variable") return camel(raw);
  throw new Error(`Unsupported credential type ${raw.type}`);
}
