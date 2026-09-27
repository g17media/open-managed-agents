import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: {} as Record<string, unknown> }));
const vault = { id: "vault-1", display_name: "Credentials", type: "vault", archived_at: null, metadata: {}, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" };
const keyJson = JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: "synthetic-new-key", private_key_id: "new-key-id", token_uri: "https://oauth2.googleapis.com/token" });
vi.mock("../lib/api", () => ({ useApi: () => ({ api: mocks.api }), getActiveTenantId: () => "workspace" }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [{ ...vault, id: "sa-1", display_name: "Research Bot", auth: mocks.auth }], isLoading: false, refresh: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div> }));
function show() { render(<MemoryRouter initialEntries={["/vaults/vault-1"]}><I18nProvider><Routes><Route path="/vaults/:id" element={<VaultDetail />} /></Routes></I18nProvider></MemoryRouter>); }
function edit() { show(); fireEvent.click(screen.getByRole("button", { name: "Edit" })); return within(screen.getByRole("dialog")); }
async function save() {
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
  expect(mocks.api.mock.calls[0][0]).toBe("/v1/vaults/vault-1/credentials/sa-1");
  return JSON.parse(mocks.api.mock.calls[0][1].body);
}
beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue({});
  mocks.auth = { type: "service_account_jwt", mcp_server_url: "https://www.googleapis.com/", client_email: "bot@example.iam.gserviceaccount.com", scopes: "drive documents", token_uri: "https://oauth2.googleapis.com/token", private_key_id: "key-id", subject: "delegate@example.com", audience: "https://audience.example.com" };
});
describe("service account credentials", () => {
  it.each(["", "delegate@example.com"])("creates from pasted JSON, scopes and optional subject %s", async (subject) => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "+ Add credential" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("tab", { name: "Service account" }));
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "https://www.googleapis.com/" } });
    expect(dialog.getByRole("button", { name: "Add credential" })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Paste JSON key"), { target: { value: keyJson } });
    expect(dialog.getByRole("button", { name: "Add credential" })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Scopes"), { target: { value: "  drive documents  " } });
    fireEvent.change(dialog.getByLabelText("Subject (optional)"), { target: { value: subject } });
    fireEvent.click(dialog.getByRole("button", { name: "Add credential" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(mocks.api.mock.calls[0][0]).toBe("/v1/vaults/vault-1/credentials");
    expect(JSON.parse(mocks.api.mock.calls[0][1].body).auth).toEqual({ type: "service_account_jwt", mcp_server_url: "https://www.googleapis.com/", key_json: keyJson, scopes: "drive documents", ...(subject ? { subject } : {}) });
  });

  it("keeps the create form open and displays API validation errors", async () => {
    mocks.api.mockRejectedValue(new Error("Invalid service account private key"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "+ Add credential" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("tab", { name: "Service account" }));
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "https://www.googleapis.com/" } });
    fireEvent.change(dialog.getByLabelText("Paste JSON key"), { target: { value: keyJson } });
    fireEvent.change(dialog.getByLabelText("Scopes"), { target: { value: "drive" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add credential" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid service account private key");
    expect(dialog.getByRole("button", { name: "Add credential" })).toBeEnabled();
  });

  it("shows and copies public fields while never rendering a stored key or token", async () => {
    mocks.auth = { ...mocks.auth, private_key: "synthetic-stored-key", key_json: "synthetic-stored-json", access_token: "synthetic-stored-token" };
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    const dialog = edit();
    const fields = { "Client email": "bot@example.iam.gserviceaccount.com", "Token endpoint": "https://oauth2.googleapis.com/token", "Key ID": "key-id", Scopes: "drive documents", Subject: "delegate@example.com", Audience: "https://audience.example.com", "Server URL": "https://www.googleapis.com/" };
    for (const [label, value] of Object.entries(fields)) {
      expect(dialog.getByLabelText(label)).toHaveValue(value);
      fireEvent.click(dialog.getByRole("button", { name: `Copy ${label}` }));
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(value));
    }
    expect(dialog.getByLabelText("Stored secret is hidden")).toHaveTextContent("••••••••");
    expect(screen.getByRole("dialog").outerHTML).not.toContain("synthetic-stored");
    expect(dialog.queryByLabelText("Handle")).not.toBeInTheDocument();
  });

  it("edits host and scopes, clears subject, and preserves the key with blank rotation", async () => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Server URL"), { target: { value: "https://docs.googleapis.com/" } });
    fireEvent.change(dialog.getByLabelText("Scopes"), { target: { value: "documents" } });
    fireEvent.change(dialog.getByLabelText("Subject"), { target: { value: "" } });
    expect(await save()).toEqual({ auth: { type: "service_account_jwt", mcp_server_url: "https://docs.googleapis.com/", scopes: "documents", subject: null } });
  });

  it("rotates through the update contract with replacement JSON", async () => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("New JSON key (optional)"), { target: { value: keyJson } });
    expect(await save()).toEqual({ auth: { type: "service_account_jwt", key_json: keyJson } });
  });

  it("prevents clearing required scopes", () => {
    const dialog = edit();
    fireEvent.change(dialog.getByLabelText("Scopes"), { target: { value: "  " } });
    expect(dialog.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });
});
