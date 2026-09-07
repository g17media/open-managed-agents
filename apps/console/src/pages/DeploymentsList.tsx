import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArchiveIcon, PencilIcon, PlayIcon, PauseIcon } from "lucide-react";
import { toast } from "sonner";

import { deploymentInitialMessage, updateDeploymentMessage, deploymentMemoryResources } from "./deployments/form";
import { useManagedApi } from "../lib/useManagedApi";
import type { BetaManagedAgentsDeployment as Deployment, DeploymentCreateParams } from "@anthropic-ai/sdk/resources/beta/deployments";
import type { BetaManagedAgentsDeploymentRun } from "@anthropic-ai/sdk/resources/beta/deployment-runs";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Modal } from "../components/Modal";
import { Combobox } from "../components/Combobox";
import { Select, SelectOption } from "../components/Select";
import { Button } from "@/components/ui/button";
import { shortenId } from "../lib/format";

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
  const managedApi = useManagedApi();

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
    "/v1/deployments",
    params,
  );
  const deployments = resp?.data ?? [];
  const { data: runsRes, refetch: refetchRuns } = useApiQuery<{ data: BetaManagedAgentsDeploymentRun[] }>(
    "/v1/deployment_runs", { limit: "100" },
  );
  const latestRun = (deploymentId: string) => runsRes?.data.find((run) => run.deployment_id === deploymentId);

  // Aux data for the form's pickers — fetched lazily on first open.
  const formOpen = formTarget !== null;
  const { data: vaultsRes } = useApiQuery<{ data: Array<{ id: string; display_name: string }> }>(
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
    { limit: "100" },
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
      agentId: d.agent.id,
      environmentId: d.environment_id ?? "",
      initialMessage: deploymentInitialMessage(d),
      vaultIds: d.vault_ids,
      memoryStoreIds: d.resources.flatMap((resource) => resource.type === "memory_store" ? [resource.memory_store_id] : []),
      triggerType: d.schedule ? "schedule" : "manual",
      cron: d.schedule?.expression || EMPTY_FORM.cron,
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
      const body: Omit<DeploymentCreateParams, "betas"> = {
        name: form.name,
        agent: formTarget && formTarget !== "new" && formTarget.agent.id === form.agentId
          ? formTarget.agent : form.agentId,
        environment_id: form.environmentId,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: form.initialMessage }] }],
        vault_ids: form.vaultIds,
        resources: form.memoryStoreIds.map((id) => {
          const existing = formTarget && formTarget !== "new"
            ? formTarget.resources.find((resource) => resource.type === "memory_store" && resource.memory_store_id === id)
            : undefined;
          return existing?.type === "memory_store" ? existing : { type: "memory_store", memory_store_id: id, access: "read_write" };
        }),
        schedule: form.triggerType === "schedule"
          ? { type: "cron", expression: form.cron, timezone: "UTC" } : null,
      };
      if (formTarget === "new") {
        await managedApi.deployments.create(body);
      } else if (formTarget) {
        const { resources: _resources, initial_events: _events, schedule, ...fields } = body;
        const oldMemoryIds = formTarget.resources.flatMap((resource) => resource.type === "memory_store" ? [resource.memory_store_id] : []);
        const memoriesChanged = JSON.stringify(oldMemoryIds) !== JSON.stringify(form.memoryStoreIds);
        const scheduleChanged = (formTarget.schedule ? "schedule" : "manual") !== form.triggerType ||
          (form.triggerType === "schedule" && form.cron !== formTarget.schedule?.expression);
        await managedApi.deployments.update(formTarget.id, {
          ...fields,
          ...(deploymentInitialMessage(formTarget) !== form.initialMessage && {
            initial_events: updateDeploymentMessage(formTarget, form.initialMessage),
          }),
          ...(memoriesChanged && { resources: deploymentMemoryResources(formTarget, form.memoryStoreIds) }),
          ...(scheduleChanged && { schedule: schedule ? { ...schedule, timezone: formTarget.schedule?.timezone ?? "UTC" } : null }),
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
      const res = await managedApi.deployments.run(d.id);
      if (res.error || !res.session_id) throw new Error(res.error?.message ?? "Deployment did not start a session");
      void refetchRuns();
      toast.success(`${d.name} started`, {
        action: {
          label: "View session",
          onClick: () => {
            window.location.href = `/sessions/${res.session_id}`;
          },
        },
      });
      void refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
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
        accessorFn: (d) => d.agent.id,
        header: "Agent",
        cell: ({ row }) => (
          <span className="text-fg-muted">{agentName(row.original.agent.id)}</span>
        ),
      },
      {
        id: "trigger",
        accessorFn: (d) => d.schedule ? "schedule" : "manual",
        header: "Trigger",
        cell: ({ row }) => {
          const t = row.original.schedule;
          return t ? (
            <span className="font-mono text-xs text-fg">{t.expression}</span>
          ) : (
            <span className="text-fg-subtle text-xs">manual</span>
          );
        },
      },
      {
        id: "next_run",
        accessorFn: (d) => d.schedule?.upcoming_runs_at?.[0] ?? "",
        header: "Next run",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {row.original.schedule?.upcoming_runs_at?.[0]
              ? new Date(row.original.schedule?.upcoming_runs_at?.[0]).toLocaleString()
              : "—"}
          </span>
        ),
      },
      {
        id: "last_run",
        accessorFn: (d) => latestRun(d.id)?.created_at ?? d.schedule?.last_run_at ?? "",
        header: "Last run",
        cell: ({ row }) => {
          const d = row.original;
          const run = latestRun(d.id);
          const date = run?.created_at ?? d.schedule?.last_run_at;
          if (!date) return <span className="text-fg-subtle text-xs">never</span>;
          const label = new Date(date).toLocaleString();
          return run?.session_id ? (
            <Link
              to={`/sessions/${run.session_id}`}
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [managedApi, refetch, agentsRes, runsRes],
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
        <Label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer px-2">
          <Checkbox
            checked={includeArchived}
            onCheckedChange={(checked) => setIncludeArchived(checked === true)}
            className="rounded accent-brand"
          />
          Include archived
        </Label>
      }
      data={deployments.filter((deployment) => `${deployment.name} ${deployment.id}`.toLowerCase().includes(search.toLowerCase()))}
      rowActions={(d) => [
        { label: "Run now", icon: <PlayIcon className="size-4" />, disabled: !!d.archived_at || d.status !== "active", onSelect: () => void runNow(d) },
        { label: "Edit", icon: <PencilIcon className="size-4" />, onSelect: () => openEdit(d) },
        { label: d.status === "paused" ? "Resume schedule" : "Pause schedule", icon: <PauseIcon className="size-4" />, disabled: !!d.archived_at,
          onSelect: () => { void (d.status === "paused" ? managedApi.deployments.unpause(d.id) : managedApi.deployments.pause(d.id)).then(() => refetch()); } },
        { label: "Archive", icon: <ArchiveIcon className="size-4" />, disabled: !!d.archived_at,
          onSelect: () => { void managedApi.deployments.archive(d.id).then(() => refetch()); } },
      ]}
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
              disabled={saving || !form.name || !form.agentId || !form.environmentId || !form.initialMessage}
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
            <Label htmlFor="deployment-name" className="text-sm text-fg-muted block mb-1">
              Name *
            </Label>
            <Input
              id="deployment-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls}
              placeholder="Nightly repo triage"
            />
          </div>
          <div>
            <Label className="text-sm text-fg-muted block mb-1">Agent *</Label>
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
            <Label className="text-sm text-fg-muted block mb-1">
              Environment *
            </Label>
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
            <Label
              htmlFor="deployment-message"
              className="text-sm text-fg-muted block mb-1"
            >
              Initial message *
            </Label>
            <Textarea
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
              <Label className="text-sm text-fg-muted block mb-1">Credential Vaults</Label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {vaultsRes!.data.map((v) => (
                  <Label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={form.vaultIds.includes(v.id)}
                      onCheckedChange={() =>
                        setForm({ ...form, vaultIds: toggleIn(form.vaultIds, v.id) })
                      }
                      className="rounded accent-brand"
                    />
                    <span className="text-fg">{v.display_name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{v.id}</span>
                  </Label>
                ))}
              </div>
            </div>
          )}
          {(storesRes?.data?.length ?? 0) > 0 && (
            <div>
              <Label className="text-sm text-fg-muted block mb-1">Memory Stores</Label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {storesRes!.data.map((s) => (
                  <Label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={form.memoryStoreIds.includes(s.id)}
                      onCheckedChange={() =>
                        setForm({
                          ...form,
                          memoryStoreIds: toggleIn(form.memoryStoreIds, s.id),
                        })
                      }
                      className="rounded accent-brand"
                    />
                    <span className="text-fg">{s.name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{s.id}</span>
                  </Label>
                ))}
              </div>
            </div>
          )}
          <div>
            <Label className="text-sm text-fg-muted block mb-1">Trigger</Label>
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
                  <Input
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
