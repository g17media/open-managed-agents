// Typed errors emitted by DeploymentService. The route layer maps these
// onto HTTP statuses; nothing else should reach 5xx.

export class DeploymentNotFoundError extends Error {
  readonly code = "deployment_not_found";
  constructor(message = "Deployment not found") {
    super(message);
  }
}

/** Input validation — missing required field, bad cron, over-long text. */
export class DeploymentInvalidInputError extends Error {
  readonly code = "deployment_invalid_input";
  constructor(message: string) {
    super(message);
  }
}

/** The referenced agent doesn't exist for this tenant. */
export class DeploymentAgentMissingError extends Error {
  readonly code = "deployment_agent_missing";
  constructor(public agentId: string) {
    super(`agent not found: ${agentId}`);
  }
}
