import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EnvironmentStartupConfig } from "@open-managed-agents/api-types";
import { StartupScriptEditor } from "./StartupScriptEditor";

describe("StartupScriptEditor", () => {
  it("preserves the script and independent trigger selections when toggled off and on", async () => {
    function Editor() {
      const [value, setValue] = useState<EnvironmentStartupConfig>({ script: "echo ready", triggers: ["create", "revive"] });
      return <StartupScriptEditor value={value} onChange={setValue} />;
    }
    render(<Editor />);
    const enabled = screen.getByRole("checkbox", { name: "Enable startup script" });
    await userEvent.click(screen.getByRole("checkbox", { name: /On creation/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /On wake/ }));
    await userEvent.click(enabled);
    expect(enabled).not.toBeChecked();
    await userEvent.click(enabled);
    expect(enabled).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /On creation/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /On wake/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /On revival/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Bash script" })).toHaveValue("echo ready");
  });
});
