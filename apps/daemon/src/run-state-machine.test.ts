import { describe, expect, it } from "vitest";

import { runPhaseSchema, type RunPhase } from "@smartflow/protocol";
import {
  createProjectState,
  createRunRecord
} from "../../../packages/state-store/src/test-fixture.js";
import type { ProjectState } from "@smartflow/state-store";
import {
  RunTransitionError,
  canTransition,
  transitionRun,
  type TransitionContext
} from "./run-state-machine.js";
import { createActiveRun } from "./run-orchestrator.js";

const allGuards: TransitionContext = {
  manifestValid: true,
  providerCapabilityPassed: true,
  workspaceDurable: true,
  workerStopped: true,
  candidateCurrent: true,
  reviewActionClaimed: true,
  reviewCurrentAndComplete: true,
  leaderAccepted: true,
  candidateIncomplete: true,
  repairItemsValid: true,
  repairOutcomeDurable: true,
  publishAdapterReady: true,
  publishCommitted: true,
  resumeTargetAllowed: true,
  cancellationReceiptDurable: true,
  terminalReconciled: true
};

function stateAt(phase: RunPhase): ProjectState {
  const run = createRunRecord({ phase });
  return createProjectState({
    activeRunsByTaskPath: { [run.canonicalTaskPath]: run.jobId },
    runs: { [run.jobId]: run }
  });
}

describe("run state machine", () => {
  it("exhaustively accepts only declared transitions", () => {
    for (const from of runPhaseSchema.options) {
      for (const to of runPhaseSchema.options) {
        const state = stateAt(from);
        if (canTransition(from, to)) {
          expect(transitionRun(state, "job-1", to, allGuards).runs["job-1"]?.phase).toBe(to);
        } else {
          expect(() => transitionRun(state, "job-1", to, allGuards)).toThrow(
            RunTransitionError
          );
          expect(state.stateVersion).toBe(0);
          expect(state.runs["job-1"]?.phase).toBe(from);
        }
      }
    }
  });

  it("does not mutate stateVersion when a transition guard fails", () => {
    const state = stateAt("PREPARING");
    expect(() => transitionRun(state, "job-1", "RUNNING", {})).toThrow(
      expect.objectContaining({ code: "TRANSITION_GUARD_FAILED" })
    );
    expect(state.stateVersion).toBe(0);
    expect(state.runs["job-1"]?.phase).toBe("PREPARING");
  });

  it("enforces one active Run per task path and permits different task files", () => {
    const state = createProjectState();
    const started = createActiveRun(state, createRunRecord());
    expect(() => createActiveRun(started, createRunRecord({ jobId: "job-2" }))).toThrow(
      expect.objectContaining({ code: "TASK_ALREADY_ACTIVE" })
    );
    const second = createRunRecord({
      jobId: "job-2",
      canonicalTaskPath: "/project/tasks-b.md",
      taskManifest: { ...createRunRecord().taskManifest, relativePath: "runs/job-2/task-manifest.json" },
      taskSource: { ...createRunRecord().taskSource, relativePath: "runs/job-2/revision-1/task-source.md" }
    });
    const concurrent = createActiveRun(started, second);
    expect(Object.keys(concurrent.activeRunsByTaskPath)).toHaveLength(2);
    const canceling = transitionRun(concurrent, "job-1", "CANCELING", {
      cancellationReceiptDurable: true
    });
    const canceled = transitionRun(canceling, "job-1", "CANCELED", {
      terminalReconciled: true
    });
    expect(canceled.activeRunsByTaskPath).toEqual({ "/project/tasks-b.md": "job-2" });
  });
});
