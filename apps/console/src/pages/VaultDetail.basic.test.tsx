import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";
const mocks = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
const vault = { id: "vault-1", display_name: "Credentials", type: "vault", archived_at: null, metadata: {}, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" };
vi.mock("../lib/api", () => ({ useApi: () => ({ api: mocks.api }), getActiveTenantId: () => "workspace" }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [{ id: "basic-1", display_name: "Langfuse", archived_at: null, auth: { type: "static_basic", username: "public", mcp_server_url: "https://langfuse.test" }, updated_at: vault.updated_at }], isLoading: false, refresh: mocks.refresh }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div> }));
function show() { render(<MemoryRouter initialEntries={["/vaults/vault-1"]}><I18nProvider><Routes><Route path="/vaults/:id" element={<VaultDetail />} /></Routes></I18nProvider></MemoryRouter>); }
beforeEach(() => { mocks.api.mockReset().mockResolvedValue({}); });
describe("vault Basic credentials", () => {
  it("creates username/password credentials with exact password bytes", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "+ Add credential" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "HTTP Basic" }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "https://langfuse.test" } });
    fireEvent.change(within(dialog).getByLabelText("Username"), { target: { value: "public" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: " test:password " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add credential" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    const [path, options] = mocks.api.mock.calls[0];
    expect(path).toBe("/v1/vaults/vault-1/credentials");
    expect(JSON.parse(options.body).auth).toEqual({ type: "static_basic", mcp_server_url: "https://langfuse.test", username: "public", token: " test:password " });
  });
  it("shows Basic and username, masks the password and rotates it", async () => {
    show();
    expect(await screen.findByText("HTTP Basic")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("public")).toBeInTheDocument();
    expect(within(dialog).getByText("••••••••")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("New password (optional)"), { target: { value: " rotated " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(JSON.parse(mocks.api.mock.calls[0][1].body).auth).toEqual({ type: "static_basic", token: " rotated " });
  });
});
