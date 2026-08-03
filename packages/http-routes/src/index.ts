// Public surface — every mount factory and the shared types.
//
// CF + Node both `import { buildXxxRoutes, type RouteServices } from
// "@open-managed-agents/http-routes"`, build their services bundle, and
// mount the routes under the same paths.

export type {
  RouteServices,
  RouteServicesArg,
  EventStreamHub,
  BackgroundRunner,
  SessionRegistryLike,
} from "./types";
export { resolveServices } from "./types";

export { buildAgentRoutes } from "./agents";
export type { AgentRoutesDeps } from "./agents";

export { buildVaultRoutes } from "./vaults";
export type { VaultRoutesDeps } from "./vaults";

export { buildModelCardRoutes } from "./model-cards";
export { modelCardProbeUrl } from "./model-cards";
export type { ModelCardRoutesDeps } from "./model-cards";

export { buildEnvironmentRoutes } from "./environments";
export type { EnvironmentRoutesDeps } from "./environments";

export { buildSessionRoutes } from "./sessions";
export type {
  SessionRoutesDeps,
  SessionLifecycleHooks,
  OutputsAdapter,
} from "./sessions";

export { buildMemoryRoutes } from "./memory";
export type { MemoryRoutesDeps } from "./memory";

export { buildDreamRoutes } from "./dreams";
export type { DreamRoutesDeps } from "./dreams";

export { buildDeploymentRoutes, runDeployment, deploymentsTick } from "./deployments";
export type {
  DeploymentRoutesDeps,
  DeploymentRunContext,
  DeploymentRunServices,
  DeploymentsTickDeps,
  DeploymentsTickShard,
} from "./deployments";

export { buildTenantRoutes, buildMeRoutes } from "./tenants";
export type { TenantRoutesDeps, MeRoutesDeps } from "./tenants";

export {
  buildApiKeyRoutes,
  mintApiKeyOnStorage,
  sha256Hex,
} from "./api-keys";
export type {
  ApiKeyRoutesDeps,
  ApiKeyStorage,
  ApiKeyRecord,
  ApiKeyMeta,
} from "./api-keys";

export { buildEvalRoutes } from "./evals";
export type { EvalRoutesDeps, EvalTaskSpec } from "./evals";

export { buildModelsRoutes } from "./models";

export { buildSkillRoutes } from "./skills";
export type { SkillRoutesDeps } from "./skills";
export { buildSkillGitHubRoutes } from "./skills/github";
export type { GitHubSource } from "./skills/github";

export { buildStatsRoutes } from "./stats";
export type { StatsRoutesDeps } from "./stats";

export { buildClawhubRoutes } from "./clawhub";
export type { ClawhubRoutesDeps } from "./clawhub";

export { buildOAuthRoutes } from "./oauth";
export type { OAuthRoutesDeps } from "./oauth";

export { buildCapCliOauthRoutes } from "./cap-cli-oauth";
export type { CapCliOauthRoutesDeps } from "./cap-cli-oauth";

export { kvKey, kvPrefix, kvListAll } from "./lib/kv-helpers";

export { jsonPage, parsePageQuery } from "./lib/list-page";
export type { PageQuery } from "./lib/list-page";
export { validateAgentLimits, validateEnvironmentLimits } from "./lib/limits";
export type {
  ValidationResult,
  AgentLimitsInput,
  EnvironmentLimitsInput,
} from "./lib/limits";

export { buildIntegrationsRoutes } from "./integrations";
export type {
  IntegrationsRoutesDeps,
  IntegrationsBags,
  IntegrationsRepoBag,
  InstallProxyForwarder,
} from "./integrations";

export { buildIntegrationsGatewayRoutes } from "./integrations/gateway";
export type {
  IntegrationsGatewayDeps,
  WebhookHandler,
  WebhookHandlers,
  RateLimitHooks,
} from "./integrations/gateway";
