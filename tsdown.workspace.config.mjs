import { resolve } from "node:path";
import process from "node:process";

import { defineConfig } from "tsdown";

const projectRoot = import.meta.dirname;
const cwd = process.cwd();
const providerPiRoot = resolve(projectRoot, "packages/provider-pi");

const entry =
  cwd === providerPiRoot
    ? {
        index: "src/index.ts",
        "worker-entry": "src/worker-entry.ts",
        "mcp-model-extension": "src/mcp-model-extension.ts"
      }
    : "src/index.ts";

export default defineConfig({
  cwd,
  entry,
  platform: "node",
  format: "esm",
  target: "node22",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  tsconfig: resolve(cwd, "tsconfig.json")
});
