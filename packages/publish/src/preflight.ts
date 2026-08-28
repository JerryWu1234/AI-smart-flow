import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";

import type { ArtifactRef } from "@smartflow/protocol";

import { canonical, observedFile } from "./internal-utils.js";

export interface ApplyOperation {
  path: string;
  type: "ADD" | "MODIFY" | "DELETE";
  expectedOldKind: "ABSENT" | "FILE";
  expectedOldHash: string | null;
  expectedOldMode: number | null;
  newHash: string | null;
  newMode: number | null;
  blobRef: ArtifactRef | null;
}

export interface PreflightConflict {
  path: string;
  reason: "EXPECTED_ABSENT" | "EXPECTED_FILE" | "HASH_MISMATCH" | "MODE_MISMATCH" | "UNSAFE_PATH";
}



export function canonicalOperations(operations: readonly ApplyOperation[]): ApplyOperation[] {
  const sorted = [...operations].sort((left, right) => left.path.localeCompare(right.path));
  if (sorted.length === 0 || new Set(sorted.map((operation) => operation.path)).size !== sorted.length) {
    throw new Error("PUBLISH_OPERATIONS_EMPTY_OR_DUPLICATE");
  }
  for (const operation of sorted) {
    if (
      operation.path.length === 0 ||
      operation.path.includes("\0") ||
      operation.path.includes("\\") ||
      isAbsolute(operation.path) ||
      operation.path.split("/").includes("..") ||
      posix.normalize(operation.path).startsWith("../")
    ) {
      throw new Error(`PUBLISH_PATH_UNSAFE: ${operation.path}`);
    }
    if (
      (operation.type === "ADD" &&
        (operation.expectedOldKind !== "ABSENT" ||
          operation.expectedOldHash !== null ||
          operation.expectedOldMode !== null ||
          operation.newHash === null ||
          operation.newMode === null ||
          operation.blobRef === null)) ||
      ((operation.type === "MODIFY" || operation.type === "DELETE") &&
        (operation.expectedOldKind !== "FILE" ||
          operation.expectedOldHash === null ||
          operation.expectedOldMode === null)) ||
      (operation.type === "MODIFY" &&
        (operation.newHash === null || operation.newMode === null || operation.blobRef === null)) ||
      (operation.type === "DELETE" &&
        (operation.newHash !== null || operation.newMode !== null || operation.blobRef !== null))
    ) {
      throw new Error(`PUBLISH_OPERATION_INVALID: ${operation.path}`);
    }
  }
  return sorted;
}

export function operationsHash(operations: readonly ApplyOperation[]): string {
  return createHash("sha256")
    .update(canonical(canonicalOperations(operations)), "utf8")
    .digest("hex");
}

export function stableOperationId(bindings: {
  projectId: string;
  jobId: string;
  candidateHash: string;
  reviewHash: string;
  operationsHash: string;
}): string {
  const hashBindings = {
    projectId: bindings.projectId,
    jobId: bindings.jobId,
    candidateHash: bindings.candidateHash,
    reviewHash: bindings.reviewHash,
    operationsHash: bindings.operationsHash
  };
  return `publish-${createHash("sha256").update(canonical(hashBindings), "utf8").digest("hex")}`;
}



async function pathContainsSymlink(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const part of path.split("/")) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

export async function preflightOperations(
  activeWorkspace: string,
  operations: readonly ApplyOperation[]
): Promise<PreflightConflict[]> {
  const conflicts: PreflightConflict[] = [];
  const root = await realpath(activeWorkspace);
  for (const operation of canonicalOperations(operations)) {
    if (await pathContainsSymlink(root, operation.path)) {
      conflicts.push({ path: operation.path, reason: "UNSAFE_PATH" });
      continue;
    }
    const path = resolve(root, operation.path);
    const observed = await observedFile(path);
    if (operation.expectedOldKind === "ABSENT") {
      if (observed !== "ABSENT") conflicts.push({ path: operation.path, reason: "EXPECTED_ABSENT" });
      continue;
    }
    if (observed === "ABSENT" || observed === "OTHER") {
      conflicts.push({ path: operation.path, reason: "EXPECTED_FILE" });
    } else if (observed.hash !== operation.expectedOldHash) {
      conflicts.push({ path: operation.path, reason: "HASH_MISMATCH" });
    } else if (observed.mode !== operation.expectedOldMode) {
      conflicts.push({ path: operation.path, reason: "MODE_MISMATCH" });
    }
  }
  return conflicts;
}

interface TargetStateObservation {
  matches: boolean;
  conflicts: PreflightConflict[];
}

export async function observeTargetState(
  activeWorkspace: string,
  operations: readonly ApplyOperation[]
): Promise<TargetStateObservation> {
  const conflicts: PreflightConflict[] = [];
  const root = await realpath(activeWorkspace);
  for (const operation of canonicalOperations(operations)) {
    if (await pathContainsSymlink(root, operation.path)) {
      conflicts.push({ path: operation.path, reason: "UNSAFE_PATH" });
      continue;
    }
    const observed = await observedFile(resolve(root, operation.path));
    if (operation.type === "DELETE") {
      if (observed !== "ABSENT") conflicts.push({ path: operation.path, reason: "EXPECTED_ABSENT" });
      continue;
    }
    if (observed === "ABSENT" || observed === "OTHER") {
      conflicts.push({ path: operation.path, reason: "EXPECTED_FILE" });
    } else if (observed.hash !== operation.newHash) {
      conflicts.push({ path: operation.path, reason: "HASH_MISMATCH" });
    } else if (observed.mode !== operation.newMode) {
      conflicts.push({ path: operation.path, reason: "MODE_MISMATCH" });
    }
  }
  return { matches: conflicts.length === 0, conflicts };
}
