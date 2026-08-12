import {
  reviewTurnInputSchema,
  reviewTurnOutputSchema,
  type ResultOutput,
  type ReviewTurnInput
} from "@smartflow/protocol";

import type { HostActionCallbacks, ReviewActionContext } from "./action-loop.js";
import {
  executeApprovedTasks,
  type ApprovedTasksSnapshot,
  type HostGateway
} from "./approval.js";
import {
  reviewerSessionIdFromOutput,
  validateHostReviewOutput,
  type HostReviewOutput
} from "./reviewer.js";

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
      if (answer === undefined && turn.pause.code === "AUTOMATIC_REPAIR_LIMIT") {
        const continueRepairs = await callbacks.continueAfterRepairLimit?.({
          projectId: turn.projectId,
          jobId: turn.jobId,
          revision: turn.revision,
          repairRounds: 15,
          result: turn.review ?? {
            verdict: "REQUEST_CHANGES",
            completionPercentage: 0,
            convergeFindings: [],
            adversarialFindings: [],
            pathCoverage: {},
            residualRisks: []
          }
        }) ?? false;
        if (continueRepairs) answer = "resume_review_decision";
      }
      if (answer !== undefined) {
        const validated = reviewTurnInputSchema.parse({
          requestId: `${input.requestId}:review-turn-answer:${String(sequence)}`,
          projectId: turn.projectId,
          jobId: turn.jobId,
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
      reviewAttemptId: turn.reviewAttemptId,
      worktreePath: turn.worktreePath,
      taskSourceHash: turn.taskSourceHash,
      candidateHash: turn.candidateHash,
      changedPaths: [...turn.changedPaths],
      reviewerSession: { ...turn.reviewerSession },
      piSessionId: turn.piSessionId
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
        if (
          reviewerSessionId !== undefined &&
          retryContext.reviewerSession.mode === "CREATE" &&
          reviewerSessionId !== retryContext.piSessionId
        ) {
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
