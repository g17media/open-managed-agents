import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SandboxStartupEvent } from "@open-managed-agents/api-types";

export function StartupStatus({ events, onRetry }: {
  events: Array<{ type: string }>;
  onRetry(): Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const event = [...events].reverse().find((e) => e.type === "session.sandbox_startup") as SandboxStartupEvent | undefined;
  if (!event) return null;
  return (
    <details className="mx-4 mt-3 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-fg" open={event.status === "failed" || undefined}>
      <summary className="cursor-pointer">Startup script · {event.trigger} · {event.status}
        {event.duration_ms !== undefined && <span className="ml-2 text-fg-muted">{(event.duration_ms / 1000).toFixed(1)}s</span>}
      </summary>
      <div className="mt-2 space-y-2">
        {event.message && <p className="text-danger">{event.message}</p>}
        {event.exit_code !== undefined && <p className="text-xs text-fg-muted">Exit code: {event.exit_code}</p>}
        {(event.stdout || event.stderr) && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{[event.stdout, event.stderr].filter(Boolean).join("\n")}</pre>}
        {event.status === "running" && <p className="text-xs text-fg-muted">Preparing the sandbox. Agent commands will continue when startup finishes.</p>}
        {event.status === "skipped" && <p className="text-xs text-fg-muted">This lifecycle trigger is disabled for this session.</p>}
        {event.status === "failed" && <Button size="sm" disabled={retrying} onClick={async () => {
          setRetrying(true);
          try { await onRetry(); } catch { /* API client displays the error. */ } finally { setRetrying(false); }
        }}>{retrying ? "Retrying…" : "Retry startup"}</Button>}
      </div>
    </details>
  );
}
