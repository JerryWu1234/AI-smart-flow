import type { ProjectState, RunRecord } from "@smartflow/state-store";
import type { RunPhase } from "@smartflow/protocol";

export type RunTransitionErrorCode =
  | "TASK_ALREADY_ACTIVE"
  | "RUN_NOT_FOUND"
  | "TERMINAL_GUARD_FAILED"
  | "TRANSITION_GUARD_FAILED"
  | "TRANSITION_NOT_ALLOWED";

export class RunTransitionError extends Error {
  public readonly code: RunTransitionErrorCode;

  public constructor(code: RunTransitionErrorCode, message: string) {
    super(message);
    this.name = "RunTransitionError";
    this.code = code;
  }
}

export interface TransitionContext {
  manifestValid?: boolean;
  providerCapabilityPassed?: boolean;
  workspaceDurable?: boolean;
  workerStopped?: boolean;
  candidateCurrent?: boolean;
  reviewActionClaimed?: boolean;
  reviewCurrentAndComplete?: boolean;
  leaderAccepted?: boolean;
  candidateIncomplete?: boolean;
  repairItemsValid?: boolean;
  repairOutcomeDurable?: boolean;
  publishAdapterReady?: boolean;
  publishCommitted?: boolean;
  resumeTargetAllowed?: boolean;
  cancellationReceiptDurable?: boolean;
  terminalReconciled?: boolean;
}

const terminalPhases = new Set<RunPhase>(["COMPLETED", "CANCELED", "FAILED"]);

const normalEdges: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  PREPARING: ["RUNNING"],
  RUNNING: ["FIXING", "PAUSED", "REVIEW_PENDING"],
  FIXING: ["PAUSED"],
  REVIEW_PENDING: ["REVIEWING"],
  REVIEWING: ["LEADER_DECISION"],
  LEADER_DECISION: ["READY_TO_PUBLISH", "FIXING", "PAUSED"],
  READY_TO_PUBLISH: ["PUBLISHING", "PAUSED"],
  PUBLISHING: ["COMPLETED", "PAUSED"],
  PAUSED: ["PREPARING", "RUNNING", "REVIEW_PENDING", "LEADER_DECISION", "READY_TO_PUBLISH"],
  CANCELING: ["CANCELED"],
  COMPLETED: [],
  CANCELED: [],
  FAILED: []
};

function allTrue(values: readonly (boolean | undefined)[]): boolean {
  return values.every((value) => value === true);
}

function guardSatisfied(from: RunPhase, to: RunPhase, context: TransitionContext): boolean {
  if (to === "CANCELING") return context.cancellationReceiptDurable === true;
  if (to === "FAILED") return context.terminalReconciled === true;
  if (from === "PREPARING" && to === "RUNNING") {
    return allTrue([
      context.manifestValid,
      context.providerCapabilityPassed,
      context.workspaceDurable
    ]);
  }
  if (from === "RUNNING" && to === "REVIEW_PENDING") {
    return allTrue([context.workerStopped, context.candidateCurrent]);
  }
  if (from === "RUNNING" && to === "FIXING") {
    return allTrue([context.workerStopped, context.candidateIncomplete]);
  }
  if (from === "REVIEW_PENDING" && to === "REVIEWING") {
    return context.reviewActionClaimed === true;
  }
  if (from === "REVIEWING" && to === "LEADER_DECISION") {
    return context.reviewCurrentAndComplete === true;
  }
  if (from === "LEADER_DECISION" && to === "READY_TO_PUBLISH") {
    return allTrue([context.leaderAccepted, context.reviewCurrentAndComplete]);
  }
  if (from === "LEADER_DECISION" && to === "FIXING") {
    return context.repairItemsValid === true;
  }
  if (from === "FIXING" && to === "PAUSED") return context.repairOutcomeDurable === true;
  if (from === "READY_TO_PUBLISH" && to === "PUBLISHING") {
    return context.publishAdapterReady === true;
  }
  if (from === "PUBLISHING" && to === "COMPLETED") {
    return allTrue([context.publishCommitted, context.terminalReconciled]);
  }
  if (from === "CANCELING" && to === "CANCELED") return context.terminalReconciled === true;
  if (from === "PAUSED") return context.resumeTargetAllowed === true;
  return true;
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return terminalPhases.has(phase);
}

export function canTransition(from: RunPhase, to: RunPhase): boolean {
  if (isTerminalPhase(from)) return false;
  if (to === "CANCELING" || to === "FAILED") return true;
  return normalEdges[from].includes(to);
}

export function transitionRun(
  state: ProjectState,
  jobId: string,
  to: RunPhase,
  context: TransitionContext
): ProjectState {
  const run = state.runs[jobId];
  if (run === undefined) throw new RunTransitionError("RUN_NOT_FOUND", `Unknown run: ${jobId}`);
  if (!canTransition(run.phase, to)) {
    throw new RunTransitionError(
      "TRANSITION_NOT_ALLOWED",
      `Transition ${run.phase} -> ${to} is not allowed`
    );
  }
  if (!guardSatisfied(run.phase, to, context)) {
    const code = isTerminalPhase(to) ? "TERMINAL_GUARD_FAILED" : "TRANSITION_GUARD_FAILED";
    throw new RunTransitionError(code, `Transition guard failed for ${run.phase} -> ${to}`);
  }
  const updatedAt = new Date().toISOString();
  const nextRun: RunRecord = { ...run, phase: to, updatedAt };
  const activeRunsByTaskPath = isTerminalPhase(to)
    ? Object.fromEntries(
        Object.entries(state.activeRunsByTaskPath)
          .filter(([taskPath]) => taskPath !== run.canonicalTaskPath)
      )
    : state.activeRunsByTaskPath;
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    activeRunsByTaskPath,
    runs: { ...state.runs, [jobId]: nextRun },
    updatedAt
  };
}
