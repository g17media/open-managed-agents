import { toEnvironmentConfig, type EnvironmentService } from "@open-managed-agents/environments-store";
import type { EnvironmentConfig } from "@open-managed-agents/shared";

/** Shared by ordinary sessions and manual/scheduled deployment launches. */
export function createEnvironmentSnapshotLoader(service: Pick<EnvironmentService, "get">) {
  return async (input: { tenantId: string; environmentId: string }): Promise<EnvironmentConfig> => {
    const row = await service.get(input);
    if (row) return toEnvironmentConfig(row);
    // Preserve the Node runtime's legacy synthetic environment support.
    return { id: input.environmentId, name: "Local runtime", config: { type: "local" }, created_at: new Date().toISOString() };
  };
}
