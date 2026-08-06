import type { ProjectState, RunRecord } from "@smartflow/state-store";

import { RunTransitionError, transitionRun, type TransitionContext } from "./run-state-machine.js";

export function createActiveRun(state: ProjectState, run: RunRecord): ProjectState {
  const activeJobId = state.activeRunsByTaskPath[run.canonicalTaskPath];
  if (activeJobId !== undefined) {
    throw new RunTransitionError(
      "TASK_ALREADY_ACTIVE",
      `Task file already has an active run: ${activeJobId}`
    );
  }
  if (state.runs[run.jobId] !== undefined) {
    throw new RunTransitionError("TASK_ALREADY_ACTIVE", `Run already exists: ${run.jobId}`);
  }
  const updatedAt = new Date().toISOString();
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    activeRunsByTaskPath: {
      ...state.activeRunsByTaskPath,
      [run.canonicalTaskPath]: run.jobId
    },
    runs: { ...state.runs, [run.jobId]: { ...run, updatedAt } },
    updatedAt
  };
}

export class RunOrchestrator {
  private state: ProjectState;

  public constructor(initialState: ProjectState) {
    this.state = initialState;
  }

  public snapshot(): ProjectState {
    return structuredClone(this.state);
  }

  public start(run: RunRecord): ProjectState {
    this.state = createActiveRun(this.state, run);
    return this.snapshot();
  }

  public transition(jobId: string, phase: RunRecord["phase"], context: TransitionContext): ProjectState {
    this.state = transitionRun(this.state, jobId, phase, context);
    return this.snapshot();
  }
}
