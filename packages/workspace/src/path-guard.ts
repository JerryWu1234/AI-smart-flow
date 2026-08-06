import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { WorkspaceError } from "./errors.js";

export interface GuardedWorkspacePath {
  root: string;
  relativePath: string;
  absolutePath: string;
  parentPath: string;
  parentDevice: number;
  parentInode: number;
}

function ensureInside(root: string, target: string): void {
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the workspace");
  }
}

export async function guardWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  allowMissing = false
): Promise<GuardedWorkspacePath> {
  if (
    requestedPath.length === 0 ||
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/u).includes("..")
  ) {
    throw new WorkspaceError("PATH_TRAVERSAL", `Unsafe workspace path: ${requestedPath}`);
  }
  const root = await realpath(workspaceRoot);
  const parts = requestedPath.split(/[\\/]/u).filter((part) => part.length > 0 && part !== ".");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    ensureInside(root, current);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new WorkspaceError("SYMLINK_REJECTED", `Symlink path component rejected: ${requestedPath}`);
      }
      if (index < parts.length - 1 && !stats.isDirectory()) {
        throw new WorkspaceError("PATH_TRAVERSAL", `Non-directory path component: ${requestedPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing && index === parts.length - 1) {
        break;
      }
      throw error;
    }
  }
  if (!allowMissing) ensureInside(root, await realpath(current));
  const parentPath = parts.length === 0 ? root : resolve(current, "..");
  const parent = await lstat(parentPath);
  if (!parent.isDirectory()) throw new WorkspaceError("PATH_TRAVERSAL", "Target parent is not a directory");
  return {
    root,
    relativePath: parts.join("/"),
    absolutePath: current,
    parentPath,
    parentDevice: parent.dev,
    parentInode: parent.ino
  };
}

export async function revalidateGuardedPath(guard: GuardedWorkspacePath): Promise<void> {
  const parent = await lstat(guard.parentPath);
  if (
    !parent.isDirectory() ||
    parent.dev !== guard.parentDevice ||
    parent.ino !== guard.parentInode
  ) {
    throw new WorkspaceError("SYMLINK_REJECTED", "Workspace parent changed after authorization");
  }
  ensureInside(guard.root, await realpath(guard.parentPath));
  try {
    const target = await lstat(guard.absolutePath);
    if (target.isSymbolicLink()) {
      throw new WorkspaceError("SYMLINK_REJECTED", "Target changed into a symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
