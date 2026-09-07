import type { EnvironmentStartupConfig, SandboxStartupTrigger } from "@open-managed-agents/api-types";

const triggers: Array<{ value: SandboxStartupTrigger; label: string; description: string }> = [
  { value: "create", label: "On creation", description: "A fresh sandbox and workspace" },
  { value: "wake", label: "On wake", description: "The existing stopped container starts again" },
  { value: "revive", label: "On revival", description: "A replacement container starts with the retained workspace" },
];

export function StartupScriptEditor({ value, onChange }: {
  value?: EnvironmentStartupConfig;
  onChange(value: EnvironmentStartupConfig): void;
}) {
  const config = value ?? { script: "", enabled: false };
  const selected = config.triggers ?? triggers.map((t) => t.value);
  const update = (patch: Partial<EnvironmentStartupConfig>) => onChange({ ...config, ...patch });
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={config.enabled !== false} onChange={(e) => update({ enabled: e.target.checked })} />
        Enable startup script
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-fg">Run when</legend>
        {triggers.map((trigger) => (
          <label key={trigger.value} className="flex items-start gap-2 text-sm text-fg">
            <input className="mt-1" type="checkbox" checked={selected.includes(trigger.value)} onChange={(e) => update({
              triggers: e.target.checked ? [...selected, trigger.value] : selected.filter((t) => t !== trigger.value),
            })} />
            <span>{trigger.label}<span className="block text-xs text-fg-muted">{trigger.description}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm font-medium text-fg">
        Bash script
        <textarea aria-label="Bash script" className="mt-2 w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-fg"
          rows={12} spellCheck={false} value={config.script} onChange={(e) => update({ script: e.target.value })}
          placeholder={'mkdir -p /workspace/cache\necho "Starting: $OMA_LIFECYCLE_EVENT"'} />
      </label>
      <label className="flex items-center gap-3 text-sm text-fg">
        Timeout (seconds)
        <input aria-label="Startup timeout (seconds)" className="w-24 rounded-md border border-border bg-bg px-2 py-1" type="number"
          min={1} max={600} value={config.timeout_seconds ?? 120} onChange={(e) => update({ timeout_seconds: Number(e.target.value) })} />
      </label>
      <p className="text-xs text-fg-muted">OMA runs this in /workspace after preparing attached resources, with the sandbox’s proxy and certificate settings. Saving applies to new sessions. Existing sessions keep their saved script and triggers.</p>
    </div>
  );
}
