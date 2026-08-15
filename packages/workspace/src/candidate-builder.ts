import { createHash } from "node:crypto";

import { runGitCommand } from "./git-command.js";
import {
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

/** Unversioned Candidate persisted before the Git-backed Candidate schemas. */
export interface LegacyCandidate {
  schemaVersion?: 1;
  baselineHash: string;
  operations: CandidateOperation[];
  hash: string;
}

/** Persisted v2 shape retained for recovery and artifact verification only. */
export interface GitCandidateV2 {
  schemaVersion: 2;
  revision: number;
  baselineHash: string;
  operations: CandidateOperation[];
  hash: string;
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

/** Current minimal Candidate. Tree/blob/mode evidence is derivable from the bound snapshots. */
export interface GitCandidateV3 {
  schemaVersion: 3;
  revision: number;
  runBaselineSnapshotHash: string;
  inputSnapshotHash: string;
  resultSnapshotHash: string;
  operations: CandidateOperation[];
  candidateHash: string;
}

export type GitCandidate = GitCandidateV2 | GitCandidateV3;
export type Candidate = LegacyCandidate | GitCandidate;

export interface GitCandidateBuildResult {
  candidate: GitCandidateV3;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legacyCandidateHash(candidate: Pick<LegacyCandidate, "baselineHash" | "operations">): string {
  return sha256(canonical({ baselineHash: candidate.baselineHash, operations: candidate.operations }));
}

function gitCandidateV3Hash(
  candidate: Omit<GitCandidateV3, "candidateHash">
): string {
  return sha256(canonical(candidate));
}

export function getCandidateHash(candidate: Candidate): string {
  return candidate.schemaVersion === 3 ? candidate.candidateHash : candidate.hash;
}

export function getCandidateBaselineHash(candidate: Candidate): string {
  return candidate.schemaVersion === 3
    ? candidate.runBaselineSnapshotHash
    : candidate.baselineHash;
}

export function verifyCandidate(candidate: Candidate): boolean {
  if (candidate.schemaVersion === 2) {
    const hashBody = {
      revision: candidate.revision,
      runBaselineSnapshotHash: candidate.runBaselineSnapshotHash,
      inputSnapshotHash: candidate.inputSnapshotHash,
      resultSnapshotHash: candidate.resultSnapshotHash,
      operations: candidate.operations,
      evidenceArtifactHash: candidate.evidenceArtifactHash
    };
    return /^[a-f0-9]{64}$/u.test(candidate.baselineHash) &&
      candidate.baselineHash === candidate.runBaselineSnapshotHash &&
      candidate.hash === candidate.candidateHash &&
      candidate.hash === sha256(canonical(hashBody));
  }
  if (candidate.schemaVersion === 3) {
    const { candidateHash, ...hashBody } = candidate;
    return Number.isInteger(candidate.revision) &&
      candidate.revision > 0 &&
      /^[a-f0-9]{64}$/u.test(candidate.runBaselineSnapshotHash) &&
      /^[a-f0-9]{64}$/u.test(candidate.inputSnapshotHash) &&
      /^[a-f0-9]{64}$/u.test(candidate.resultSnapshotHash) &&
      /^[a-f0-9]{64}$/u.test(candidateHash) &&
      candidateHash === gitCandidateV3Hash(hashBody);
  }
  return /^[a-f0-9]{64}$/u.test(candidate.baselineHash) &&
    candidate.hash === legacyCandidateHash(candidate);
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
  revisionInput: GitWorkspaceSnapshot;
  revisionResult: GitWorkspaceSnapshot;
}): boolean {
  const { candidate, runBaseline, revisionInput, revisionResult } = input;
  if (
    !verifyCandidate(candidate) ||
    !verifyGitWorkspaceSnapshot(runBaseline) ||
    !verifyGitWorkspaceSnapshot(revisionInput) ||
    !verifyGitWorkspaceSnapshot(revisionResult)
  ) return false;
  const revision = candidate.schemaVersion === 2 || candidate.schemaVersion === 3
    ? candidate.revision
    : revisionResult.revision;
  if (
    runBaseline.snapshotKind !== "RUN_BASELINE" ||
    runBaseline.revision !== 1 ||
    revisionResult.snapshotKind !== "REVISION_RESULT" ||
    revisionResult.revision !== revision ||
    runBaseline.repositoryId !== revisionInput.repositoryId ||
    runBaseline.repositoryId !== revisionResult.repositoryId ||
    runBaseline.includedPathPolicyHash !== revisionInput.includedPathPolicyHash ||
    runBaseline.includedPathPolicyHash !== revisionResult.includedPathPolicyHash ||
    (revision === 1
      ? revisionInput.snapshotHash !== runBaseline.snapshotHash
      : revisionInput.snapshotKind !== "REVISION_RESULT" ||
        revisionInput.revision !== revision - 1) ||
    canonical(candidate.operations) !== canonical(gitOperations(runBaseline, revisionResult))
  ) return false;
  if (candidate.schemaVersion === 3) {
    return candidate.runBaselineSnapshotHash === runBaseline.snapshotHash &&
      candidate.inputSnapshotHash === revisionInput.snapshotHash &&
      candidate.resultSnapshotHash === revisionResult.snapshotHash;
  }
  if (candidate.schemaVersion === 2) {
    const baselineEntries = new Map(runBaseline.entries.map((entry) => [entry.path, entry]));
    const resultEntries = new Map(revisionResult.entries.map((entry) => [entry.path, entry]));
    const blobs = Object.fromEntries(candidate.operations.map((operation) => [
      operation.path,
      {
        oldBlobId: baselineEntries.get(operation.path)?.blobId ?? null,
        newBlobId: resultEntries.get(operation.path)?.blobId ?? null
      }
    ]));
    const modes = Object.fromEntries(candidate.operations.map((operation) => [
      operation.path,
      {
        oldMode: baselineEntries.get(operation.path)?.mode ?? null,
        newMode: resultEntries.get(operation.path)?.mode ?? null
      }
    ]));
    return candidate.runBaselineSnapshotHash === runBaseline.snapshotHash &&
      candidate.inputSnapshotHash === revisionInput.snapshotHash &&
      candidate.resultSnapshotHash === revisionResult.snapshotHash &&
      candidate.runBaselineTreeId === runBaseline.treeId &&
      candidate.inputTreeId === revisionInput.treeId &&
      candidate.resultTreeId === revisionResult.treeId &&
      canonical(candidate.blobs) === canonical(blobs) &&
      canonical(candidate.modes) === canonical(modes);
  }
  return candidate.baselineHash === runBaseline.snapshotHash;
}

export async function buildGitTreePatch(input: {
  runGitDirectory: string;
  baseTreeId: string;
  resultTreeId: string;
  gitBinary?: string;
}): Promise<Buffer> {
  return (await runGitCommand(input.gitBinary ?? "git", [
    "--git-dir", input.runGitDirectory, "diff", "--binary", "--full-index", "--no-ext-diff",
    "--no-renames", input.baseTreeId, input.resultTreeId
  ])).stdout;
}

export function buildGitCandidate(input: {
  runBaseline: GitWorkspaceSnapshot;
  revisionInput: GitWorkspaceSnapshot;
  revisionResult: GitWorkspaceSnapshot;
}): Promise<GitCandidateBuildResult> {
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
  const hashBody: Omit<GitCandidateV3, "candidateHash"> = {
    schemaVersion: 3,
    revision: input.revisionResult.revision,
    runBaselineSnapshotHash: input.runBaseline.snapshotHash,
    inputSnapshotHash: input.revisionInput.snapshotHash,
    resultSnapshotHash: input.revisionResult.snapshotHash,
    operations: gitOperations(input.runBaseline, input.revisionResult)
  };
  return Promise.resolve({
    candidate: {
      ...hashBody,
      candidateHash: gitCandidateV3Hash(hashBody)
    }
  });
}
