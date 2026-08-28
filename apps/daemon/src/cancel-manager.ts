import type { RunPhase } from "@smartflow/protocol";
import {
  StateStore,
  type ProjectState,
  type RunRecord,
  type WorkerAttempt
} from "@smartflow/state-store";
import { cleanupGitRunTemporaryState } from "@smartflow/workspace";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";

export interface CancellationRuntime {
  stopWorker(attempt: WorkerAttempt | undefined): Promise<boolean>;
  revokeAction(actionId: string): Promise<boolean>;
}

export interface CancellationResult {
  jobId: string;
  phase: RunPhase;
  stateVersion: number;
  reconciled: boolean;
  blockedReasons: string[];
}

function currentAttempt(run: RunRecord): WorkerAttempt | undefined {
  return run.workerAttempts.at(-1);
}

function actionId(run: RunRecord): string | undefined {
  const value = run.pendingAction?.actionId;
  return typeof value === "string" ? value : undefined;
}

function nextStateWithRun(
  state: ProjectState,
  jobId: string,
  mutate: (run: RunRecord) => RunRecord,
  terminal = false
): ProjectState {
  const run = state.runs[jobId];
  if (run === undefined) throw new Error(`Unknown cancellation run: ${jobId}`);
  const updatedAt = new Date().toISOString();
  const activeRunsByTaskPath = terminal
    ? Object.fromEntries(Object.entries(state.activeRunsByTaskPath)
        .filter(([taskPath]) => taskPath !== run.canonicalTaskPath))
    : state.activeRunsByTaskPath;
  return {
    ...state,
    activeRunsByTaskPath,
    runs: { ...state.runs, [jobId]: { ...mutate(run), updatedAt } },
    updatedAt
  };
}

function cancelActiveAttempt(run: RunRecord, endedAt: string): WorkerAttempt[] {
  const active = currentAttempt(run);
  if (active === undefined || !new Set(["PREPARING", "RUNNING"]).has(active.status)) {
    return run.workerAttempts;
  }
  return run.workerAttempts.map((attempt) => attempt.attemptId === active.attemptId
    ? { ...attempt, status: "CANCELED" as const, terminalReason: "RUN_CANCELED", endedAt }
    : attempt);
}

export class CancelManager {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly runtime: CancellationRuntime
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async reconcile(jobId: string): Promise<CancellationResult> {
    const state = await this.store.readState();
    const run = state.runs[jobId];
    if (run === undefined) throw new Error(`Unknown cancellation run: ${jobId}`);
    if (run.phase === "CANCELED") return this.result(state, run, true, []);
    if (run.phase !== "CANCELING") throw new Error("Cancellation reconciliation requires CANCELING");

    const blockedReasons: string[] = [];
    const attempt = currentAttempt(run);
    if (!(await this.runtime.stopWorker(attempt).catch(() => false))) {
      blockedReasons.push("WORKER_STOP_UNCONFIRMED");
    }
    const pendingActionId = actionId(run);
    if (
      pendingActionId !== undefined &&
      !(await this.runtime.revokeAction(pendingActionId).catch(() => false))
    ) {
      blockedReasons.push("ACTION_REVOCATION_UNCONFIRMED");
    }

    if (run.publish !== undefined && new Set(["PREPARED", "SUBMITTED", "UNKNOWN"])
      .has(run.publish.status)) {
      blockedReasons.push("PUBLISH_RECONCILIATION_REQUIRED");
    }

    if (blockedReasons.length > 0) {
      const committed = (await this.mutations.mutate(
        {
          requestId: `cancel:${jobId}:blocked:${blockedReasons.join("+")}`,
          payload: { blockedReasons },
          expectedJobId: jobId,
          expectedFence: run.fence,
          ...(attempt === undefined ? {} : {
            expectedGeneration: attempt.generation,
            expectedAttemptId: attempt.attemptId
          }),
          expectedPhases: ["CANCELING"]
        },
        (currentState) => ({
          nextState: nextStateWithRun(currentState, jobId, (current) => ({
            ...current,
            phase: "PAUSED",
            pause: {
              code: "PAUSED_PROCESS_RECONCILIATION",
              resumeActions: ["retry_cancel", "cancel"]
            },
            cancellation: {
              ...current.cancellation,
              status: "BLOCKED",
              blockedReasons
            },
            lastError: {
              code: "PAUSED_PROCESS_RECONCILIATION",
              stage: "cancel",
              message: blockedReasons.join(","),
              retryable: true,
              nextActions: ["retry_cancel", "cancel"],
              artifacts: []
            }
          })),
          response: { phase: "PAUSED", blockedReasons }
        })
      )).state;
      return this.result(committed, committed.runs[jobId] ?? run, false, blockedReasons);
    }

    const endedAt = new Date().toISOString();
    const committed = (await this.mutations.mutate(
      {
        requestId: `cancel:${jobId}:completed`,
        payload: { status: "COMPLETED" },
        expectedJobId: jobId,
        expectedFence: run.fence,
        ...(attempt === undefined ? {} : {
          expectedGeneration: attempt.generation,
          expectedAttemptId: attempt.attemptId
        }),
        expectedPhases: ["CANCELING"]
      },
      (currentState) => ({
        nextState: nextStateWithRun(
          currentState,
          jobId,
          (current) => ({
            ...current,
            phase: "CANCELED",
            cancellation: { ...current.cancellation, status: "COMPLETED", completedAt: endedAt },
            workerAttempts: cancelActiveAttempt(current, endedAt),
            pendingAction: undefined,
            pause: undefined,
            lastError: undefined
          }),
          true
        ),
        response: { phase: "CANCELED", status: "COMPLETED" }
      })
    )).state;
    const canceledRun = committed.runs[jobId] ?? run;
    await cleanupGitRunTemporaryState(this.store.dataDirectory, canceledRun);
    return this.result(committed, canceledRun, true, []);
  }

  private result(
    state: ProjectState,
    run: RunRecord,
    reconciled: boolean,
    blockedReasons: string[]
  ): CancellationResult {
    return {
      jobId: run.jobId,
      phase: run.phase,
      stateVersion: state.stateVersion,
      reconciled,
      blockedReasons
    };
  }
}
