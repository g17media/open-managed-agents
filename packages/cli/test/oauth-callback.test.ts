import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:http", () => ({ createServer: vi.fn() }));
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function completeCallback(warning?: string, service: string | null = "test") {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("OMA_BASE_URL", "http://localhost:8787");
  vi.stubEnv("OMA_API_KEY", "cli-contract-key");
  vi.stubEnv("OMA_PROFILE", "");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  process.argv = [process.execPath, "oma", "connect", "https://mcp.invalid", "--vault", "vault_test"];

  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message) => { output.push(message); });
  vi.spyOn(console, "warn").mockImplementation((message) => { output.push(message); });
  const close = vi.fn();
  const listen = vi.fn();
  vi.mocked(createServer).mockReturnValue({ close, listen } as unknown as ReturnType<typeof createServer>);

  await import("../src/index.js");

  expect(listen).toHaveBeenCalledOnce();
  expect(execSync).toHaveBeenCalledOnce();
  const handler = vi.mocked(createServer).mock.calls[0][0]!;
  const params = new URLSearchParams({ oauth: "success" });
  if (service !== null) params.set("service", service);
  if (warning !== undefined) params.set("renewal_warning", warning);
  const writeHead = vi.fn();
  const end = vi.fn();
  // Keep callback coverage local so OAuth providers and a browser are never needed.
  handler({ url: `/callback?${params}` } as any, { writeHead, end } as any);

  expect(writeHead).toHaveBeenCalledWith(200, { "Content-Type": "text/html" });
  expect(end).toHaveBeenCalledWith(`<html><body><h2>Connected${service ? ` to ${service}` : ""}!</h2><script>window.close()</script></body></html>`);
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  return output.slice(1);
}

describe("CLI OAuth callback", () => {
  it("prints the renewal warning after the connection confirmation", async () => {
    const warning = "This connection can't renew itself; reconnect before 2026-10-16T20:00:00.000Z.";

    expect(await completeCallback(warning)).toEqual([
      "Connected to test",
      `Warning: ${warning}`,
    ]);
  });

  it("keeps the connection confirmation unchanged without a renewal warning", async () => {
    expect(await completeCallback()).toEqual(["Connected to test"]);
  });

  it("keeps the server URL fallback without a service or renewal warning", async () => {
    expect(await completeCallback(undefined, null)).toEqual(["Connected to https://mcp.invalid"]);
  });
});
