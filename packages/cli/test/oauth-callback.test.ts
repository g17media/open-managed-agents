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
  expect(end).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  return { output: output.slice(1), html: end.mock.calls[0][0] as string };
}

describe("CLI OAuth callback", () => {
  it("prints the renewal warning after the connection confirmation", async () => {
    const warning = "This connection can't renew itself; reconnect before 2026-10-16T20:00:00.000Z.";

    expect(await completeCallback(warning)).toEqual({
      output: ["Connected to test", `Warning: ${warning}`],
      html: "<html><body><h2>Connected to test!</h2><script>window.close()</script></body></html>",
    });
  });

  it("keeps the connection confirmation unchanged without a renewal warning", async () => {
    expect(await completeCallback()).toEqual({
      output: ["Connected to test"],
      html: "<html><body><h2>Connected to test!</h2><script>window.close()</script></body></html>",
    });
  });

  it("keeps the server URL fallback without a service or renewal warning", async () => {
    expect(await completeCallback(undefined, null)).toEqual({
      output: ["Connected to https://mcp.invalid"],
      html: "<html><body><h2>Connected!</h2><script>window.close()</script></body></html>",
    });
  });

  it.each(["service", "renewal_warning"] as const)("neutralizes screen-clear and OSC 52 controls in %s", async (param) => {
    const payload = "\r\x1b[2K\x1b[2J\x1b[HReadable café 日本語 🚀\n\x1b]52;c;Y2xpcGJvYXJk\x07";
    const safeText = "[2K[2J[HReadable café 日本語 🚀]52;c;Y2xpcGJvYXJk";
    const { output } = await completeCallback(
      param === "renewal_warning" ? payload : "Readable warning",
      param === "service" ? payload : "test",
    );

    expect(output).toEqual([
      `Connected to ${param === "service" ? safeText : "test"}`,
      `Warning: ${param === "renewal_warning" ? safeText : "Readable warning"}`,
    ]);
    for (const line of output) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("removes every C0, DEL and C1 control from both terminal values", async () => {
    const controls = Array.from({ length: 160 }, (_, code) => code)
      .filter((code) => code < 32 || code >= 127)
      .map((code) => String.fromCharCode(code)).join("");
    const { output } = await completeCallback(`Renew${controls} soon`, `Café${controls} 日本語 🚀`);

    expect(output).toEqual(["Connected to Café 日本語 🚀", "Warning: Renew soon"]);
  });

  it("escapes service markup and entities in the HTML response", async () => {
    const service = '</h2><script>alert("service")</script><h2> & &lt;service&gt;';
    const { output, html } = await completeCallback(undefined, service);

    expect(output).toEqual([`Connected to ${service}`]);
    expect(html).toBe('<html><body><h2>Connected to &lt;/h2&gt;&lt;script&gt;alert("service")&lt;/script&gt;&lt;h2&gt; &amp; &amp;lt;service&amp;gt;!</h2><script>window.close()</script></body></html>');
    expect(html.match(/<h2>(.*?)<\/h2>/)?.[1]).not.toMatch(/[<>]/);
  });

  it("keeps the existing fallback and omits an empty warning", async () => {
    expect(await completeCallback("", "")).toEqual({
      output: ["Connected to https://mcp.invalid"],
      html: "<html><body><h2>Connected!</h2><script>window.close()</script></body></html>",
    });
  });
});
