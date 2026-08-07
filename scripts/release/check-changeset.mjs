import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releasePackage = "@smartflow/cli";
const publishRelevantManifestFields = [
  "type",
  "engines",
  "bin",
  "main",
  "module",
  "types",
  "exports",
  "files",
  "sideEffects",
  "browser",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
  "os",
  "cpu"
];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git(["show", `${ref}:${path}`]));
  } catch {
    return undefined;
  }
}

function pickPublishFields(manifest) {
  return Object.fromEntries(
    publishRelevantManifestFields
      .filter((field) => Object.hasOwn(manifest, field))
      .map((field) => [field, manifest[field]])
  );
}

function manifestAffectsPublish(baseRef, path) {
  const before = readJsonAt(baseRef, path);
  if (before === undefined) {
    return true;
  }

  const after = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
  return JSON.stringify(pickPublishFields(before)) !== JSON.stringify(pickPublishFields(after));
}

function isPublishImpact(baseRef, path) {
  if (/^(apps|packages)\/[^/]+\/(src|assets|templates)\//u.test(path)) {
    return true;
  }

  if (/^tsdown(?:\.[^.]+)?\.config\.mjs$/u.test(path) || path === ".npmignore") {
    return true;
  }

  if (path === "package.json" || /^(apps|packages)\/[^/]+\/package\.json$/u.test(path)) {
    return manifestAffectsPublish(baseRef, path);
  }

  return false;
}

function changesetBump(path) {
  const content = readFileSync(resolve(repoRoot, path), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match === null) {
    return undefined;
  }

  const frontmatter = parse(match[1]);
  return frontmatter?.[releasePackage];
}

const baseRef = argumentValue("--base") ?? "origin/main";
const committedChanges = git([
  "diff",
  "--name-only",
  "--diff-filter=ACMRTUXB",
  `${baseRef}...HEAD`
])
  .split("\n")
  .filter(Boolean);
const untrackedChanges = git(["ls-files", "--others", "--exclude-standard"])
  .split("\n")
  .filter(Boolean);
const changedFiles = [...new Set([...committedChanges, ...untrackedChanges])];

const publishImpact = changedFiles.filter((path) => isPublishImpact(baseRef, path));
if (publishImpact.length === 0) {
  console.log("No published CLI changes detected; a changeset is not required.");
  process.exit(0);
}

const changesetFiles = changedFiles.filter(
  (path) =>
    /^\.changeset\/[^/]+\.md$/u.test(path) &&
    path !== ".changeset/README.md" &&
    existsSync(resolve(repoRoot, path))
);
const validChangeset = changesetFiles.some((path) =>
  ["patch", "minor", "major"].includes(changesetBump(path))
);

if (!validChangeset) {
  console.error("Published CLI files changed without a patch, minor, or major changeset.");
  console.error("Run `pnpm changeset` and select @smartflow/cli.");
  console.error("Publish-impacting files:");
  for (const path of publishImpact) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log(`Valid ${releasePackage} changeset found for ${publishImpact.length} publish-impacting file(s).`);
