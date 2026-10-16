import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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


describe("OAuth renewal warning toasts", () => {
  it.each([
    { mode: "connect", probe: true }, { mode: "connect", probe: false },
    { mode: "reconnect", probe: true }, { mode: "reconnect", probe: false },
  ])("keeps the renewal warning alongside the $mode probe toast ($probe)", async ({ mode, probe }) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    let channelListener: ((event: MessageEvent) => void) | undefined;
    vi.stubGlobal("BroadcastChannel", class {
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { channelListener = listener; }
      removeEventListener() {}
      close() {}
    });
    render(<MemoryRouter initialEntries={["/vaults/vault-1"]}><I18nProvider><Routes>
      <Route path="/vaults/:id" element={<VaultDetail />} />
    </Routes></I18nProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: mode === "connect" ? "+ Add credential" : "Reconnect" }));
    const warning = "This connection can't renew itself; reconnect before it expires.";
    const data = { type: "oauth_complete", service: "Dendrite", probe_ok: probe, probe_message: "Probe denied", renewal_warning: warning };
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, data })));
    expect(mocks.warning).toHaveBeenCalledWith(warning);
    if (probe) expect(mocks.success).toHaveBeenCalledWith(mode === "connect" ? "Connected to Dendrite — token verified." : "Credential reconnected");
    else expect(mocks.warning).toHaveBeenCalledWith(mode === "connect" ? "Connected to Dendrite, but: Probe denied" : "Credential renewed, but the MCP server still rejected it.");

    mocks.warning.mockClear();
    fireEvent.click(screen.getByRole("button", { name: mode === "connect" ? "+ Add credential" : "Reconnect" }));
    act(() => channelListener?.(new MessageEvent("message", { data })));
    expect(mocks.warning).toHaveBeenCalledWith(warning);

    mocks.warning.mockClear();
    fireEvent.click(screen.getByRole("button", { name: mode === "connect" ? "+ Add credential" : "Reconnect" }));
    act(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin, data: { ...data, probe_ok: true, renewal_warning: null },
    })));
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
