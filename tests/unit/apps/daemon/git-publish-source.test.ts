import { describe, expect, it } from "vitest";

import { gitPublishOperations } from "../../../../apps/daemon/src/publish/git-publish-source.js";
import type { Candidate, GitWorkspaceSnapshot } from "@smartflow/workspace";

const digest = "a".repeat(64);

function resultSnapshot(): GitWorkspaceSnapshot {
  return {
    repositoryId: "b".repeat(64),
    activeWorktreeRoot: ".",
    snapshotKind: "RUN_RESULT",
    treeId: "c".repeat(40),
    snapshotHash: digest,
    includedPathPolicyHash: "d".repeat(64),
    entries: [],
    createdAt: "2026-08-25T00:00:00.000Z"
  };
}

describe("Git publish source", () => {
  it("blocks SmartFlow task control-plane operations before preflight", () => {
    const path = ".smartflow/tasks/request-1/tasks.md";
    const candidate: Candidate = {
      runBaselineSnapshotHash: "e".repeat(64),
      resultSnapshotHash: digest,
      candidateHash: "f".repeat(64),
      operations: [{
        kind: "ADD",
        path,
        newEntry: {
          path,
          kind: "FILE",
          sha256: "1".repeat(64),
          size: 5,
          mode: 0o644
        }
      }]
    };

    expect(() => gitPublishOperations(candidate, resultSnapshot()))
      .toThrow(`PUBLISH_CONTROL_PLANE_OPERATION_BLOCKED: ${path}`);
  });
});
