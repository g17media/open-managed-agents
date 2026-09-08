import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { DeploymentsList } from "./DeploymentsList";

const mocks = vi.hoisted(() => ({ run: vi.fn(), refetch: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({ deployments: { run: mocks.run } }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("../lib/useApiQuery", () => {
  const deployment = { id: "dpl_active", name: "Weather", status: "active", archived_at: null,
    agent: { id: "agent_test" }, schedule: null, resources: [], vault_ids: [], initial_events: [] };
  const deployments = [deployment,
    { ...deployment, id: "dpl_paused", name: "Paused job", status: "paused" },
    { ...deployment, id: "dpl_archived", name: "Archived job", archived_at: "2026-09-08T00:00:00Z" }];
  return {
    useApiQuery: (path: string) => ({ data: { data: path === "/v1/deployments" ? deployments : [] },
      isLoading: false, refetch: mocks.refetch }),
  };
});

function openDeployments() {
  render(<MemoryRouter initialEntries={["/deployments"]}><I18nProvider><DeploymentsList /></I18nProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("deployment launch controls", () => {
  it("runs directly from the row and blocks repeat clicks while launch is pending", async () => {
    let resolveRun!: (run: object) => void;
    mocks.run.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    openDeployments();
    const button = screen.getByRole("button", { name: "Run Weather now" });
    expect(button).toBeVisible();
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith("dpl_active");
    expect(screen.getByRole("button", { name: "Run Weather now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run Weather now" })).toHaveTextContent("Starting…");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { resolveRun({ session_id: "session_new", error: null }); });
    expect(screen.getByRole("button", { name: "Run Weather now" })).toBeEnabled();
    expect(mocks.success).toHaveBeenCalledWith("Weather started", expect.objectContaining({
      action: expect.objectContaining({ label: "View session" }),
    }));
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
  });

  it("shows a failed launch and lets the user retry", async () => {
    mocks.run.mockResolvedValueOnce({ session_id: null, error: { message: "Environment is unavailable" } })
      .mockResolvedValueOnce({ session_id: "session_retry", error: null });
    openDeployments();
    const button = screen.getByRole("button", { name: "Run Weather now" });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Environment is unavailable"));
    expect(screen.getByRole("button", { name: "Run Weather now" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Run Weather now" }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1));
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("keeps unavailable deployments visible without allowing a launch", () => {
    openDeployments();
    const paused = screen.getByRole("button", { name: "Run Paused job now" });
    const archived = screen.getByRole("button", { name: "Run Archived job now" });
    expect(paused).toBeVisible();
    expect(paused).toBeDisabled();
    expect(archived).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
