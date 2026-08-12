import type { DaemonGateway, ValidatedHandler } from "../daemon-gateway.js";
import { createCancelHandler } from "./cancel.js";
import { createClaimActionHandler } from "./claim-action.js";
import { createExecuteHandler } from "./execute.js";
import { createResultHandler } from "./result.js";
import { createRenewActionClaimHandler } from "./renew-action-claim.js";
import { createResumeHandler } from "./resume.js";
import { createReviewTurnHandler } from "./review-turn.js";
import { createStatusHandler } from "./status.js";
import { createSubmitLeaderDecisionHandler } from "./submit-leader-decision.js";
import { createSubmitReviewHandler } from "./submit-review.js";
import { createWaitHandler } from "./wait.js";

export type SmartFlowToolName =
  | "smartflow_execute"
  | "smartflow_status"
  | "smartflow_wait"
  | "smartflow_review_turn"
  | "smartflow_claim_action"
  | "smartflow_renew_action_claim"
  | "smartflow_submit_review"
  | "smartflow_submit_leader_decision"
  | "smartflow_resume"
  | "smartflow_cancel"
  | "smartflow_result";

export function createToolHandlers(
  gateway: DaemonGateway
): Readonly<Record<SmartFlowToolName, ValidatedHandler>> {
  return {
    smartflow_execute: createExecuteHandler(gateway),
    smartflow_status: createStatusHandler(gateway),
    smartflow_wait: createWaitHandler(gateway),
    smartflow_review_turn: createReviewTurnHandler(gateway),
    smartflow_claim_action: createClaimActionHandler(gateway),
    smartflow_renew_action_claim: createRenewActionClaimHandler(gateway),
    smartflow_submit_review: createSubmitReviewHandler(gateway),
    smartflow_submit_leader_decision: createSubmitLeaderDecisionHandler(gateway),
    smartflow_resume: createResumeHandler(gateway),
    smartflow_cancel: createCancelHandler(gateway),
    smartflow_result: createResultHandler(gateway)
  };
}

export * from "./cancel.js";
export * from "./claim-action.js";
export * from "./execute.js";
export * from "./result.js";
export * from "./renew-action-claim.js";
export * from "./resume.js";
export * from "./review-turn.js";
export * from "./status.js";
export * from "./submit-leader-decision.js";
export * from "./submit-review.js";
export * from "./wait.js";
