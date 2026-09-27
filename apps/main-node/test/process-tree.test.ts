import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  detachedProcessOptions,
  killProcessTree,
} from "./helpers/process-tree";

describe.runIf(process.platform !== "win32")("test process-tree cleanup", () => {
  it("kills a detached launcher and its inherited grandchild", async () => {
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          process.stdout.write(String(child.pid) + "\n");
          setInterval(() => {}, 1000);
        `,
      ],
      {
        ...detachedProcessOptions,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      launcher.once("error", reject);
      launcher.stdout!.once("data", (data: Buffer) => {
        resolve(Number.parseInt(data.toString(), 10));
      });
    });

    expect(processIsRunning(grandchildPid)).toBe(true);
    await killProcessTree(launcher);

    await expect.poll(() => processIsRunning(grandchildPid), {
      timeout: 500,
    }).toBe(false);
  });
});

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Minimal container init processes may not reap orphaned grandchildren.
    // A zombie is terminated and cannot hold ports or execute server work.
    if (process.platform === "linux") {
      return !/^State:\s+Z\b/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
