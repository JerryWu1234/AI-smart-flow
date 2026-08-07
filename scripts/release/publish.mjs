import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const tag = `v${manifest.version}`;

function run(command, args, { capture = false } = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit"
  });
}

function succeeds(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe"
  }).status === 0;
}

function npmVersionExists() {
  const result = spawnSync(
    "npm",
    ["view", `${manifest.name}@${manifest.version}`, "version", "--json"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.status === 0) {
    return true;
  }

  const error = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (error.includes("E404") || error.includes("404 Not Found")) {
    return false;
  }
  throw new Error(`Unable to query npm:\n${error.trim()}`);
}

function releaseNotes() {
  const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${manifest.version}`);
  if (start === -1) {
    return `Initial release of ${manifest.name} ${manifest.version}.\n`;
  }

  const next = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  return `${lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim()}\n`;
}

if (!npmVersionExists()) {
  const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
  if (!changelog.split("\n").some((line) => line.trim() === `## ${manifest.version}`)) {
    throw new Error(
      `${manifest.name}@${manifest.version} is the bootstrap release and must be published manually first.`
    );
  }

  run("npm", ["publish", "--access", "public"]);
  console.log(`Published ${manifest.name}@${manifest.version} to npm.`);
} else {
  console.log(`${manifest.name}@${manifest.version} already exists on npm; skipping npm publish.`);
}

const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
if (succeeds("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`])) {
  const taggedCommit = run("git", ["rev-list", "-n", "1", tag], { capture: true }).trim();
  if (taggedCommit !== head) {
    throw new Error(`${tag} already points to ${taggedCommit}, not ${head}.`);
  }
  console.log(`${tag} already points to the release commit; skipping tag creation.`);
} else {
  run("git", ["tag", "--annotate", tag, "--message", `${manifest.name} ${manifest.version}`]);
  run("git", ["push", "origin", `refs/tags/${tag}`]);
  console.log(`Created and pushed ${tag}.`);
}

if (succeeds("gh", ["release", "view", tag])) {
  console.log(`GitHub Release ${tag} already exists.`);
} else {
  const tempDirectory = mkdtempSync(join(tmpdir(), "smartflow-release-"));
  const notesPath = join(tempDirectory, "notes.md");
  try {
    writeFileSync(notesPath, releaseNotes());
    run("gh", [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--title",
      `${manifest.name} ${manifest.version}`,
      "--notes-file",
      notesPath
    ]);
    console.log(`Created GitHub Release ${tag}.`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
