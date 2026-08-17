import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@smartflow/daemon",
        replacement: resolve(import.meta.dirname, "apps/daemon/src/index.ts")
      },
      {
        find: "@smartflow/mcp-server",
        replacement: resolve(import.meta.dirname, "apps/mcp-server/src/index.ts")
      },
      {
        find: /^@smartflow\/(.+)$/u,
        replacement: resolve(import.meta.dirname, "packages/$1/src/index.ts")
      }
    ]
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true
  }
});
