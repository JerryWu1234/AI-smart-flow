import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { runGitCommand } from "./git-command.js";
import { isStrictlyInside as isInside } from "./internal-utils.js";

export interface GitObjectStoreRef {
  gitDirectory: string;
  objectDirectory: string;
}

export async function initializeGitObjectStore(
  runDataDirectory: string,
  gitBinary = "git"
): Promise<GitObjectStoreRef> {
  await mkdir(runDataDirectory, { recursive: true, mode: 0o700 });
  const canonicalRunDirectory = await realpath(runDataDirectory);
  const gitDirectory = resolve(canonicalRunDirectory, "git-object-store");
  if (!isInside(canonicalRunDirectory, gitDirectory)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git object store must be inside the Run Data Dir");
  }
  await runGitCommand(gitBinary, ["init", "--bare", "--quiet", gitDirectory]);
  return {
    gitDirectory,
    objectDirectory: resolve(gitDirectory, "objects")
  };
}
