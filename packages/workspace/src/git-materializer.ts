import { chmod, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";
import { runGitCommand } from "./git-command.js";
import type { GitWorkspaceSnapshot } from "./git-snapshot.js";
import { isStrictlyInside as isInside } from "./internal-utils.js";

export interface MaterializeGitSnapshotInput {
  snapshot: GitWorkspaceSnapshot;
  runGitDirectory: string;
  dataDirectory: string;
  destination: string;
  gitBinary?: string;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export async function materializeGitSnapshot(
  input: MaterializeGitSnapshotInput
): Promise<string> {
  const dataDirectory = await realpath(input.dataDirectory);
  const relativeDestination = relative(resolve(input.dataDirectory), resolve(input.destination));
  if (
    relativeDestination.length === 0 ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${sep}`) ||
    isAbsolute(relativeDestination)
  ) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Run Workspace must be inside its Run Data Dir");
  }
  const destination = resolve(dataDirectory, relativeDestination);
  if (!isInside(dataDirectory, destination)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Run Workspace must be inside its Run Data Dir");
  }
  let current = dataDirectory;
  for (const part of relativeDestination.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const stats = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) break;
    if (stats.isSymbolicLink()) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Run Workspace parent is a symlink");
    }
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of input.snapshot.entries) {
    if (!safePath(entry.path)) {
      throw new WorkspaceError("PATH_TRAVERSAL", `Unsafe Git tree path: ${entry.path}`);
    }
    const target = resolve(destination, entry.path);
    if (!isInside(destination, target)) {
      throw new WorkspaceError("PATH_TRAVERSAL", `Git tree path escapes Workspace: ${entry.path}`);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = (await runGitCommand(
      input.gitBinary ?? "git",
      ["--git-dir", input.runGitDirectory, "cat-file", "blob", entry.blobId]
    )).stdout;
    if (entry.mode === "120000") {
      const linkTarget = bytes.toString("utf8");
      if (!isInside(destination, resolve(dirname(target), linkTarget))) {
        throw new WorkspaceError("EXTERNAL_SYMLINK", `Materialized symlink escapes Workspace: ${entry.path}`);
      }
      await symlink(linkTarget, target);
    } else {
      await writeFile(target, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
      await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
  for (const entry of input.snapshot.entries) {
    const stats = await lstat(resolve(destination, entry.path));
    if ((entry.mode === "120000") !== stats.isSymbolicLink()) {
      throw new WorkspaceError("WORKSPACE_COPY_DRIFT", `Materialized mode mismatch: ${entry.path}`);
    }
  }
  return destination;
}
