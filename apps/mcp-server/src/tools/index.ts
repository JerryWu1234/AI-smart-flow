import type { DaemonGateway, ValidatedHandler } from "../daemon-gateway.js";
import { createCancelHandler } from "./cancel.js";
import { createExecuteHandler } from "./execute.js";
import { createResultHandler } from "./result.js";
import { createResumeHandler } from "./resume.js";
import { createReviewTurnHandler } from "./review-turn.js";
import { createStatusHandler } from "./status.js";

export type SmartFlowToolName =
  | "smartflow_execute"
  | "smartflow_review_turn"
  | "smartflow_status"
  | "smartflow_resume"
  | "smartflow_cancel"
  | "smartflow_result";

export function createToolHandlers(
  gateway: DaemonGateway
): Readonly<Record<SmartFlowToolName, ValidatedHandler>> {
  return {
    smartflow_execute: createExecuteHandler(gateway),
    smartflow_review_turn: createReviewTurnHandler(gateway),
    smartflow_status: createStatusHandler(gateway),
    smartflow_resume: createResumeHandler(gateway),
    smartflow_cancel: createCancelHandler(gateway),
    smartflow_result: createResultHandler(gateway)
  };
}

export * from "./cancel.js";
export * from "./execute.js";
export * from "./result.js";
export * from "./resume.js";
export * from "./review-turn.js";
export * from "./status.js";
