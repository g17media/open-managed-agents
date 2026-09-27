import { describe, expect, it } from "vitest";
import { sequenceTools } from "../src/harness/tool-execution";

describe("sequential execution queue", () => {
  // Detects a per-name queue (different tools would overlap) and a global queue
  // (independent runs would block). It does not verify metadata; integration does.
  it("shares one queue across repeated and different tools, but isolates runs", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    const tools = sequenceTools({
      edit: { execute: async (input: string, _options: unknown) => { calls.push(input); if (input === "first") { started.resolve(); await gate.promise; } return input; } },
      bash: { execute: async (_input: unknown, _options: unknown) => { calls.push("bash"); return "bash"; } },
      client: { description: "client-owned" },
    });
    const first = tools.edit.execute("first", {});
    const second = tools.edit.execute("second", {});
    const third = tools.bash.execute(undefined, {});
    await started.promise;
    expect(calls).toEqual(["first"]);
    const independent = sequenceTools({ echo: { execute: async (_input: unknown, _options: unknown) => "independent" } });
    expect(await independent.echo.execute(undefined, {})).toBe("independent");
    expect(tools.client).not.toHaveProperty("execute");
    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "bash"]);
    expect(calls).toEqual(["first", "second", "bash"]);
  });

  // The SDK can itself abort a call, masking a missing guard in integration tests.
  // Does not detect a poisoned rejection tail; the failed-edit integration does.
  it("rejects a queued aborted call before its side effect", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let ran = false;
    const tools = sequenceTools({
      first: { execute: async (_input: unknown, _options: unknown) => { started.resolve(); await gate.promise; } },
      later: { execute: async (_input: unknown, _options: unknown) => { ran = true; } },
    });
    const controller = new AbortController();
    const first = tools.first.execute(undefined, {});
    const later = tools.later.execute(undefined, { abortSignal: controller.signal });
    const rejected = expect(later).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    controller.abort();
    gate.resolve();
    await first;
    await rejected;
    expect(ran).toBe(false);
  });
});
