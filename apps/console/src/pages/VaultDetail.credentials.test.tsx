import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: {} as Record<string, unknown>, displayName: "Example credential" as string | null }));
const vault = { id: "vault-1", display_name: "Team credentials", type: "vault", archived_at: null, metadata: {}, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T01:00:00Z" };
vi.mock("../lib/api", () => ({ useApi: () => ({ api: mocks.api }), getActiveTenantId: () => "workspace" }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [{ ...vault, id: "cred-1", vault_id: vault.id, type: "vault_credential", display_name: mocks.displayName, auth: mocks.auth }], isLoading: false, refresh: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div> }));

function show() {
  render(<MemoryRouter initialEntries={["/vaults/vault-1"]}><I18nProvider><Routes><Route path="/vaults/:id" element={<VaultDetail />} /></Routes></I18nProvider></MemoryRouter>);
}
function edit() {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  return within(screen.getByRole("dialog"));
}
async function save() {
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
  expect(mocks.api.mock.calls[0][0]).toBe("/v1/vaults/vault-1/credentials/cred-1");
  return JSON.parse(mocks.api.mock.calls[0][1].body);
}
beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue({});
  mocks.displayName = "Example credential";
  mocks.auth = { type: "static_bearer", mcp_server_url: "https://github.com", handle: "repo-reader" };
});

describe("credential details and updates", () => {
  it("edits unnamed credentials without requiring or sending a name", async () => {
    mocks.displayName = null;
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Handle"), { target: { value: "writer" } });
    expect(await save()).toEqual({ auth: { type: "static_bearer", handle: "writer" } });
  });

  it("clears an optional display name with null", async () => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "" } });
    expect(await save()).toEqual({ display_name: null });
  });

  it("shows and copies the configured bearer selector, and patches only changed fields without a secret", async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    const dialog = edit();
    expect(dialog.getByLabelText("Server URL")).toHaveValue("https://github.com");
    expect(dialog.getByLabelText("Handle")).toHaveValue("repo-reader");
    expect(dialog.getByText("••••••••")).toBeInTheDocument();
    expect(dialog.getByLabelText("New token (optional)")).toHaveAttribute("type", "password");
    expect(dialog.getByLabelText("Created")).toHaveValue(vault.created_at);
    expect(dialog.getByLabelText("Updated")).toHaveValue(vault.updated_at);
    fireEvent.click(dialog.getByRole("button", { name: "Copy Handle" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith("repo-reader"));
    fireEvent.change(dialog.getByLabelText("Server URL"), { target: { value: "https://git.example.com" } });
    fireEvent.change(dialog.getByLabelText("Handle"), { target: { value: "team.writer" } });
    expect(await save()).toEqual({ auth: { type: "static_bearer", mcp_server_url: "https://git.example.com", handle: "team.writer" } });
  });

  it("clears a bearer handle with null and preserves the token when rotation is blank", async () => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Handle"), { target: { value: "" } });
    expect(await save()).toEqual({ auth: { type: "static_bearer", handle: null } });
  });

  it("edits Basic host and username and preserves exact rotated password bytes", async () => {
    mocks.auth = { type: "static_basic", mcp_server_url: "https://logs.example.com", username: "public" };
    const dialog = edit();
    expect(dialog.queryByLabelText("Handle")).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "new-user" } });
    fireEvent.change(dialog.getByLabelText("Server URL"), { target: { value: "https://new.example.com" } });
    fireEvent.change(dialog.getByLabelText("New password (optional)"), { target: { value: " rotated " } });
    expect(await save()).toEqual({ auth: { type: "static_basic", username: "new-user", mcp_server_url: "https://new.example.com", token: " rotated " } });
  });

  it("shows immutable CLI ID and edits git host and selector", async () => {
    mocks.auth = { type: "cap_cli", cli_id: "git", mcp_server_url: "https://github.com", handle: "repo-reader" };
    const dialog = edit();
    expect(dialog.getByLabelText("CLI ID")).toHaveValue("git");
    expect(dialog.getByLabelText("CLI ID")).toHaveAttribute("readonly");
    fireEvent.change(dialog.getByLabelText("Handle"), { target: { value: "writer" } });
    expect(await save()).toEqual({ auth: { type: "cap_cli", handle: "writer" } });
  });

  it("shows OAuth refresh configuration read-only and keeps its existing name-only edit surface", async () => {
    mocks.auth = { type: "mcp_oauth", mcp_server_url: "https://mcp.example.com", expires_at: "2026-10-01T00:00:00Z", refresh: { client_id: "example-client", token_endpoint: "https://auth.example.com/token", token_endpoint_auth: { type: "client_secret_post" }, scope: "read write", resource: "https://mcp.example.com" } };
    const dialog = edit();
    for (const [label, value] of [["Server URL", "https://mcp.example.com"], ["Client ID", "example-client"], ["Token endpoint", "https://auth.example.com/token"], ["Auth method", "client_secret_post"], ["Scopes", "read write"], ["Resource", "https://mcp.example.com"]]) {
      expect(dialog.getByLabelText(label)).toHaveValue(value);
      expect(dialog.getByLabelText(label)).toHaveAttribute("readonly");
    }
    expect(dialog.queryByLabelText("New token (optional)")).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Renamed OAuth" } });
    expect(await save()).toEqual({ display_name: "Renamed OAuth" });
  });

  it("shows registry configuration and edits the existing supported non-secret fields", async () => {
    mocks.auth = { type: "container_registry", registry: "ghcr.io", username: "robot" };
    const dialog = edit();
    expect(dialog.getByLabelText("Registry / host")).toHaveValue("ghcr.io");
    expect(dialog.getByLabelText("Username")).toHaveValue("robot");
    fireEvent.change(dialog.getByLabelText("Registry / host"), { target: { value: "registry.example.com" } });
    expect(await save()).toEqual({ auth: { type: "container_registry", registry: "registry.example.com" } });
  });

  it("shows environment-variable configuration without exposing its stored value", () => {
    mocks.auth = { type: "environment_variable", secret_name: "SERVICE_KEY", networking: { type: "limited", allowed_hosts: ["api.example.com"] }, injection_location: { body: false, header: true } };
    const dialog = edit();
    expect(dialog.getByLabelText("Secret name")).toHaveValue("SERVICE_KEY");
    expect(dialog.getByLabelText("Allowed hosts")).toHaveValue("api.example.com");
    expect(dialog.getByLabelText("Injection locations")).toHaveValue("header");
    expect(dialog.getByText("••••••••")).toBeInTheDocument();
  });

  it("keeps a configured registry username required when stored auth secrets are unknown", () => {
    mocks.auth = { type: "container_registry", registry: "ghcr.io", username: "robot" };
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "" } });
    expect(dialog.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it.each([ ["Server URL", "file:///tmp/key"], ["Handle", "not a handle"] ])("blocks invalid %s edits", (label, value) => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText(label), { target: { value } });
    expect(dialog.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
    expect(dialog.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it("reports a failed save and keeps the dialog open", async () => {
    mocks.api.mockRejectedValue(new Error("Credential changed concurrently"));
    edit();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("Credential changed concurrently")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("credential selectors", () => {
  it("exposes selected states and supports keyboard navigation for both selectors", async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByRole("columnheader", { name: "Server URL" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Add credential" }));
    const dialog = within(screen.getByRole("dialog"));
    const kind = dialog.getByRole("tablist", { name: "Credential kind" });
    expect(within(kind).getByRole("tab", { name: "MCP server" })).toHaveAttribute("aria-selected", "true");
    const oauth = dialog.getByRole("tab", { name: "OAuth" });
    expect(oauth).toHaveAttribute("aria-selected", "true");
    oauth.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(dialog.getByRole("tab", { name: "Bearer token" })).toHaveAttribute("aria-selected", "true"));
    expect(dialog.getByLabelText(/Handle/)).toHaveAccessibleDescription(/username the sandbox sends/);
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(dialog.getByLabelText("Username")).toBeInTheDocument());
    await user.click(within(kind).getByRole("tab", { name: "CLI" }));
    expect(within(kind).getByRole("tab", { name: "CLI" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(within(kind).getByRole("tab", { name: "Registry" })).toHaveAttribute("aria-selected", "true"));
  });
});
