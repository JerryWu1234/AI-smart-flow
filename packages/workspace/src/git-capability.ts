import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { runGitCommand } from "./git-command.js";
import { canonical } from "./internal-utils.js";

export type GitPauseCode =
  | "GIT_UNAVAILABLE"
  | "GIT_REPOSITORY_REQUIRED"
  | "GIT_SUBMODULE_UNSUPPORTED"
  | "GIT_NESTED_REPOSITORY_UNSUPPORTED";

export interface GitCapabilities {
  status: "READY" | "PAUSED";
  pause?: { code: GitPauseCode; message: string };
  repositoryId?: string;
  repositoryRoot?: string;
  gitDirectory?: string;
  gitVersion?: string;
  worktreeSupported: boolean;
  symlinks: boolean;
  fileMode: boolean;
  inclusionPolicy: {
    tracked: true;
    dirty: true;
    untrackedNonIgnored: true;
    ignored: false;
    sensitive: false;
  };
  inclusionPolicyHash: string;
}

export interface ProbeGitRepositoryOptions {
  gitBinary?: string;
}

const inclusionPolicy = {
  tracked: true,
  dirty: true,
  untrackedNonIgnored: true,
  ignored: false,
  sensitive: false
} as const;



const inclusionPolicyHash = createHash("sha256")
  .update(canonical(inclusionPolicy), "utf8")
  .digest("hex");

function paused(
  code: GitPauseCode,
  message: string,
  details: Partial<GitCapabilities> = {}
): GitCapabilities {
  return {
    worktreeSupported: false,
    symlinks: false,
    fileMode: false,
    ...details,
    status: "PAUSED",
    pause: { code, message },
    inclusionPolicy,
    inclusionPolicyHash
  };
}

function nulPaths(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter((value) => value.length > 0);
}

async function booleanConfig(
  gitBinary: string,
  root: string,
  key: string,
  fallback: boolean
): Promise<boolean> {
  const result = await runGitCommand(gitBinary, ["-C", root, "config", "--bool", "--get", key], {
    allowExitCodes: [1]
  });
  if (result.exitCode === 1) return fallback;
  return result.stdout.toString("utf8").trim() === "true";
}

async function hasNestedRepository(gitBinary: string, root: string): Promise<boolean> {
  const listed = await runGitCommand(
    gitBinary,
    ["-C", root, "ls-files", "-o", "--exclude-standard", "--directory", "-z"]
  );
  for (const listedPath of nulPaths(listed.stdout)) {
    const cleanPath = listedPath.endsWith("/") ? listedPath.slice(0, -1) : listedPath;
    let current = resolve(root, cleanPath);
    while (current !== root && current.startsWith(`${root}${sep}`)) {
      if (await lstat(resolve(current, ".git")).then(() => true).catch(() => false)) return true;
      current = dirname(current);
    }
  }
  return false;
}

export async function probeGitRepository(
  projectRoot: string,
  options: ProbeGitRepositoryOptions = {}
): Promise<GitCapabilities> {
  const gitBinary = options.gitBinary ?? "git";
  let gitVersion: string;
  try {
    gitVersion = (await runGitCommand(gitBinary, ["--version"])).stdout.toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return paused("GIT_UNAVAILABLE", "Git executable is unavailable");
    }
    throw error;
  }
  let root: string;
  let gitDirectory: string;
  try {
    const rootResult = await runGitCommand(
      gitBinary,
      ["-C", projectRoot, "rev-parse", "--show-toplevel"],
      { allowExitCodes: [128] }
    );
    if (rootResult.exitCode !== 0) {
      return paused("GIT_REPOSITORY_REQUIRED", "Project must be inside a Git worktree");
    }
    root = await realpath(rootResult.stdout.toString("utf8").trim());
    const gitDirText = (await runGitCommand(
      gitBinary,
      ["-C", root, "rev-parse", "--absolute-git-dir"]
    )).stdout.toString("utf8").trim();
    gitDirectory = await realpath(gitDirText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return paused("GIT_REPOSITORY_REQUIRED", "Project must be inside a Git worktree");
    }
    throw error;
  }

  const repositoryId = createHash("sha256")
    .update(`${root}\0${gitDirectory}`, "utf8")
    .digest("hex");
  const repositoryDetails = {
    repositoryId,
    repositoryRoot: root,
    gitDirectory,
    gitVersion,
    worktreeSupported: true,
    symlinks: await booleanConfig(gitBinary, root, "core.symlinks", process.platform !== "win32"),
    fileMode: await booleanConfig(gitBinary, root, "core.filemode", process.platform !== "win32")
  };
  if (await realpath(projectRoot) !== root) {
    return paused(
      "GIT_REPOSITORY_REQUIRED",
      "Project Root must be the Git worktree root",
      repositoryDetails
    );
  }

  const staged = await runGitCommand(gitBinary, ["-C", root, "ls-files", "--stage", "-z"]);
  if (nulPaths(staged.stdout).some((entry) => entry.startsWith("160000 ")) ||
    await lstat(resolve(root, ".gitmodules")).then(() => true).catch(() => false)) {
    return paused("GIT_SUBMODULE_UNSUPPORTED", "Git submodules are unsupported", repositoryDetails);
  }
  if (await hasNestedRepository(gitBinary, root)) {
    return paused(
      "GIT_NESTED_REPOSITORY_UNSUPPORTED",
      "Nested Git repositories are unsupported",
      repositoryDetails
    );
  }

  return {
    status: "READY",
    ...repositoryDetails,
    inclusionPolicy,
    inclusionPolicyHash
  };
}
