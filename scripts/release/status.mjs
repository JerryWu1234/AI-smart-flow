import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const changelogPath = resolve(repoRoot, "CHANGELOG.md");

function packageVersionExists(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status === 0) {
    return true;
  }

  const error = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (error.includes("E404") || error.includes("404 Not Found")) {
    return false;
  }

  throw new Error(`Unable to query npm for ${name}@${version}:\n${error.trim()}`);
}

function changelogHasVersion(version) {
  if (!existsSync(changelogPath)) {
    return false;
  }

  const changelog = readFileSync(changelogPath, "utf8");
  return changelog.split("\n").some((line) => line.trim() === `## ${version}`);
}

function hasChangesets() {
  return readdirSync(resolve(repoRoot, ".changeset"), { withFileTypes: true }).some(
    (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md"
  );
}

function writeOutput(name, value) {
  const stringValue = String(value);
  console.log(`${name}=${stringValue}`);
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${stringValue}\n`);
  }
}

const registryPublished = packageVersionExists(manifest.name, manifest.version);
const changelogVersion = changelogHasVersion(manifest.version);
const pendingChangesets = hasChangesets();
const bootstrapRequired = !registryPublished && !changelogVersion;
const publishReady = !registryPublished && changelogVersion;

writeOutput("package_name", manifest.name);
writeOutput("package_version", manifest.version);
writeOutput("registry_published", registryPublished);
writeOutput("changelog_has_version", changelogVersion);
writeOutput("has_changesets", pendingChangesets);
writeOutput("bootstrap_required", bootstrapRequired);
writeOutput("publish_ready", publishReady);
