import { readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface GitCleanupRun {
  phase: string;
  gitWorkspace?: {
    objectDirectory: string;
    revisions: Record<string, {
      indexPath: string;
      workspacePath: string;
    }>;
  } | undefined;
}

function resolvedChild(dataDirectory: string, path: string): string {
  const root = resolve(dataDirectory);
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) throw new Error("GIT_CLEANUP_PATH_UNSAFE");
  return target;
}

export async function cleanupGitRunTemporaryState(
  dataDirectory: string,
  run: GitCleanupRun
): Promise<void> {
  if (!new Set(["COMPLETED", "CANCELED", "FAILED"]).has(run.phase)) {
    throw new Error("GIT_CLEANUP_ACTIVE_RUN_FORBIDDEN");
  }
  const gitWorkspace = run.gitWorkspace;
  if (gitWorkspace === undefined) return;
  for (const revision of Object.values(gitWorkspace.revisions)) {
    const indexPath = resolvedChild(dataDirectory, revision.indexPath);
    const revisionDirectory = dirname(indexPath);
    await rm(resolvedChild(dataDirectory, revision.workspacePath), { recursive: true, force: true });
    const entries = await readdir(revisionDirectory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if ((entry.isDirectory() && entry.name.startsWith("workspace-")) || entry.name.endsWith(".index")) {
        await rm(resolve(revisionDirectory, entry.name), { recursive: true, force: true });
      }
    }
  }
  const objectDirectory = resolvedChild(dataDirectory, gitWorkspace.objectDirectory);
  const gitDirectory = dirname(objectDirectory);
  resolvedChild(dataDirectory, relative(resolve(dataDirectory), gitDirectory));
  await rm(gitDirectory, { recursive: true, force: true });
}
