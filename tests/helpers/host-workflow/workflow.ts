import {
  reviewTurnInputSchema,
  reviewTurnOutputSchema,
  type ResultOutput,
  type ReviewResult,
  type ReviewTurnInput,
  type ReviewTurnOutput
} from "@smartflow/protocol";

import {
  executeApprovedTasks,
  type ApprovedTasksSnapshot,
  type HostGateway
} from "./approval.js";
import {
  reviewerSessionIdFromOutput,
  validateHostReviewOutput,
  type HostReviewCallbackOutput,
  type HostReviewContext,
  type HostReviewOutput
} from "./reviewer.js";

export type ReviewActionResult = HostReviewCallbackOutput;
export type ReviewActionContext = HostReviewContext;

export interface RepairLimitContext {
  repairRounds: 15;
  result: ReviewResult;
}

export type UserInputContext = Extract<ReviewTurnOutput, { kind: "USER_INPUT_REQUIRED" }>;
export type UserInputAnswer = NonNullable<ReviewTurnInput["answer"]>;

export interface HostActionCallbacks {
  review?(context: ReviewActionContext): Promise<ReviewActionResult>;
  answerUserInput?(context: UserInputContext): Promise<UserInputAnswer | undefined>;
  continueAfterRepairLimit?(context: RepairLimitContext): Promise<boolean>;
}

export interface ExecuteApprovedWorkflowInput {
  projectRoot: string;
  approval: ApprovedTasksSnapshot;
  requestId: string;
  hostTurnId: string;
  expectedStateVersion?: number;
}

const REVIEW_RETRY_LIMIT = 3;

function wait(delayMs: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, delayMs));
}

export async function executeApprovedWorkflow(
  gateway: HostGateway,
  callbacks: HostActionCallbacks,
  input: ExecuteApprovedWorkflowInput
): Promise<ResultOutput> {
  const execute = await executeApprovedTasks(
    gateway,
    input.projectRoot,
    input.approval,
    input.requestId,
    input.expectedStateVersion
  );
  let sequence = 0;
  let continuation: Partial<Pick<
    ReviewTurnInput,
    "turnToken" | "review" | "answer" | "reviewUnavailableReason"
  >> = {};
  for (;;) {
    sequence += 1;
    const turn = reviewTurnOutputSchema.parse(await gateway.call("smartflow_review_turn", {
      requestId: `${input.requestId}:review-turn:${String(sequence)}`,
      projectId: execute.projectId,
      jobId: execute.jobId,
      hostTurnId: input.hostTurnId,
      ...continuation
    }));
    continuation = {};
    if (turn.kind === "DONE") return turn.result;
    if (turn.kind === "NOT_READY") {
      await wait(turn.retryAfterMs);
      continue;
    }
    if (turn.kind === "USER_INPUT_REQUIRED") {
      let answer = await callbacks.answerUserInput?.(turn);
      if (
        answer === undefined &&
        turn.pause.code === "AUTOMATIC_REPAIR_LIMIT" &&
        turn.review !== undefined
      ) {
        const continueRepairs = await callbacks.continueAfterRepairLimit?.({
          repairRounds: 15,
          result: turn.review
        }) ?? false;
        if (continueRepairs) answer = "resume_review_decision";
      }
      if (answer !== undefined) {
        const validated = reviewTurnInputSchema.parse({
          requestId: `${input.requestId}:review-turn-answer:${String(sequence)}`,
          projectId: execute.projectId,
          jobId: execute.jobId,
          hostTurnId: input.hostTurnId,
          turnToken: turn.turnToken,
          answer
        });
        continuation = {
          turnToken: turn.turnToken,
          answer: validated.answer
        };
        continue;
      }
      return turn.result;
    }

    const context: ReviewActionContext = {
      worktreePath: turn.worktreePath,
      changedPaths: [...turn.changedPaths],
      reviewerSession: { ...turn.reviewerSession }
    };
    if (callbacks.review === undefined) {
      continuation = {
        turnToken: turn.turnToken,
        reviewUnavailableReason: "HOST_REVIEW_UNAVAILABLE:review callback missing"
      };
      continue;
    }
    let retryContext = context;
    let output: HostReviewOutput | undefined;
    let failure = "HOST_REVIEW_INVALID_OUTPUT";
    for (let attempt = 1; attempt <= REVIEW_RETRY_LIMIT; attempt += 1) {
      try {
        const candidate = await callbacks.review(retryContext);
        const reviewerSessionId = reviewerSessionIdFromOutput(candidate);
        if (reviewerSessionId !== undefined && retryContext.reviewerSession.mode === "CREATE") {
          retryContext = {
            ...retryContext,
            reviewerSession: { mode: "RESUME", reviewerSessionId }
          };
        }
        output = validateHostReviewOutput(retryContext, candidate);
        break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    continuation = output === undefined
      ? {
          turnToken: turn.turnToken,
          reviewUnavailableReason: failure.startsWith("HOST_REVIEW_UNAVAILABLE")
            ? failure
            : `HOST_REVIEW_UNAVAILABLE:${failure}`
        }
      : {
          turnToken: turn.turnToken,
          review: {
            reviewerSessionId: output.reviewerSessionId,
            result: output.result
          }
        };
  }
}
