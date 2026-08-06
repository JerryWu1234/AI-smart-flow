import { createHash } from "node:crypto";

import {
  canonicalStringify,
  sha256Bytes,
  type TaskManifest
} from "@smartflow/task-manifest";
import type { ArtifactRef } from "@smartflow/protocol";
import { verifyCandidate, type Candidate } from "@smartflow/workspace";

export interface ReviewGitEvidence {
  resultSnapshot: ArtifactRef;
  incrementalPatch: ArtifactRef;
  cumulativePatch: ArtifactRef;
  evidence: ArtifactRef;
}

export interface ReviewChangedPath {
  path: string;
  operation: "ADD" | "MODIFY" | "DELETE";
  oldHash: string | null;
  newHash: string | null;
  diff: string | null;
  blob: string | null;
}

export interface ReviewBundleInput {
  revision: number;
  taskManifest: TaskManifest;
  taskManifestHash: string;
  baselineHash: string;
  candidate: Candidate;
  candidateHash: string;
  changedPathHashes: Record<string, { operation: "ADD" | "MODIFY" | "DELETE"; oldHash: string | null; newHash: string | null }>;
  pathEvidence: ReviewChangedPath[];
  workerSummary: string;
  knownRisks: string[];
  gitEvidence?: ReviewGitEvidence;
}

export interface ReviewBundle extends Omit<ReviewBundleInput, "changedPathHashes" | "pathEvidence"> {
  schemaVersion: 1;
  changedPaths: ReviewChangedPath[];
  bundleHash: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function blobHash(blob: string): string {
  return createHash("sha256").update(Buffer.from(blob, "base64")).digest("hex");
}

function changedPathHashes(candidate: Candidate): ReviewBundleInput["changedPathHashes"] {
  return Object.fromEntries(
    candidate.operations.map((operation) => [
      operation.path,
      {
        operation: operation.kind,
        oldHash: "oldEntry" in operation ? operation.oldEntry.sha256 : null,
        newHash: "newEntry" in operation ? operation.newEntry.sha256 : null
      }
    ])
  );
}

function verifyBindings(input: Omit<ReviewBundle, "schemaVersion" | "bundleHash">): boolean {
  const expectedChanged = changedPathHashes(input.candidate);
  const actualChanged = Object.fromEntries(
    input.changedPaths.map((path) => [
      path.path,
      {
        operation: path.operation,
        oldHash: path.oldHash,
        newHash: path.newHash
      }
    ])
  );
  const gitCandidate = input.candidate as Candidate & {
    schemaVersion?: number;
    evidenceArtifactHash?: string;
  };
  const gitEvidenceValid = gitCandidate.schemaVersion !== 2
    ? input.gitEvidence === undefined
    : input.gitEvidence !== undefined &&
      input.gitEvidence.evidence.sha256.replace(/^sha256:/u, "") === gitCandidate.evidenceArtifactHash;
  return gitEvidenceValid &&
    input.revision === input.taskManifest.revision &&
    input.taskManifestHash === sha256Bytes(Buffer.from(canonicalStringify(input.taskManifest), "utf8")) &&
    verifyCandidate(input.candidate) &&
    input.baselineHash === input.candidate.baselineHash &&
    input.candidateHash === input.candidate.hash &&
    canonical(expectedChanged) === canonical(actualChanged) &&
    input.changedPaths.every((path) =>
      path.operation === "DELETE"
        ? path.diff !== null && path.blob === null
        : path.blob !== null && path.newHash !== null && blobHash(path.blob) === path.newHash
    );
}

export function createReviewBundle(input: ReviewBundleInput): ReviewBundle {
  const expectedPaths = Object.keys(input.changedPathHashes).sort();
  const evidence = [...input.pathEvidence].sort((left, right) => left.path.localeCompare(right.path));
  const approvedNoChange = input.taskManifest.allowNoChange && input.candidate.operations.length === 0;
  if (
    (!approvedNoChange && expectedPaths.length === 0) ||
    JSON.stringify(expectedPaths) !== JSON.stringify(evidence.map((item) => item.path))
  ) {
    throw new Error("REVIEW_PATH_COVERAGE_INCOMPLETE");
  }
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.path)) throw new Error("REVIEW_PATH_DUPLICATE");
    seen.add(item.path);
    const expected = input.changedPathHashes[item.path];
    if (
      expected === undefined ||
      item.operation !== expected.operation ||
      item.oldHash !== expected.oldHash ||
      item.newHash !== expected.newHash ||
      (item.diff === null && item.blob === null)
    ) {
      throw new Error(`REVIEW_PATH_EVIDENCE_INVALID: ${item.path}`);
    }
  }
  if (input.revision < 1) throw new Error("REVIEW_REVISION_INVALID");
  const body = {
    revision: input.revision,
    taskManifest: input.taskManifest,
    taskManifestHash: input.taskManifestHash,
    baselineHash: input.baselineHash,
    candidate: input.candidate,
    candidateHash: input.candidateHash,
    changedPaths: evidence,
    workerSummary: input.workerSummary,
    knownRisks: [...input.knownRisks],
    ...(input.gitEvidence === undefined ? {} : { gitEvidence: input.gitEvidence })
  };
  if (!verifyBindings(body)) throw new Error("REVIEW_EVIDENCE_BINDING_INVALID");
  const versioned = { schemaVersion: 1 as const, ...body };
  return { ...versioned, bundleHash: hash(versioned) };
}

export function verifyReviewBundle(bundle: ReviewBundle): boolean {
  const { bundleHash, schemaVersion, ...body } = bundle;
  return verifyBindings(body) && hash({ schemaVersion, ...body }) === bundleHash;
}
