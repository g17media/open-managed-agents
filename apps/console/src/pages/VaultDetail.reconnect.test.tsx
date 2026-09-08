import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), invalidateQueries: vi.fn(), success: vi.fn(), warning: vi.fn() }));
const vault = { id: "vault-1", display_name: "Dendrite", type: "vault", archived_at: null, metadata: {},
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" };
vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }), getActiveTenantId: () => "workspace-weather" }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: vault, error: null }),
  useInfiniteApiQuery: () => ({ items: [{ id: "cred-weather", display_name: "Dendrite OAuth", archived_at: null,
    auth: { type: "mcp_oauth", mcp_server_url: "https://dendrite.test/mcp" }, updated_at: vault.updated_at }],
    isLoading: false, refresh: mocks.refresh }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("../components/PageHeader", () => ({ PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div> }));
afterEach(() => vi.restoreAllMocks());

describe("vault OAuth reconnect", () => {
  it("opens authorization for the existing credential and reloads it after login", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<MemoryRouter initialEntries={["/vaults/vault-1"]}><I18nProvider><Routes>
      <Route path="/vaults/:id" element={<VaultDetail />} />
    </Routes></I18nProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    const url = new URL(String(open.mock.calls[0]?.[0]), window.location.origin);
    expect(url.pathname).toBe("/v1/oma/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      vault_id: "vault-1", credential_id: "cred-weather", active_tenant: "workspace-weather", mcp_server_url: "https://dendrite.test/mcp",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: "https://unrelated.test", data: { type: "oauth_complete", probe_ok: true },
    })));
    expect(mocks.refresh).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, data: { type: "oauth_complete", probe_ok: true },
    })));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.success).toHaveBeenCalledWith("Credential reconnected");
  });
});
