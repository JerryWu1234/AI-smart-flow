import { createHash } from "node:crypto";

import { runGitCommand } from "./git-command.js";
import type { GitSnapshotEntry, GitWorkspaceSnapshot } from "./git-snapshot.js";
import { canonical } from "./internal-utils.js";

export type CandidateEntry =
  | { path: string; kind: "FILE"; sha256: string; size: number; mode: number }
  | { path: string; kind: "SYMLINK"; sha256: string; target: string; mode: number };

export type CandidateOperation =
  | { kind: "ADD"; path: string; newEntry: CandidateEntry }
  | { kind: "MODIFY"; path: string; oldEntry: CandidateEntry; newEntry: CandidateEntry }
  | { kind: "DELETE"; path: string; oldEntry: CandidateEntry };

export interface Candidate {
  baselineHash: string;
  operations: CandidateOperation[];
  hash: string;
}

export interface GitCandidate extends Candidate {
  schemaVersion: 2;
  revision: number;
  runBaselineSnapshotHash: string;
  inputSnapshotHash: string;
  resultSnapshotHash: string;
  runBaselineTreeId: string;
  inputTreeId: string;
  resultTreeId: string;
  blobs: Record<string, { oldBlobId: string | null; newBlobId: string | null }>;
  modes: Record<string, { oldMode: string | null; newMode: string | null }>;
  evidenceArtifactHash: string;
  candidateHash: string;
}

export interface GitCandidateBuildResult {
  candidate: GitCandidate;
  incrementalPatch: Buffer;
  cumulativePatch: Buffer;
  evidenceBytes: Buffer;
}



function candidateHash(candidate: Pick<Candidate, "baselineHash" | "operations">): string {
  return createHash("sha256")
    .update(canonical({ baselineHash: candidate.baselineHash, operations: candidate.operations }), "utf8")
    .digest("hex");
}

export function verifyCandidate(candidate: Candidate): boolean {
  if ((candidate as Partial<GitCandidate>).schemaVersion === 2) {
    const gitCandidate = candidate as GitCandidate;
    const hashBody = {
      revision: gitCandidate.revision,
      runBaselineSnapshotHash: gitCandidate.runBaselineSnapshotHash,
      inputSnapshotHash: gitCandidate.inputSnapshotHash,
      resultSnapshotHash: gitCandidate.resultSnapshotHash,
      operations: gitCandidate.operations,
      evidenceArtifactHash: gitCandidate.evidenceArtifactHash
    };
    return /^[a-f0-9]{64}$/u.test(gitCandidate.baselineHash) &&
      gitCandidate.baselineHash === gitCandidate.runBaselineSnapshotHash &&
      gitCandidate.hash === gitCandidate.candidateHash &&
      gitCandidate.hash === createHash("sha256").update(canonical(hashBody), "utf8").digest("hex");
  }
  return /^[a-f0-9]{64}$/u.test(candidate.baselineHash) &&
    candidate.hash === candidateHash(candidate);
}

function candidateEntry(entry: GitSnapshotEntry): CandidateEntry {
  if (entry.kind === "SYMLINK") {
    if (entry.target === undefined) throw new Error(`GIT_SYMLINK_TARGET_MISSING: ${entry.path}`);
    return {
      path: entry.path,
      kind: "SYMLINK",
      sha256: entry.sha256,
      target: entry.target,
      mode: 0o777
    };
  }
  return {
    path: entry.path,
    kind: "FILE",
    sha256: entry.sha256,
    size: entry.size,
    mode: entry.mode === "100755" ? 0o755 : 0o644
  };
}

function gitOperations(
  baseline: GitWorkspaceSnapshot,
  result: GitWorkspaceSnapshot
): CandidateOperation[] {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(result.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const operations: CandidateOperation[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      operations.push({ kind: "ADD", path, newEntry: candidateEntry(newEntry) });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      operations.push({ kind: "DELETE", path, oldEntry: candidateEntry(oldEntry) });
    } else if (oldEntry !== undefined && newEntry !== undefined &&
      (oldEntry.blobId !== newEntry.blobId || oldEntry.mode !== newEntry.mode)) {
      operations.push({
        kind: "MODIFY",
        path,
        oldEntry: candidateEntry(oldEntry),
        newEntry: candidateEntry(newEntry)
      });
    }
  }
  return operations;
}

async function gitPatch(
  runGitDirectory: string,
  oldTree: string,
  newTree: string,
  gitBinary: string
): Promise<Buffer> {
  return (await runGitCommand(gitBinary, [
    "--git-dir", runGitDirectory, "diff", "--binary", "--full-index", "--no-ext-diff",
    "--no-renames", oldTree, newTree
  ])).stdout;
}

export async function buildGitCandidate(input: {
  runGitDirectory: string;
  runBaseline: GitWorkspaceSnapshot;
  revisionInput: GitWorkspaceSnapshot;
  revisionResult: GitWorkspaceSnapshot;
  gitBinary?: string;
}): Promise<GitCandidateBuildResult> {
  const gitBinary = input.gitBinary ?? "git";
  if (
    input.runBaseline.repositoryId !== input.revisionInput.repositoryId ||
    input.runBaseline.repositoryId !== input.revisionResult.repositoryId ||
    !new Set([
      input.revisionResult.revision,
      input.revisionResult.revision - 1
    ]).has(input.revisionInput.revision)
  ) {
    throw new Error("GIT_CANDIDATE_SNAPSHOT_BINDING_INVALID");
  }
  const operations = gitOperations(input.runBaseline, input.revisionResult);
  const baselineEntries = new Map(input.runBaseline.entries.map((entry) => [entry.path, entry]));
  const resultEntries = new Map(input.revisionResult.entries.map((entry) => [entry.path, entry]));
  const blobs = Object.fromEntries(operations.map((operation) => [
    operation.path,
    {
      oldBlobId: baselineEntries.get(operation.path)?.blobId ?? null,
      newBlobId: resultEntries.get(operation.path)?.blobId ?? null
    }
  ]));
  const modes = Object.fromEntries(operations.map((operation) => [
    operation.path,
    {
      oldMode: baselineEntries.get(operation.path)?.mode ?? null,
      newMode: resultEntries.get(operation.path)?.mode ?? null
    }
  ]));
  const [incrementalPatch, cumulativePatch] = await Promise.all([
    gitPatch(input.runGitDirectory, input.revisionInput.treeId, input.revisionResult.treeId, gitBinary),
    gitPatch(input.runGitDirectory, input.runBaseline.treeId, input.revisionResult.treeId, gitBinary)
  ]);
  const evidenceBody = {
    revision: input.revisionResult.revision,
    runBaselineTreeId: input.runBaseline.treeId,
    inputTreeId: input.revisionInput.treeId,
    resultTreeId: input.revisionResult.treeId,
    blobs,
    modes,
    incrementalPatchHash: createHash("sha256").update(incrementalPatch).digest("hex"),
    cumulativePatchHash: createHash("sha256").update(cumulativePatch).digest("hex")
  };
  const evidenceBytes = Buffer.from(canonical(evidenceBody), "utf8");
  const evidenceArtifactHash = createHash("sha256").update(evidenceBytes).digest("hex");
  const candidateHashBody = {
    revision: input.revisionResult.revision,
    runBaselineSnapshotHash: input.runBaseline.snapshotHash,
    inputSnapshotHash: input.revisionInput.snapshotHash,
    resultSnapshotHash: input.revisionResult.snapshotHash,
    operations,
    evidenceArtifactHash
  };
  const candidateHash = createHash("sha256").update(canonical(candidateHashBody), "utf8").digest("hex");
  const candidate: GitCandidate = {
    schemaVersion: 2,
    revision: input.revisionResult.revision,
    baselineHash: input.runBaseline.snapshotHash,
    operations,
    hash: candidateHash,
    runBaselineSnapshotHash: input.runBaseline.snapshotHash,
    inputSnapshotHash: input.revisionInput.snapshotHash,
    resultSnapshotHash: input.revisionResult.snapshotHash,
    runBaselineTreeId: input.runBaseline.treeId,
    inputTreeId: input.revisionInput.treeId,
    resultTreeId: input.revisionResult.treeId,
    blobs,
    modes,
    evidenceArtifactHash,
    candidateHash
  };
  return { candidate, incrementalPatch, cumulativePatch, evidenceBytes };
}
