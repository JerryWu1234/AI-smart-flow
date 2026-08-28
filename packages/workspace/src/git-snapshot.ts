import { lstat, mkdir, open, readdir, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";
import { runGitCommand } from "./git-command.js";
import { canonical, isInsideOrEqual as isInside, sha256 as hash } from "./internal-utils.js";

export type GitSnapshotKind = "RUN_BASELINE" | "RUN_RESULT";
export type GitFileMode = "100644" | "100755" | "120000";

export interface GitSnapshotEntry {
  path: string;
  kind: "FILE" | "SYMLINK";
  mode: GitFileMode;
  blobId: string;
  sha256: string;
  size: number;
  target?: string;
}

export interface GitWorkspaceSnapshot {
  repositoryId: string;
  activeWorktreeRoot: string;
  snapshotKind: GitSnapshotKind;
  treeId: string;
  snapshotHash: string;
  includedPathPolicyHash: string;
  entries: GitSnapshotEntry[];
  createdAt: string;
}

export interface CaptureGitSnapshotInput {
  projectRoot: string;
  dataDirectory: string;
  runGitDirectory: string;
  indexPath: string;
  repositoryId: string;
  snapshotKind: GitSnapshotKind;
  includedPathPolicyHash: string;
  activeWorktreeRoot?: string;
  includeAllFiles?: boolean;
  gitBinary?: string;
}

export const SMARTFLOW_CONTROL_PLANE_PATH_PREFIXES = [".smartflow/tasks/"] as const;

export function isSmartFlowControlPlanePath(path: string): boolean {
  return SMARTFLOW_CONTROL_PLANE_PATH_PREFIXES.some((prefix) =>
    path === prefix.slice(0, -1) || path.startsWith(prefix)
  );
}

const sensitiveNames = new Set([
  ".env", ".npmrc", ".netrc", "credentials", "credentials.json", "id_rsa", "id_ed25519"
]);

function isSensitive(path: string): boolean {
  return path.split("/").some((name) => sensitiveNames.has(name) || /\.(?:key|pem|p12)$/iu.test(name));
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function outputPath(dataDirectory: string, target: string): Promise<string> {
  const canonicalData = await realpath(dataDirectory);
  const fromData = relative(resolve(dataDirectory), resolve(target));
  if (
    fromData.length === 0 ||
    fromData === ".." ||
    fromData.startsWith(`..${sep}`) ||
    isAbsolute(fromData)
  ) throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git snapshot output must be inside the Run Data Dir");
  let current = canonicalData;
  for (const part of fromData.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const stats = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) break;
    if (stats.isSymbolicLink()) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git snapshot index parent is a symlink");
    }
  }
  return resolve(canonicalData, fromData);
}

async function stableFile(path: string): Promise<{ bytes: Buffer; executable: boolean }> {
  const before = await lstat(path);
  const handle = await open(path, "r");
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
      throw new WorkspaceError("BASELINE_UNSTABLE", `File changed during Git snapshot: ${path}`);
    }
    return { bytes, executable: (after.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}

async function effectivePaths(gitBinary: string, root: string): Promise<string[]> {
  const result = await runGitCommand(
    gitBinary,
    ["-C", root, "ls-files", "-c", "-o", "--exclude-standard", "-z"]
  );
  return [...new Set(result.stdout.toString("utf8").split("\0").filter((path) =>
    safeRelativePath(path) && !isSensitive(path) && !isSmartFlowControlPlanePath(path)
  ))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function allWorkspacePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (child.name === ".git" || child.name === ".smartflow-runtime") continue;
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (isSensitive(relativePath) || isSmartFlowControlPlanePath(relativePath)) continue;
      if (child.isDirectory()) await visit(absolutePath);
      else paths.push(relativePath);
    }
  };
  await visit(root);
  return paths;
}

export function verifyGitWorkspaceSnapshot(snapshot: GitWorkspaceSnapshot): boolean {
  try {
    if (
      snapshot.activeWorktreeRoot !== "." ||
      !new Set<GitSnapshotKind>(["RUN_BASELINE", "RUN_RESULT"]).has(snapshot.snapshotKind) ||
      !/^[a-f0-9]{64}$/u.test(snapshot.repositoryId) ||
      !/^[a-f0-9]{40,64}$/u.test(snapshot.treeId) ||
      !/^[a-f0-9]{64}$/u.test(snapshot.snapshotHash) ||
      !/^[a-f0-9]{64}$/u.test(snapshot.includedPathPolicyHash) ||
      !Array.isArray(snapshot.entries) ||
      Number.isNaN(Date.parse(snapshot.createdAt))
    ) return false;
    const paths = snapshot.entries.map((entry) => entry.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((path) => !safeRelativePath(path)) ||
      [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .some((path, index) => path !== paths[index])
    ) return false;
    for (const entry of snapshot.entries) {
      if (
        !/^[a-f0-9]{40,64}$/u.test(entry.blobId) ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
        !Number.isInteger(entry.size) ||
        entry.size < 0
      ) return false;
      const entryKind = (entry as { kind?: unknown }).kind;
      if (entryKind === "FILE") {
        if (!new Set<GitFileMode>(["100644", "100755"]).has(entry.mode) || entry.target !== undefined) {
          return false;
        }
      } else if (
        entryKind !== "SYMLINK" ||
        entry.mode !== "120000" ||
        typeof entry.target !== "string" ||
        entry.size !== Buffer.byteLength(entry.target) ||
        entry.sha256 !== hash(Buffer.from(entry.target, "utf8"))
      ) return false;
    }
    const hashBody = {
      repositoryId: snapshot.repositoryId,
      activeWorktreeRoot: snapshot.activeWorktreeRoot,
      snapshotKind: snapshot.snapshotKind,
      treeId: snapshot.treeId,
      includedPathPolicyHash: snapshot.includedPathPolicyHash,
      entries: snapshot.entries
    };
    return snapshot.snapshotHash === hash(canonical(hashBody));
  } catch {
    return false;
  }
}

export async function captureGitSnapshot(
  input: CaptureGitSnapshotInput
): Promise<GitWorkspaceSnapshot> {
  const gitBinary = input.gitBinary ?? "git";
  const root = await realpath(input.projectRoot);
  await realpath(input.activeWorktreeRoot ?? input.projectRoot);
  const activeWorktreeRoot = ".";
  const runGitDirectory = await realpath(input.runGitDirectory);
  const canonicalDataDirectory = await realpath(input.dataDirectory);
  if (!isInside(canonicalDataDirectory, runGitDirectory)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git object store must be inside the Run Data Dir");
  }
  const indexPath = await outputPath(input.dataDirectory, input.indexPath);
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  await rm(indexPath, { force: true });
  const gitEnvironment = { GIT_INDEX_FILE: indexPath };
  await runGitCommand(gitBinary, ["--git-dir", runGitDirectory, "read-tree", "--empty"], {
    env: gitEnvironment
  });
  const entries: GitSnapshotEntry[] = [];
  const includedPaths = input.includeAllFiles
    ? await allWorkspacePaths(root)
    : await effectivePaths(gitBinary, root);
  for (const path of includedPaths) {
    const absolutePath = resolve(root, path);
    const stats = await lstat(absolutePath).catch(() => undefined);
    if (stats === undefined) continue;
    let bytes: Buffer;
    let mode: GitFileMode;
    let target: string | undefined;
    if (stats.isSymbolicLink()) {
      target = await readlink(absolutePath);
      if (!isInside(root, resolve(dirname(absolutePath), target))) {
        throw new WorkspaceError("EXTERNAL_SYMLINK", `Symlink escapes the project: ${path}`);
      }
      bytes = Buffer.from(target, "utf8");
      mode = "120000";
    } else if (stats.isFile()) {
      const stable = await stableFile(absolutePath);
      bytes = stable.bytes;
      mode = stable.executable ? "100755" : "100644";
    } else {
      throw new WorkspaceError("SPECIAL_FILE_REJECTED", `Unsupported filesystem entry: ${path}`);
    }
    const blobId = (await runGitCommand(
      gitBinary,
      ["--git-dir", runGitDirectory, "hash-object", "-w", "--stdin"],
      { input: bytes }
    )).stdout.toString("utf8").trim();
    await runGitCommand(
      gitBinary,
      ["--git-dir", runGitDirectory, "update-index", "--add", "--cacheinfo", mode, blobId, path],
      { env: gitEnvironment }
    );
    entries.push({
      path,
      kind: mode === "120000" ? "SYMLINK" : "FILE",
      mode,
      blobId,
      sha256: hash(bytes),
      size: bytes.byteLength,
      ...(target === undefined ? {} : { target })
    });
  }
  const treeId = (await runGitCommand(
    gitBinary,
    ["--git-dir", runGitDirectory, "write-tree"],
    { env: gitEnvironment }
  )).stdout.toString("utf8").trim();
  const hashBody = {
    repositoryId: input.repositoryId,
    activeWorktreeRoot,
    snapshotKind: input.snapshotKind,
    treeId,
    includedPathPolicyHash: input.includedPathPolicyHash,
    entries
  };
  return {
    ...hashBody,
    snapshotHash: hash(canonical(hashBody)),
    createdAt: new Date().toISOString()
  };
}
