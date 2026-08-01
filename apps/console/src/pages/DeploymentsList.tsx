import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArchiveIcon, PencilIcon, PlayIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { Modal } from "../components/Modal";
import { Combobox } from "../components/Combobox";
import { Select, SelectOption } from "../components/Select";
import { Button } from "@/components/ui/button";
import { shortenId } from "../lib/format";

interface Deployment {
  id: string;
  name: string;
  agent_id: string;
  environment_id: string | null;
  initial_message: string;
  vault_ids: string[];
  memory_store_ids: string[];
  trigger: { type: "manual" | "schedule"; cron?: string | null };
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}

interface DeploymentForm {
  name: string;
  agentId: string;
  environmentId: string;
  initialMessage: string;
  vaultIds: string[];
  memoryStoreIds: string[];
  triggerType: "manual" | "schedule";
  cron: string;
}

const EMPTY_FORM: DeploymentForm = {
  name: "",
  agentId: "",
  environmentId: "",
  initialMessage: "",
  vaultIds: [],
  memoryStoreIds: [],
  triggerType: "manual",
  cron: "0 9 * * *",
};

/**
 * Deployments — stored launch recipes (agent + environment + vaults +
 * memory stores + initial message) fired manually or on a cron schedule.
 * Every run creates a regular session; the Last run column links to it.
 */
export function DeploymentsList() {
  const { api } = useApi();

  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  // Editing target: null = closed, "new" = create, row = edit.
  const [formTarget, setFormTarget] = useState<Deployment | "new" | null>(null);
  const [form, setForm] = useState<DeploymentForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const params = useMemo(
    () => ({ ...(includeArchived ? { include_archived: "true" } : {}) }),
    [includeArchived],
  );
  const { data: resp, isLoading: loading, refetch } = useApiQuery<{ data: Deployment[] }>(
    "/v1/oma/deployments",
    params,
  );
  const deployments = resp?.data ?? [];

  // Aux data for the form's pickers — fetched lazily on first open.
  const formOpen = formTarget !== null;
  const { data: vaultsRes } = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    "/v1/vaults",
    { limit: "200" },
    { enabled: formOpen },
  );
  const { data: storesRes } = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    "/v1/memory_stores",
    undefined,
    { enabled: formOpen },
  );
  // Agent-name lookup for the table.
  const { data: agentsRes } = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    "/v1/agents",
    { limit: "200", status: "any" },
  );
  const agentName = (id: string) =>
    agentsRes?.data?.find((a) => a.id === id)?.name ?? shortenId(id);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormTarget("new");
  };

  const openEdit = (d: Deployment) => {
    setForm({
      name: d.name,
      agentId: d.agent_id,
      environmentId: d.environment_id ?? "",
      initialMessage: d.initial_message,
      vaultIds: d.vault_ids,
      memoryStoreIds: d.memory_store_ids,
      triggerType: d.trigger.type,
      cron: d.trigger.cron || EMPTY_FORM.cron,
    });
    setFormError(null);
    setFormTarget(d);
  };

  const closeForm = () => {
    setFormTarget(null);
    setFormError(null);
  };

  const save = async () => {
    setFormError(null);
    setSaving(true);
    try {
      const body = {
        name: form.name,
        agent_id: form.agentId,
        environment_id: form.environmentId || null,
        initial_message: form.initialMessage,
        vault_ids: form.vaultIds,
        memory_store_ids: form.memoryStoreIds,
        trigger:
          form.triggerType === "schedule"
            ? { type: "schedule", cron: form.cron }
            : { type: "manual" },
      };
      if (formTarget === "new") {
        await api("/v1/oma/deployments", { method: "POST", body: JSON.stringify(body) });
      } else if (formTarget) {
        await api(`/v1/oma/deployments/${formTarget.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      }
      closeForm();
      void refetch();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const runNow = async (d: Deployment) => {
    try {
      const res = await api<{ session_id: string }>(`/v1/oma/deployments/${d.id}/run`, {
        method: "POST",
        body: "{}",
      });
      toast.success(`${d.name} started`, {
        action: {
          label: "View session",
          onClick: () => {
            window.location.href = `/sessions/${res.session_id}`;
          },
        },
      });
      void refetch();
    } catch {
      /* api wrapper already toasted */
    }
  };

  const columns = useMemo<ColumnDef<Deployment>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "agent",
        accessorFn: (d) => d.agent_id,
        header: "Agent",
        cell: ({ row }) => (
          <span className="text-fg-muted">{agentName(row.original.agent_id)}</span>
        ),
      },
      {
        id: "trigger",
        accessorFn: (d) => d.trigger.type,
        header: "Trigger",
        cell: ({ row }) => {
          const t = row.original.trigger;
          return t.type === "schedule" ? (
            <span className="font-mono text-xs text-fg">{t.cron}</span>
          ) : (
            <span className="text-fg-subtle text-xs">manual</span>
          );
        },
      },
      {
        id: "next_run",
        accessorFn: (d) => d.next_run_at ?? "",
        header: "Next run",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {row.original.next_run_at
              ? new Date(row.original.next_run_at).toLocaleString()
              : "—"}
          </span>
        ),
      },
      {
        id: "last_run",
        accessorFn: (d) => d.last_run_at ?? "",
        header: "Last run",
        cell: ({ row }) => {
          const d = row.original;
          if (!d.last_run_at) return <span className="text-fg-subtle text-xs">never</span>;
          const label = new Date(d.last_run_at).toLocaleString();
          return d.last_session_id ? (
            <Link
              to={`/sessions/${d.last_session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-brand hover:underline"
            >
              {label}
            </Link>
          ) : (
            <span className="text-fg-muted text-xs">{label}</span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const d = row.original;
          const archived = !!d.archived_at;
          return (
            <RowActionsMenu
              label={`Actions for ${d.name}`}
              actions={[
                {
                  label: "Run now",
                  icon: <PlayIcon className="size-4" />,
                  disabled: archived,
                  onSelect: () => void runNow(d),
                },
                {
                  label: "Edit",
                  icon: <PencilIcon className="size-4" />,
                  onSelect: () => openEdit(d),
                },
                {
                  label: "Archive",
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    try {
                      await api(`/v1/oma/deployments/${d.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      void refetch();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (!confirm(`Delete deployment ${d.name}? This can't be undone.`)) return;
                    try {
                      await api(`/v1/oma/deployments/${d.id}`, { method: "DELETE" });
                      void refetch();
                    } catch {}
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, refetch, agentsRes],
  );

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const toggleIn = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <DataTable<Deployment>
      createLabel="+ New deployment"
      onCreate={openCreate}
      searchPlaceholder="Search deployments..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer px-2">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="rounded accent-brand"
          />
          Include archived
        </label>
      }
      data={deployments}
      loading={loading}
      getRowId={(d) => d.id}
      onRowClick={(d) => openEdit(d)}
      emptyTitle="No deployments"
      emptyKind="agent"
      emptyAction={<Button onClick={openCreate}>+ New deployment</Button>}
      emptySubtitle="A deployment bundles an agent, environment, vaults, memory stores, and an initial message — run it on demand or on a schedule."
      columns={columns}
    >
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={formTarget === "new" ? "New Deployment" : "Edit Deployment"}
        maxWidth="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !form.name || !form.agentId || !form.initialMessage}
            >
              {formTarget === "new" ? "Create" : "Save Changes"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}
          <div>
            <label htmlFor="deployment-name" className="text-sm text-fg-muted block mb-1">
              Name *
            </label>
            <input
              id="deployment-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
              placeholder="Nightly repo triage"
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Agent *</label>
            <Combobox<{ id: string; name: string }>
              value={form.agentId}
              onValueChange={(v) => setForm({ ...form, agentId: v })}
              endpoint="/v1/agents"
              getValue={(a) => a.id}
              getLabel={(a) => (
                <span>
                  {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
                </span>
              )}
              getTextLabel={(a) => `${a.name} (${a.id})`}
              placeholder="Select an agent..."
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Environment <span className="text-fg-subtle">(optional for local-runtime agents)</span>
            </label>
            <Combobox<{ id: string; name: string }>
              value={form.environmentId}
              onValueChange={(v) => setForm({ ...form, environmentId: v })}
              endpoint="/v1/environments"
              getValue={(e) => e.id}
              getLabel={(e) => (
                <span>
                  {e.name} <span className="text-fg-subtle text-[12px]">({e.id})</span>
                </span>
              )}
              getTextLabel={(e) => `${e.name} (${e.id})`}
              placeholder="Select an environment..."
            />
          </div>
          <div>
            <label
              htmlFor="deployment-message"
              className="text-sm text-fg-muted block mb-1"
            >
              Initial message *
            </label>
            <textarea
              id="deployment-message"
              value={form.initialMessage}
              onChange={(e) => setForm({ ...form, initialMessage: e.target.value })}
              rows={4}
              className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
              placeholder="Check the repo for new issues and triage them..."
            />
          </div>
          {(vaultsRes?.data?.length ?? 0) > 0 && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Credential Vaults</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {vaultsRes!.data.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.vaultIds.includes(v.id)}
                      onChange={() =>
                        setForm({ ...form, vaultIds: toggleIn(form.vaultIds, v.id) })
                      }
                      className="rounded accent-brand"
                    />
                    <span className="text-fg">{v.name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{v.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {(storesRes?.data?.length ?? 0) > 0 && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Memory Stores</label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {storesRes!.data.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.memoryStoreIds.includes(s.id)}
                      onChange={() =>
                        setForm({
                          ...form,
                          memoryStoreIds: toggleIn(form.memoryStoreIds, s.id),
                        })
                      }
                      className="rounded accent-brand"
                    />
                    <span className="text-fg">{s.name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{s.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="text-sm text-fg-muted block mb-1">Trigger</label>
            <div className="flex gap-2 items-start">
              <div className="w-36 shrink-0">
                <Select
                  value={form.triggerType}
                  onValueChange={(v) =>
                    setForm({ ...form, triggerType: v as "manual" | "schedule" })
                  }
                >
                  <SelectOption value="manual">Manual</SelectOption>
                  <SelectOption value="schedule">Schedule</SelectOption>
                </Select>
              </div>
              {form.triggerType === "schedule" && (
                <div className="flex-1">
                  <input
                    value={form.cron}
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                    className={`${inputCls} font-mono`}
                    placeholder="0 9 * * *"
                    aria-label="Cron expression"
                  />
                  <p className="text-[11px] text-fg-subtle mt-1">
                    Cron expression (UTC) — e.g. <span className="font-mono">0 9 * * *</span>{" "}
                    fires daily at 09:00.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}
