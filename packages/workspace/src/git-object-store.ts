import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { WorkspaceError } from "./errors.js";
import { runGitCommand } from "./git-command.js";
import { isStrictlyInside as isInside, sha256 } from "./internal-utils.js";

export interface GitObjectStoreRef {
  gitDirectory: string;
  objectDirectory: string;
}

export interface ReadGitBlobInput {
  dataDirectory: string;
  gitDirectory: string;
  blobId: string;
  expectedSha256: string;
  expectedSize: number;
  gitBinary?: string;
}

export async function initializeGitObjectStore(
  runDataDirectory: string,
  gitBinary = "git"
): Promise<GitObjectStoreRef> {
  const requestedRunDirectory = resolve(runDataDirectory);
  await mkdir(requestedRunDirectory, { recursive: true, mode: 0o700 });
  const canonicalRunDirectory = await realpath(requestedRunDirectory);
  const canonicalGitDirectory = resolve(canonicalRunDirectory, "git-object-store");
  if (!isInside(canonicalRunDirectory, canonicalGitDirectory)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git object store must be inside the Run Data Dir");
  }
  await runGitCommand(gitBinary, ["init", "--bare", "--quiet", canonicalGitDirectory]);
  const gitDirectory = resolve(requestedRunDirectory, "git-object-store");
  return {
    gitDirectory,
    objectDirectory: resolve(gitDirectory, "objects")
  };
}

export async function readGitBlob(input: ReadGitBlobInput): Promise<Buffer> {
  if (
    !/^[a-f0-9]{40,64}$/u.test(input.blobId) ||
    !/^[a-f0-9]{64}$/u.test(input.expectedSha256) ||
    !Number.isInteger(input.expectedSize) ||
    input.expectedSize < 0
  ) {
    throw new WorkspaceError("WORKSPACE_COPY_DRIFT", "Git blob metadata is invalid");
  }
  const dataDirectory = await realpath(input.dataDirectory);
  const gitDirectory = await realpath(input.gitDirectory);
  if (!isInside(dataDirectory, gitDirectory)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Git object store must be inside the Run Data Dir");
  }
  const bytes = (await runGitCommand(
    input.gitBinary ?? "git",
    ["--git-dir", gitDirectory, "cat-file", "blob", input.blobId]
  )).stdout;
  if (bytes.byteLength !== input.expectedSize || sha256(bytes) !== input.expectedSha256) {
    throw new WorkspaceError("WORKSPACE_COPY_DRIFT", `Git blob does not match its snapshot: ${input.blobId}`);
  }
  return bytes;
}
