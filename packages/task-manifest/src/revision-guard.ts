import { sha256Bytes } from "./canonicalize.js";

export interface ApprovedRevisionSnapshot {
  revision: number;
  sourceHash: string;
  tasksHash: string;
  taskManifestHash: string;
}

export type ApprovalDriftResult =
  | { matches: true }
  | {
      matches: false;
      pause: {
        code: "APPROVED_SOURCE_DRIFT";
        resumeActions: ["APPROVE_NEW_REVISION", "RESTORE_APPROVED_TASKS"];
      };
    };

export interface RevisionState extends ApprovedRevisionSnapshot {
  candidate: null;
  reviewDecision: null;
  publishResult: null;
}

export function checkApprovedSource(
  approvedSourceHash: string,
  currentSource: string | Uint8Array
): ApprovalDriftResult {
  const bytes =
    typeof currentSource === "string" ? Buffer.from(currentSource, "utf8") : currentSource;
  if (sha256Bytes(bytes) === approvedSourceHash) return { matches: true };
  return {
    matches: false,
    pause: {
      code: "APPROVED_SOURCE_DRIFT",
      resumeActions: ["APPROVE_NEW_REVISION", "RESTORE_APPROVED_TASKS"]
    }
  };
}

export function createRevisionState(snapshot: ApprovedRevisionSnapshot): RevisionState {
  return {
    ...snapshot,
    candidate: null,
    reviewDecision: null,
    publishResult: null
  };
}

export function advanceRevision(
  previous: ApprovedRevisionSnapshot,
  next: Omit<ApprovedRevisionSnapshot, "revision">
): RevisionState {
  return createRevisionState({ ...next, revision: previous.revision + 1 });
}
