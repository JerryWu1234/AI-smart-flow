import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { cleanupGitRunTemporaryState } from "../../../../packages/workspace/src/git-cleanup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains active Git state and idempotently removes only terminal temporary state", async () => {
  const data = await mkdtemp(resolve(tmpdir(), "smartflow-cleanup-"));
  roots.push(data);
  const revisionRoot = resolve(data, "runs/job-1/revision-1");
  const workspace = resolve(revisionRoot, "workspace");
  const orphanWorkspace = resolve(revisionRoot, "workspace-orphan");
  const index = resolve(revisionRoot, "result.index");
  const orphanIndex = resolve(revisionRoot, "orphan.index");
  const objectDirectory = resolve(data, "runs/job-1/git-object-store/objects");
  const auditArtifact = resolve(revisionRoot, "snapshots/baseline.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(orphanWorkspace, { recursive: true });
  await mkdir(objectDirectory, { recursive: true });
  await mkdir(resolve(revisionRoot, "snapshots"), { recursive: true });
  await Promise.all([
    writeFile(resolve(workspace, "file.txt"), "temporary"),
    writeFile(index, "index"),
    writeFile(orphanIndex, "index"),
    writeFile(resolve(objectDirectory, "object"), "object"),
    writeFile(auditArtifact, "audit")
  ]);
  const gitWorkspace = {
    objectDirectory: "runs/job-1/git-object-store/objects",
    revisions: {
      "1": {
        indexPath: "runs/job-1/revision-1/result.index",
        workspacePath: "runs/job-1/revision-1/workspace"
      }
    }
  };

  await expect(cleanupGitRunTemporaryState(data, { phase: "RUNNING", gitWorkspace }))
    .rejects.toThrow(/ACTIVE_RUN_FORBIDDEN/u);
  await expect(access(workspace)).resolves.toBeUndefined();

  await cleanupGitRunTemporaryState(data, { phase: "COMPLETED", gitWorkspace });
  await cleanupGitRunTemporaryState(data, { phase: "COMPLETED", gitWorkspace });
  await expect(access(workspace)).rejects.toBeDefined();
  await expect(access(index)).rejects.toBeDefined();
  await expect(access(orphanWorkspace)).rejects.toBeDefined();
  await expect(access(orphanIndex)).rejects.toBeDefined();
  await expect(access(objectDirectory)).rejects.toBeDefined();
  await expect(access(auditArtifact)).resolves.toBeUndefined();
});
