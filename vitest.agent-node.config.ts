import { defineConfig } from "vitest/config";

// Native fetch/HTTP regressions must run on Node, outside the Workers pool.
export default defineConfig({
  test: {
    pool: "threads",
    maxWorkers: 1,
    testTimeout: 15000,
    include: [
      "apps/agent/tests/**/*.node.test.ts",
      "apps/agent/tests/default-loop-provider-retry.test.ts",
      "apps/agent/tests/provider-retry.test.ts",
    ],
  },
});
