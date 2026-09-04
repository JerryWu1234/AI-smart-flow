import type { DaemonGateway, ValidatedHandler } from "../daemon-gateway.js";
import { createCancelHandler } from "./cancel.js";
import { createExecuteHandler, type SmartFlowMcpSession } from "./execute.js";
import { createResultHandler } from "./result.js";
import { createResumeHandler } from "./resume.js";
import { createReviewTurnHandler } from "./review-turn.js";
import { createStatusHandler } from "./status.js";

export type { SmartFlowMcpSession } from "./execute.js";

export type SmartFlowToolName =
  | "smartflow_execute"
  | "smartflow_review_turn"
  | "smartflow_status"
  | "smartflow_resume"
  | "smartflow_cancel"
  | "smartflow_result";

export function createToolHandlers(
  gateway: DaemonGateway,
  session: SmartFlowMcpSession
): Readonly<Record<SmartFlowToolName, ValidatedHandler>> {
  return {
    smartflow_execute: createExecuteHandler(gateway, session),
    smartflow_review_turn: createReviewTurnHandler(gateway),
    smartflow_status: createStatusHandler(gateway),
    smartflow_resume: createResumeHandler(gateway),
    smartflow_cancel: createCancelHandler(gateway),
    smartflow_result: createResultHandler(gateway)
  };
}
