import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootManifestPath = resolve(repoRoot, "package.json");
const rootChangelogPath = resolve(repoRoot, "CHANGELOG.md");
const adapterManifestPath = resolve(repoRoot, "apps/cli/package.json");
const adapterChangelogPath = resolve(repoRoot, "apps/cli/CHANGELOG.md");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const rootManifestBefore = readJson(rootManifestPath);
const adapterManifestBefore = readJson(adapterManifestPath);

if (rootManifestBefore.name !== "@jerrywu1234/smartflow") {
  throw new Error(`Unexpected root package: ${rootManifestBefore.name}`);
}
if (adapterManifestBefore.name !== "@smartflow/cli") {
  throw new Error(`Unexpected release adapter package: ${adapterManifestBefore.name}`);
}
if (rootManifestBefore.version !== adapterManifestBefore.version) {
  throw new Error(
    `Root and release adapter versions differ: ${rootManifestBefore.version} !== ${adapterManifestBefore.version}`
  );
}

if (existsSync(rootChangelogPath)) {
  copyFileSync(rootChangelogPath, adapterChangelogPath);
}

try {
  execFileSync("pnpm", ["exec", "changeset", "version"], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  const adapterManifestAfter = readJson(adapterManifestPath);
  if (adapterManifestAfter.version === rootManifestBefore.version) {
    throw new Error("Changesets did not advance the CLI release adapter version.");
  }

  const rootManifestAfter = readJson(rootManifestPath);
  rootManifestAfter.version = adapterManifestAfter.version;
  writeJson(rootManifestPath, rootManifestAfter);

  if (!existsSync(adapterChangelogPath)) {
    throw new Error("Changesets did not generate the CLI changelog.");
  }
  copyFileSync(adapterChangelogPath, rootChangelogPath);

  console.log(
    `Versioned ${rootManifestAfter.name}: ${rootManifestBefore.version} -> ${rootManifestAfter.version}`
  );
} finally {
  rmSync(adapterChangelogPath, { force: true });
}
