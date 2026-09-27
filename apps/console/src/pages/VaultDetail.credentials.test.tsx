import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: {} as Record<string, unknown>, displayName: "Example credential" as string | null, metadata: {} as Record<string, string> }));
const vault = { id: "vault-1", display_name: "Team credentials", type: "vault", archived_at: null, metadata: {}, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T01:00:00Z" };
vi.mock("../lib/api", () => ({ useApi: () => ({ api: mocks.api }), getActiveTenantId: () => "workspace" }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [{ ...vault, id: "cred-1", vault_id: vault.id, type: "vault_credential", display_name: mocks.displayName, auth: mocks.auth, metadata: mocks.metadata }], isLoading: false, refresh: vi.fn() }),
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
  mocks.metadata = {};
  mocks.auth = { type: "static_bearer", mcp_server_url: "https://github.com", handle: "repo-reader" };
});

describe("credential details and updates", () => {
  it.each([
    { type: "static_bearer", mcp_server_url: "https://github.com", handle: "repo-reader" },
    { type: "static_basic", mcp_server_url: "https://logs.example.com", username: "public" },
    { type: "cap_cli", cli_id: "git", mcp_server_url: "https://git.example.com", handle: "writer" },
    { type: "mcp_oauth", mcp_server_url: "https://mcp.example.com", expires_at: "2026-10-01T00:00:00Z", refresh: { client_id: "client", token_endpoint: "https://auth.example.com/token", token_endpoint_auth: { type: "client_secret_post", client_secret: "synthetic-client-secret" }, scope: "read write", resource: "https://resource.example.com", refresh_token: "synthetic-refresh" } },
    { type: "container_registry", registry: "ghcr.io", username: "robot" },
    { type: "environment_variable", secret_name: "SERVICE_KEY", networking: { type: "limited", allowed_hosts: ["api.example.com"] }, injection_location: { body: true, header: true } },
  ])("copies each public field of $type and never renders secret properties", async (auth) => {
    mocks.auth = { ...auth, token: "synthetic-private-token", password: "synthetic-private-password", access_token: "synthetic-access", secret_value: "synthetic-value" };
    mocks.metadata = { provider: "example-provider" };
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    const dialog = edit();
    const fields: Record<string, string> = { "Display name": "Example credential", Created: vault.created_at, Updated: vault.updated_at, Provider: "example-provider" };
    if (auth.mcp_server_url) fields["Server URL"] = auth.mcp_server_url;
    if (auth.handle) fields.Handle = auth.handle;
    if (auth.username) fields.Username = auth.username;
    if (auth.cli_id) fields["CLI ID"] = auth.cli_id;
    if (auth.registry) fields["Registry / host"] = auth.registry;
    if (auth.refresh) Object.assign(fields, { "Client ID": "client", "Token endpoint": "https://auth.example.com/token", "Auth method": "client_secret_post", Scopes: "read write", Resource: "https://resource.example.com", Expires: "2026-10-01T00:00:00Z" });
    if (auth.secret_name) Object.assign(fields, { "Secret name": "SERVICE_KEY", Networking: "limited", "Allowed hosts": "api.example.com", "Injection locations": "header, body" });
    for (const [label, value] of Object.entries(fields)) {
      expect(dialog.getByLabelText(label)).toHaveValue(value);
      clipboard.mockClear();
      fireEvent.click(dialog.getByRole("button", { name: `Copy ${label}` }));
      await waitFor(() => expect(clipboard).toHaveBeenCalledExactlyOnceWith(value));
    }
    expect(screen.getByRole("dialog").outerHTML.includes("synthetic-")).toBe(false);
    expect(dialog.getByLabelText("Stored secret is hidden")).toHaveTextContent("••••••••");
    if (auth.type === "static_bearer") {
      fireEvent.change(dialog.getByLabelText("Handle"), { target: { value: "edited" } });
      fireEvent.click(dialog.getByRole("button", { name: "Copy Handle" }));
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("edited"));
    }
  });

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
  it("labels and validates the git Server URL and preserves HTTP and port on create", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "+ Add credential" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("tab", { name: "CLI" }));
    dialog.getByRole("combobox").focus();
    await user.keyboard("{ArrowDown}{End}{Enter}");
    fireEvent.change(dialog.getByLabelText(/Token \(write-only/), { target: { value: "synthetic-token" } });
    const url = dialog.getByLabelText("Server URL");
    fireEvent.change(url, { target: { value: "file:///tmp/key" } });
    expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(url, { target: { value: "http://git.example.com:8080" } });
    fireEvent.change(dialog.getByLabelText(/Handle/), { target: { value: "Exact.Handle" } });
    await user.click(dialog.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(JSON.parse(mocks.api.mock.calls[0][1].body).auth).toEqual({ type: "cap_cli", cli_id: "git", token: "synthetic-token", mcp_server_url: "http://git.example.com:8080", handle: "Exact.Handle" });
  });

  it.each(["Bearer token", "HTTP Basic", "OAuth"])("validates the %s create URL before enabling submission", async (type) => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "+ Add credential" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("tab", { name: type }));
    if (type !== "HTTP Basic") await user.click(dialog.getByRole("button", { name: /Access token/ }));
    fireEvent.change(dialog.getByLabelText(type === "HTTP Basic" ? "Password" : "Access token"), { target: { value: "synthetic-token" } });
    if (type === "HTTP Basic") fireEvent.change(dialog.getByLabelText("Username"), { target: { value: "user" } });
    for (const value of ["not a URL", "file:///tmp/key", "https://"]) {
      fireEvent.change(dialog.getByRole("combobox"), { target: { value } });
      expect(dialog.getByRole("button", { name: "Add credential" })).toBeDisabled();
    }
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "https://api.example.com" } });
    expect(dialog.getByRole("button", { name: "Add credential" })).toBeEnabled();
  });

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
    for (const tab of dialog.getAllByRole("tab")) {
      expect(tab).toHaveClass("data-[state=active]:bg-background", "data-[state=active]:text-foreground");
      expect(tab).toHaveAttribute("data-state", tab.getAttribute("aria-selected") === "true" ? "active" : "inactive");
    }
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
