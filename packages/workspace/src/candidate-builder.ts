import { createHash } from "node:crypto";

import {
  isSmartFlowControlPlanePath,
  verifyGitWorkspaceSnapshot,
  type GitSnapshotEntry,
  type GitWorkspaceSnapshot
} from "./git-snapshot.js";
import { canonical } from "./internal-utils.js";

export type CandidateEntry =
  | { path: string; kind: "FILE"; sha256: string; size: number; mode: number }
  | { path: string; kind: "SYMLINK"; sha256: string; target: string; mode: number };

export type CandidateOperation =
  | { kind: "ADD"; path: string; newEntry: CandidateEntry }
  | { kind: "MODIFY"; path: string; oldEntry: CandidateEntry; newEntry: CandidateEntry }
  | { kind: "DELETE"; path: string; oldEntry: CandidateEntry };

export interface Candidate {
  runBaselineSnapshotHash: string;
  resultSnapshotHash: string;
  operations: CandidateOperation[];
  candidateHash: string;
}

export interface GitCandidateBuildResult {
  candidate: Candidate;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitCandidateHash(
  candidate: Omit<Candidate, "candidateHash">
): string {
  return sha256(canonical(candidate));
}

function controlPlaneOperationPath(operations: readonly CandidateOperation[]): string | undefined {
  return operations.find((operation) => isSmartFlowControlPlanePath(operation.path))?.path;
}

function hasValidOperationPaths(value: unknown): value is CandidateOperation[] {
  return Array.isArray(value) && value.every((operation) => {
    if (typeof operation !== "object" || operation === null) return false;
    const path = (operation as { path?: unknown }).path;
    return typeof path === "string" && !isSmartFlowControlPlanePath(path);
  });
}

export function getCandidateHash(candidate: Candidate): string {
  return candidate.candidateHash;
}

export function getCandidateBaselineHash(candidate: Candidate): string {
  return candidate.runBaselineSnapshotHash;
}

export function verifyCandidate(candidate: Candidate): boolean {
  const expectedKeys = [
    "candidateHash",
    "operations",
    "resultSnapshotHash",
    "runBaselineSnapshotHash"
  ];
  if (Object.keys(candidate).sort().join("\0") !== expectedKeys.join("\0")) return false;
  if (!hasValidOperationPaths((candidate as { operations?: unknown }).operations)) return false;
  const hashBody: Omit<Candidate, "candidateHash"> = {
    runBaselineSnapshotHash: candidate.runBaselineSnapshotHash,
    resultSnapshotHash: candidate.resultSnapshotHash,
    operations: candidate.operations
  };
  return /^[a-f0-9]{64}$/u.test(candidate.runBaselineSnapshotHash) &&
    /^[a-f0-9]{64}$/u.test(candidate.resultSnapshotHash) &&
    /^[a-f0-9]{64}$/u.test(candidate.candidateHash) &&
    candidate.candidateHash === gitCandidateHash(hashBody);
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

export function verifyCandidateSnapshotBindings(input: {
  candidate: Candidate;
  runBaseline: GitWorkspaceSnapshot;
  runResult: GitWorkspaceSnapshot;
}): boolean {
  const { candidate, runBaseline, runResult } = input;
  return verifyCandidate(candidate) &&
    verifyGitWorkspaceSnapshot(runBaseline) &&
    verifyGitWorkspaceSnapshot(runResult) &&
    runBaseline.snapshotKind === "RUN_BASELINE" &&
    runResult.snapshotKind === "RUN_RESULT" &&
    runBaseline.repositoryId === runResult.repositoryId &&
    runBaseline.includedPathPolicyHash === runResult.includedPathPolicyHash &&
    candidate.runBaselineSnapshotHash === runBaseline.snapshotHash &&
    candidate.resultSnapshotHash === runResult.snapshotHash &&
    canonical(candidate.operations) === canonical(gitOperations(runBaseline, runResult));
}

export function buildGitCandidate(input: {
  runBaseline: GitWorkspaceSnapshot;
  runResult: GitWorkspaceSnapshot;
}): Promise<GitCandidateBuildResult> {
  if (
    !verifyGitWorkspaceSnapshot(input.runBaseline) ||
    !verifyGitWorkspaceSnapshot(input.runResult) ||
    input.runBaseline.snapshotKind !== "RUN_BASELINE" ||
    input.runResult.snapshotKind !== "RUN_RESULT" ||
    input.runBaseline.repositoryId !== input.runResult.repositoryId ||
    input.runBaseline.includedPathPolicyHash !== input.runResult.includedPathPolicyHash
  ) {
    throw new Error("GIT_CANDIDATE_SNAPSHOT_BINDING_INVALID");
  }
  const operations = gitOperations(input.runBaseline, input.runResult);
  const forbiddenPath = controlPlaneOperationPath(operations);
  if (forbiddenPath !== undefined) {
    throw new Error(`GIT_CANDIDATE_CONTROL_PATH_FORBIDDEN: ${forbiddenPath}`);
  }
  const hashBody: Omit<Candidate, "candidateHash"> = {
    runBaselineSnapshotHash: input.runBaseline.snapshotHash,
    resultSnapshotHash: input.runResult.snapshotHash,
    operations
  };
  return Promise.resolve({
    candidate: {
      ...hashBody,
      candidateHash: gitCandidateHash(hashBody)
    }
  });
}
