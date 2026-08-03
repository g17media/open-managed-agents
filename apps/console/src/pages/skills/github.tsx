import { useState } from "react";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";

/* ---------------------------------------------------------------------------
 * GitHub skill import/sync — types + UI extracted from SkillsList.tsx so the
 * upstream page diff stays minimal. Server counterpart:
 * apps/main/src/routes/skills-github.ts.
 * ------------------------------------------------------------------------- */

/* ---------- types ---------- */

export interface GitHubSource {
  repo: string;
  ref?: string;
  path?: string;
  skill_dir?: string;
  commit?: string;
  synced_at?: string;
}

export interface GitHubImportSkill {
  name: string;
  skill_id: string;
  dir: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  error?: string;
}

export interface GitHubImportResponse {
  repo: string;
  ref: string | null;
  path: string | null;
  commit: string;
  skills: GitHubImportSkill[];
}

export interface GitHubSyncSource {
  repo: string;
  ref: string | null;
  path: string | null;
  commit?: string;
  error?: string;
  skills?: GitHubImportSkill[];
  orphaned?: Array<{ skill_id: string; name: string }>;
}

export interface GitHubSyncResponse {
  sources: GitHubSyncSource[];
  message?: string;
}

/** Loose shape of useApi's `api` — passed in as a prop so this module stays
 *  decoupled from the auth context. */
type ApiFn = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

// Duplicated from SkillsList.tsx — a style constant, not worth a prop.
const inputCls =
  "w-full border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] bg-bg text-fg";

/* ---------- GitHubSourcePill ---------- */

/** Blue "github" pill for the skills table's Source column. */
export function GitHubSourcePill({ source }: { source: GitHubSource }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info-subtle text-info"
      title={`${source.repo}${source.ref ? `@${source.ref}` : ""}${source.skill_dir ? ` · ${source.skill_dir}` : ""}${source.commit ? ` · ${source.commit}` : ""}`}
    >
      github
    </span>
  );
}

/* ---------- GitHubImportSummary ---------- */

const ACTION_STYLES: Record<GitHubImportSkill["action"], string> = {
  created: "bg-success-subtle text-success",
  updated: "bg-info-subtle text-info",
  unchanged: "bg-bg-surface text-fg-muted",
  skipped: "bg-warning-subtle text-warning",
  failed: "bg-danger-subtle text-danger",
};

export function GitHubImportSummary({
  result,
  orphaned,
}: {
  result: Omit<GitHubImportResponse, "ref" | "path"> & {
    ref?: string | null;
    path?: string | null;
  };
  orphaned?: Array<{ skill_id: string; name: string }>;
}) {
  const counts = result.skills.reduce(
    (acc, s) => {
      acc[s.action]++;
      return acc;
    },
    { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 } as Record<
      GitHubImportSkill["action"],
      number
    >,
  );
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        {counts.created} created · {counts.updated} updated · {counts.unchanged} unchanged
        {counts.skipped > 0 ? ` · ${counts.skipped} skipped` : ""}
        {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
        {orphaned && orphaned.length > 0 ? ` · ${orphaned.length} orphaned` : ""}
        {result.commit ? (
          <span className="font-mono text-fg-subtle"> @ {result.commit}</span>
        ) : null}
      </p>
      <div className="space-y-1">
        {result.skills.map((s, i) => (
          <div key={s.skill_id || `${s.name}-${i}`} className="flex items-center gap-2 text-sm">
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${ACTION_STYLES[s.action]}`}
            >
              {s.action}
            </span>
            <span className="font-mono text-xs text-fg truncate">{s.name}</span>
            {s.dir && (
              <span className="text-xs text-fg-subtle truncate">{s.dir}/</span>
            )}
            {s.error && (
              <span className="text-xs text-danger truncate" title={s.error}>
                {s.error}
              </span>
            )}
          </div>
        ))}
        {orphaned?.map((o) => (
          <div key={o.skill_id} className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning-subtle text-warning">
              orphaned
            </span>
            <span className="font-mono text-xs text-fg-muted truncate">{o.name}</span>
            <span className="text-xs text-fg-subtle">no longer in the repo — kept</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- GitHubImportFields ---------- */

export interface GitHubImportFieldsProps {
  url: string;
  onUrlChange: (v: string) => void;
  refName: string;
  onRefChange: (v: string) => void;
  path: string;
  onPathChange: (v: string) => void;
  token: string;
  onTokenChange: (v: string) => void;
  disabled?: boolean;
}

/** Form fields for the "From GitHub" mode of the create-skill dialog.
 *  State stays in the parent (it owns the import request + result). */
export function GitHubImportFields({
  url,
  onUrlChange,
  refName,
  onRefChange,
  path,
  onPathChange,
  token,
  onTokenChange,
  disabled,
}: GitHubImportFieldsProps) {
  return (
    <>
      <div>
        <label className="text-sm text-fg-muted block mb-1">
          Repository <span className="text-danger">*</span>
        </label>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          className={inputCls}
          placeholder="https://github.com/owner/repo or owner/repo"
          disabled={disabled}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-fg-muted block mb-1">
            Ref <span className="text-fg-subtle">(optional)</span>
          </label>
          <input
            value={refName}
            onChange={(e) => onRefChange(e.target.value)}
            className={inputCls}
            placeholder="default branch"
            disabled={disabled}
          />
        </div>
        <div>
          <label className="text-sm text-fg-muted block mb-1">
            Path <span className="text-fg-subtle">(optional)</span>
          </label>
          <input
            value={path}
            onChange={(e) => onPathChange(e.target.value)}
            className={inputCls}
            placeholder="e.g. skills"
            disabled={disabled}
          />
        </div>
      </div>
      <div>
        <label className="text-sm text-fg-muted block mb-1">
          Access Token{" "}
          <span className="text-fg-subtle">
            (only for private repos — never stored)
          </span>
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          className={inputCls}
          placeholder="ghp_..."
          autoComplete="off"
          disabled={disabled}
        />
      </div>
      <p className="text-xs text-fg-subtle">
        Every directory containing a <code>SKILL.md</code> becomes a
        skill. Existing skills with the same name are updated with a
        new version — GitHub is treated as the source of truth.
      </p>
    </>
  );
}

/* ---------- SyncGitHubModal ---------- */

export interface SyncGitHubModalProps {
  open: boolean;
  onClose: () => void;
  api: ApiFn;
  /** Called after a sync completes so the parent can refresh its list. */
  onSynced: () => void;
}

/** Self-contained "Sync GitHub Skills" dialog — owns the token / loading /
 *  result state so the parent page only tracks open/closed. */
export function SyncGitHubModal({ open, onClose, api, onSynced }: SyncGitHubModalProps) {
  const [syncToken, setSyncToken] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncResult, setSyncResult] = useState<GitHubSyncResponse | null>(null);

  const doSync = async () => {
    setSyncError("");
    setSyncing(true);
    try {
      const body: Record<string, string> = {};
      if (syncToken.trim()) body.token = syncToken.trim();
      const res = await api<GitHubSyncResponse>("/v1/skills/sync/github", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSyncResult(res);
      setSyncToken("");
      onSynced();
    } catch (e: any) {
      setSyncError(e?.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const close = () => {
    if (syncing) return;
    setSyncToken("");
    setSyncError("");
    setSyncResult(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Sync GitHub Skills"
      subtitle="Re-import every GitHub source tracked by your skills."
      maxWidth="max-w-xl"
      footer={
        syncResult ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={syncing} onClick={close}>
              Cancel
            </Button>
            <Button
              onClick={doSync}
              disabled={syncing}
              loading={syncing}
              loadingLabel="Syncing..."
            >
              Sync now
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {syncError && (
          <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
            {syncError}
          </div>
        )}
        {syncResult ? (
          <div className="space-y-3">
            {syncResult.sources.length === 0 && (
              <p className="text-sm text-fg-muted">
                {syncResult.message || "Nothing to sync."}
              </p>
            )}
            {syncResult.sources.map((src, i) => (
              <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                <div className="text-sm font-medium text-fg font-mono">
                  {src.repo}
                  {src.ref ? `@${src.ref}` : ""}
                  {src.path ? ` · ${src.path}` : ""}
                </div>
                {src.error ? (
                  <p className="text-xs text-danger">{src.error}</p>
                ) : (
                  <GitHubImportSummary
                    result={{ repo: src.repo, ref: src.ref, path: src.path, commit: src.commit || "", skills: src.skills || [] }}
                    orphaned={src.orphaned}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Skills updated in their repositories get a new version, new
              skills are added, and skills removed from a repository are
              kept here untouched (reported as orphaned).
            </p>
            <div>
              <label className="text-sm text-fg-muted block mb-1">
                Access Token{" "}
                <span className="text-fg-subtle">
                  (only for private repos — never stored)
                </span>
              </label>
              <input
                type="password"
                value={syncToken}
                onChange={(e) => setSyncToken(e.target.value)}
                className={inputCls}
                placeholder="ghp_..."
                autoComplete="off"
                disabled={syncing}
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
