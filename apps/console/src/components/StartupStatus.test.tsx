import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SandboxStartupEvent } from "@open-managed-agents/api-types";
import { StartupStatus } from "./StartupStatus";

describe("StartupStatus", () => {
  it("shows the latest failure and prevents duplicate retries while a retry is pending", async () => {
    const events: SandboxStartupEvent[] = [
      { type: "session.sandbox_startup", boot_id: "first", trigger: "create", status: "succeeded", stdout: "old output" },
      { type: "session.sandbox_startup", boot_id: "second", trigger: "wake", status: "failed", exit_code: 9, stderr: "service unavailable" },
    ];
    let finish!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<StartupStatus events={events} onRetry={onRetry} />);
    expect(screen.getByText("service unavailable")).toBeInTheDocument();
    expect(screen.getByText("Exit code: 9")).toBeInTheDocument();
    expect(screen.queryByText("old output")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry startup" }));
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "Retry startup" })).toBeEnabled();
  });
});
