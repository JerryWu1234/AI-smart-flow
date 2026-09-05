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

export interface RepairLimitContext {
  repairRounds: 15;
  result: ReviewResult;
}

export type UserInputContext = Extract<ReviewTurnOutput, { kind: "USER_INPUT_REQUIRED" }>;
export type UserInputAnswer = NonNullable<ReviewTurnInput["answer"]>;

export interface HostActionCallbacks {
  answerUserInput?(context: UserInputContext): Promise<UserInputAnswer | undefined>;
  continueAfterRepairLimit?(context: RepairLimitContext): Promise<boolean>;
}

export interface ExecuteApprovedWorkflowInput {
  projectRoot: string;
  approval?: ApprovedTasksSnapshot;
  requestId: string;
  hostTurnId: string;
}

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
    input.approval
  );
  let sequence = 0;
  let continuation: Partial<Pick<ReviewTurnInput, "turnToken" | "answer">> = {};
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

    let answer = await callbacks.answerUserInput?.(turn);
    if (
      answer === undefined &&
      turn.pause.code === "AUTOMATIC_REPAIR_LIMIT" &&
      turn.result.review !== undefined
    ) {
      const continueRepairs = await callbacks.continueAfterRepairLimit?.({
        repairRounds: 15,
        result: turn.result.review
      }) ?? false;
      if (continueRepairs) answer = "resume_review_decision";
    }
    if (answer === undefined) return turn.result;

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
  }
}
