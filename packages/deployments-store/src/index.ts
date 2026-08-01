// Public surface of @open-managed-agents/deployments-store.
//
//   - types       : domain DTOs + trigger enum
//   - errors      : typed errors for the route layer to map → HTTP status
//   - ports       : abstract deps (DeploymentRepo, Clock, IdGenerator)
//   - service     : DeploymentService (pure business logic + cron bookkeeping)
//   - adapters    : Cloudflare D1 + SqlClient factories

export * from "./types";
export * from "./errors";
export * from "./ports";
export { DeploymentService, nextRunFromCron } from "./service";
export type { DeploymentServiceDeps } from "./service";
export {
  SqlDeploymentRepo,
  createCfDeploymentService,
  createSqliteDeploymentService,
} from "./adapters";
