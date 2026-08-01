// Adapter wiring for the deployments-store. CF (D1) and self-host (any
// SqlClient) share the same SqlDeploymentRepo class.

export { SqlDeploymentRepo } from "./sql-deployment-repo";

import { SqlDeploymentRepo } from "./sql-deployment-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { DeploymentService, type DeploymentServiceDeps } from "../service";

type VerifyDeps = Pick<DeploymentServiceDeps, "verifyAgentExists">;

/** CF deployment factory. The agent existence check is a callback to avoid
 *  a dependency cycle with agents-store — same pattern as dreams-store. */
export function createCfDeploymentService(
  deps: { db: D1Database } & VerifyDeps,
): DeploymentService {
  const sql = new CfD1SqlClient(deps.db);
  return new DeploymentService({
    repo: new SqlDeploymentRepo(sql),
    verifyAgentExists: deps.verifyAgentExists,
  });
}

/** Self-host / SQLite / Postgres factory. Same shape, different SqlClient. */
export function createSqliteDeploymentService(
  deps: { client: SqlClient } & VerifyDeps,
): DeploymentService {
  return new DeploymentService({
    repo: new SqlDeploymentRepo(deps.client),
    verifyAgentExists: deps.verifyAgentExists,
  });
}
