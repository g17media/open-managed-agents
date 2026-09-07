import type { EnvironmentStartupConfig, SandboxStartupEvent, SandboxStartupTrigger } from "@open-managed-agents/shared";
import type { SandboxExecutor } from "./ports";

export const STARTUP_TRIGGERS: SandboxStartupTrigger[] = ["create", "wake", "revive"];

export function startupEnabled(config?: EnvironmentStartupConfig): boolean {
  return !!config && config.enabled !== false && (config.triggers ?? STARTUP_TRIGGERS).length > 0;
}

/** OMA executes initialization using exactly the adapter's normal command environment. */
export async function runStartupScript(input: {
  sandbox: SandboxExecutor;
  config?: EnvironmentStartupConfig;
  bootId: string;
  trigger: SandboxStartupTrigger;
  prepare(): Promise<void>;
  emit(event: SandboxStartupEvent): Promise<void>;
}): Promise<void> {
  const { config, sandbox, bootId, trigger, emit } = input;
  const base = { type: "session.sandbox_startup" as const, boot_id: bootId, trigger };
  if (!startupEnabled(config) || !(config!.triggers ?? STARTUP_TRIGGERS).includes(trigger)) {
    // Resource preparation still belongs to OMA even when this particular
    // startup trigger is unchecked (e.g. create disabled, wake enabled).
    try {
      await input.prepare();
      await emit({ ...base, status: "skipped" });
    } catch (error) {
      await emit({ ...base, status: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return;
  }
  if (!sandbox.execResult) throw new Error("Sandbox provider does not support startup execution");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config!.script));
  const script_sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  const started = Date.now();
  const fields = { ...base, script_sha256 };
  await emit({ ...fields, status: "running" });
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  try {
    await input.prepare();
    await sandbox.setEnvVars?.({ OMA_LIFECYCLE_EVENT: trigger, OMA_BOOT_ID: bootId });
    const mkdir = await sandbox.execResult("mkdir -p /tmp/oma-startup", 15_000);
    if (mkdir.exitCode !== 0) throw new Error(mkdir.stderr || "Cannot prepare startup script directory");
    // Only an execution copy. The authoritative script is in the session snapshot.
    const path = `/tmp/oma-startup/${script_sha256}.sh`;
    await sandbox.writeFile(path, config!.script);
    const result = await sandbox.execResult(`/bin/bash -e -o pipefail ${path}`, (config!.timeout_seconds ?? 120) * 1000);
    stdout = result.stdout.slice(-16_384);
    stderr = result.stderr.slice(-16_384);
    exitCode = result.exitCode;
    if (exitCode !== 0) throw new Error(`Startup script exited with code ${exitCode}`);
    await emit({ ...fields, status: "succeeded", duration_ms: Date.now() - started, exit_code: 0, stdout, stderr });
  } catch (error) {
    await emit({ ...fields, status: "failed", duration_ms: Date.now() - started, exit_code: exitCode,
      stdout, stderr, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
