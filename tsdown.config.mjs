import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

import { defineConfig } from "tsdown";

const projectRoot = import.meta.dirname;

export default defineConfig({
  cwd: projectRoot,
  entry: {
    smartflow: "apps/cli/src/main.ts",
    "worker-entry": "packages/provider-pi/src/worker-entry.ts",
    "mcp-model-extension": "packages/provider-pi/src/mcp-model-extension.ts"
  },
  platform: "node",
  format: "esm",
  target: "node22",
  outDir: "dist",
  fixedExtension: true,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: [
      "@modelcontextprotocol/sdk",
      /^@modelcontextprotocol\/sdk\//u,
      "@earendil-works/pi-coding-agent",
      /^@earendil-works\/pi-coding-agent\//u,
      "zod"
    ]
  },
  banner: ({ fileName }) =>
    fileName === "smartflow.mjs" ? { js: "#!/usr/bin/env node" } : undefined,
  hooks: {
    "build:done": async () => {
      await chmod(resolve(projectRoot, "dist/smartflow.mjs"), 0o755);
    }
  }
});
