import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  resultOutputSchema,
  resumeActionSchema,
  reviewTurnOutputSchema,
  statusOutputSchema,
  type ResumeInput,
  type ReviewTurnInput,
  type ReviewTurnOutput
} from "@smartflow/protocol";
import { REPAIR_ROUND_LIMIT } from "@smartflow/review";
import {
  StateStore,
  StateStoreError,
  type HostTurn,
  type ProjectState,
  type RunRecord
} from "@smartflow/state-store";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";
import {
  ReviewCoordinator,
  type FinalizeReviewOutput
} from "./review-coordinator.js";
import { verifyRunArtifacts } from "./recovery-manager.js";

const DEFAULT_RETRY_AFTER_MS = 30_000;
const TERMINAL_PHASES = new Set(["COMPLETED", "CANCELED", "FAILED"]);

interface ResumeOptions {
  clearHostTurn?: boolean;
  expectedHostTurnToken?: string;
}

export interface HostTurnCoordinatorDependencies {
  store(projectId: string): StateStore;
  status(input: { projectId: string; jobId: string }): Promise<unknown>;
  resume(input: ResumeInput, options?: ResumeOptions): Promise<unknown>;
  result(input: { projectId: string; jobId: string }): Promise<unknown>;
  schedule(input: {
    projectId: string;
    jobId: string;
    state: ProjectState;
    kind: "pipeline" | "publish";
  }): void;
}

function childRequestId(seed: string, scope: string): string {
  const digest = createHash("sha256").update(`${seed}:${scope}`).digest("hex").slice(0, 40);
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 48);
  return `review-turn-${safeScope}-${digest}`;
}

function pauseMessage(run: RunRecord): string {
  const code = run.pause?.code ?? "RUN_PAUSED";
  if (code === "REPAIR_USER_APPROVAL_REQUIRED") {
    return "The requested repair exceeds this immutable Job's task scope. Cancel it and create a new Job with updated tasks.";
  }
  if (code === "REPAIR_NO_PROGRESS") {
    return "Automatic repair is not making progress; inspect the repair state or cancel the run.";
  }
  if (code === "AUTOMATIC_REPAIR_LIMIT") {
    return `The automatic repair limit of ${String(REPAIR_ROUND_LIMIT)} rounds was reached. Continue to grant another ${String(REPAIR_ROUND_LIMIT)} rounds, or cancel.`;
  }
  if (code === "HOST_REVIEW_UNAVAILABLE") {
    return run.lastError?.message ?? "The bound Host Reviewer is unavailable.";
  }
  if (code.includes("PUBLISH") || code.includes("CONFLICT")) {
    return run.lastError?.message ?? "Publishing requires user attention before the run can continue.";
  }
  return run.lastError?.message ?? `The run paused with code ${code}.`;
}

function mutableResumeActions(run: RunRecord): ResumeInput["resumeAction"][] {
  const actions = (run.pause?.resumeActions ?? []).flatMap((action) => {
    const parsed = resumeActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
  return actions.length > 0 ? actions : ["cancel"];
}

function optionDescription(action: string): string {
  const descriptions: Record<string, string> = {
    cancel: "Cancel the run and preserve its current evidence",
    confirm_manual_publish: "Confirm that the Project already matches the reviewed Candidate",
    resume_review_decision: "Grant another fifteen automatic repair rounds",
    retry_host_review: "Retry review with the same bound Reviewer session",
    retry_publish: "Retry publishing the accepted Candidate",
    retry_provider_probe: "Retry the Provider availability check",
    retry_git_probe: "Retry the Git capability check",
    retry_provider: "Retry the Provider operation",
    retry_cancel: "Retry cancellation",
    retry: "Retry the failed workflow stage",
    restore_approved_tasks: "Continue after restoring the approved task source"
  };
  return descriptions[action] ?? `Continue with ${action}`;
}

function isStateVersionMismatch(error: unknown): error is StateStoreError {
  return error instanceof StateStoreError && error.code === "STATE_VERSION_MISMATCH";
}

function deterministicTurnToken(input: ReviewTurnInput, scope: string): string {
  return childRequestId(`${input.requestId}:${input.hostTurnId}`, scope).replace(
    /^review-turn-/u,
    "turn-"
  );
}

export class HostTurnCoordinator {
  public constructor(private readonly dependencies: HostTurnCoordinatorDependencies) {}

  public async turn(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    try {
      if (input.answer !== undefined) return await this.submitAnswer(input);
      return await this.advance(input);
    } catch (error) {
      if (!isStateVersionMismatch(error)) throw error;
      return this.staleContinuation();
    }
  }

  private async advance(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    for (;;) {
      const status = statusOutputSchema.parse(await this.dependencies.status(input));
      if (TERMINAL_PHASES.has(status.phase)) {
        return reviewTurnOutputSchema.parse({
          kind: "DONE",
          result: resultOutputSchema.parse(await this.dependencies.result(input))
        });
      }
      if (status.phase === "PAUSED") {
        return this.requireUserInput(input);
      }
      if (status.phase === "REVIEW_PENDING" || status.phase === "REVIEWING") {
        return this.notReady();
      }
      return this.notReady();
    }
  }

  private notReady(): ReviewTurnOutput {
    return reviewTurnOutputSchema.parse({
      kind: "NOT_READY",
      retryAfterMs: DEFAULT_RETRY_AFTER_MS
    });
  }

  // A stale continuation has no path to disclose and no side effect to replay, so
  // it needs no Run state read. The next real turn re-reads and re-verifies.
  private staleContinuation(): ReviewTurnOutput {
    return this.notReady();
  }

  private scheduleOutcome(
    projectId: string,
    jobId: string,
    state: ProjectState,
    outcome: FinalizeReviewOutput
  ): void {
    if (outcome.schedule === "none") return;
    this.dependencies.schedule({
      projectId,
      jobId,
      state,
      kind: outcome.schedule
    });
  }

  private async requireUserInput(
    input: ReviewTurnInput
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    let state = await store.readState();
    let run = state.runs[input.jobId];
    if (run === undefined || run.phase !== "PAUSED" || run.pause === undefined) {
      throw new Error("USER_INPUT_NOT_READY");
    }
    if (run.hostTurn?.stage === "AWAITING_USER_INPUT") {
      this.assertHostOwner(run.hostTurn, input.hostTurnId);
      return this.userInputRequired(state, run, run.hostTurn);
    }
    const previousTurn = run.hostTurn;
    if (previousTurn !== undefined) this.assertHostOwner(previousTurn, input.hostTurnId);
    const turnToken = previousTurn === undefined
      ? deterministicTurnToken(input, `user-input-${run.pause.code}`)
      : childRequestId(
          previousTurn.turnToken,
          `user-input-${run.pause.code}`
        ).replace(/^review-turn-/u, "turn-");
    const turn: HostTurn = {
      stage: "AWAITING_USER_INPUT",
      turnToken,
      hostTurnId: previousTurn?.hostTurnId ?? input.hostTurnId,
      pauseCode: run.pause.code,
      startedAt: new Date().toISOString()
    };
    state = await this.persistHostTurn(
      store,
      input.jobId,
      childRequestId(turnToken, "user-input"),
      state.stateVersion,
      turn,
      previousTurn?.turnToken
    );
    run = state.runs[input.jobId];
    if (run === undefined) throw new Error("RUN_NOT_FOUND");
    return this.userInputRequired(state, run, turn);
  }

  private async userInputRequired(
    state: ProjectState,
    run: RunRecord,
    turn: Extract<HostTurn, { stage: "AWAITING_USER_INPUT" }>
  ): Promise<ReviewTurnOutput> {
    const result = resultOutputSchema.parse(await this.dependencies.result({
      projectId: state.projectId,
      jobId: run.jobId
    }));
    const resumeActions = mutableResumeActions(run);
    const publishNeedsWorkspace = run.pause?.code.includes("PUBLISH") === true ||
      run.pause?.code === "PROJECT_PUBLISH_BUSY" ||
      (run.pause?.code === "RUNTIME_STAGE_FAILED" && run.lastError?.stage === "publish");
    const worktreePath = publishNeedsWorkspace && run.workspace !== undefined
      ? resolve(this.dependencies.store(state.projectId).dataDirectory, run.workspace.relativePath)
      : undefined;
    return reviewTurnOutputSchema.parse({
      kind: "USER_INPUT_REQUIRED",
      turnToken: turn.turnToken,
      pause: {
        code: turn.pauseCode,
        message: pauseMessage(run)
      },
      result,
      options: resumeActions.map((answer) => ({
        answer,
        description: optionDescription(answer)
      })),
      ...(worktreePath === undefined ? {} : { worktreePath })
    });
  }

  private async submitAnswer(input: ReviewTurnInput): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const state = await store.readState();
    const run = state.runs[input.jobId];
    const turn = run?.hostTurn;
    const answer = input.answer;
    if (
      run === undefined ||
      turn?.stage !== "AWAITING_USER_INPUT" ||
      turn.turnToken !== input.turnToken ||
      answer === undefined
    ) {
      return this.staleContinuation();
    }
    this.assertHostOwner(turn, input.hostTurnId);
    if (!mutableResumeActions(run).includes(answer)) {
      throw new Error("REVIEW_TURN_ANSWER_NOT_ALLOWED");
    }
    if (answer === "resume_review_decision") {
      return this.resumeReviewDecision(input, state, turn);
    }
    await this.dependencies.resume({
      requestId: childRequestId(turn.turnToken, `answer-${answer}`),
      projectId: input.projectId,
      jobId: input.jobId,
      expectedStateVersion: state.stateVersion,
      resumeAction: answer
    }, {
      clearHostTurn: true,
      expectedHostTurnToken: turn.turnToken
    });
    return this.advance({ ...input, answer: undefined });
  }

  private async resumeReviewDecision(
    input: ReviewTurnInput,
    state: ProjectState,
    turn: Extract<HostTurn, { stage: "AWAITING_USER_INPUT" }>
  ): Promise<ReviewTurnOutput> {
    const store = this.dependencies.store(input.projectId);
    const mutation = await new ProjectMutationExecutor(store).mutate<FinalizeReviewOutput>(
      {
        requestId: childRequestId(turn.turnToken, "resume-review-decision"),
        payload: {
          kind: "resume-review-decision",
          projectId: input.projectId,
          jobId: input.jobId,
          turnToken: turn.turnToken
        },
        expectedStateVersion: state.stateVersion,
        expectedJobId: input.jobId,
        expectedPhases: ["PAUSED"]
      },
      async (current, context) => {
        const active = current.runs[input.jobId];
        if (
          active?.hostTurn?.stage !== "AWAITING_USER_INPUT" ||
          active.hostTurn.turnToken !== turn.turnToken ||
          active.hostTurn.hostTurnId !== input.hostTurnId
        ) {
          throw new Error("HOST_TURN_STATE_CHANGED");
        }
        const artifactFailure = await verifyRunArtifacts(store, active);
        if (artifactFailure !== undefined) {
          throw new Error(`ARTIFACT_INTEGRITY_BLOCKED:${artifactFailure}`);
        }
        return new ReviewCoordinator(store).finalizeStoredReview(
          current,
          input.jobId,
          context.nextStateVersion,
          { repairRounds: 0, resetAutoRepairRounds: true }
        );
      }
    );
    this.scheduleOutcome(input.projectId, input.jobId, mutation.state, mutation.response);
    return this.advance({ ...input, answer: undefined });
  }

  private async persistHostTurn(
    store: StateStore,
    jobId: string,
    requestId: string,
    expectedStateVersion: number,
    hostTurn: HostTurn,
    expectedTurnToken?: string
  ): Promise<ProjectState> {
    const mutation = await new ProjectMutationExecutor(store).mutate(
      {
        requestId,
        payload: { kind: "host-turn", jobId, hostTurn },
        expectedStateVersion,
        expectedJobId: jobId,
        expectedPhases: ["PAUSED"]
      },
      (state) => {
        const run = state.runs[jobId];
        if (run === undefined) throw new Error("RUN_NOT_FOUND");
        if (
          expectedTurnToken !== undefined &&
          run.hostTurn !== undefined &&
          run.hostTurn.turnToken !== expectedTurnToken
        ) {
          throw new Error("HOST_TURN_STATE_CHANGED");
        }
        if (
          run.hostTurn !== undefined &&
          run.hostTurn.hostTurnId !== hostTurn.hostTurnId
        ) {
          throw new Error("HOST_TURN_STATE_CHANGED");
        }
        return {
          nextState: {
            ...state,
            runs: {
              ...state.runs,
              [jobId]: { ...run, hostTurn, updatedAt: new Date().toISOString() }
            }
          },
          response: { jobId, hostTurn }
        };
      }
    );
    return mutation.state;
  }

  private assertHostOwner(turn: HostTurn, hostTurnId: string): void {
    if (turn.hostTurnId !== hostTurnId) throw new Error("HOST_TURN_OWNED_BY_ANOTHER_HOST");
  }
}
