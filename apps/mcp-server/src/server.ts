import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  cancelInputSchema,
  claimActionInputSchema,
  executeInputSchema,
  renewActionClaimInputSchema,
  resultInputSchema,
  resumeInputSchema,
  reviewTurnInputSchema,
  statusInputSchema,
  submitLeaderDecisionInputSchema,
  submitReviewInputSchema,
  waitInputSchema
} from "@smartflow/protocol";

import type { DaemonGateway } from "./daemon-gateway.js";
import { createToolHandlers } from "./tools/index.js";

function toolResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createSmartFlowMcpServer(gateway: DaemonGateway): McpServer {
  const server = new McpServer(
    { name: "smartflow", version: "0.1.0" },
    {
      instructions: [
        "Start an approved run with smartflow_execute, then repeatedly call smartflow_review_turn until it returns DONE or USER_INPUT_REQUIRED.",
        "When smartflow_review_turn returns NOT_READY, wait for retryAfterMs and call it again without calculating workflow state fields.",
        "When it returns REVIEW_REQUIRED, use this caller's native session capability: CREATE one independent Reviewer session once, or RESUME exactly the supplied session, with the supplied worktreePath as its working directory.",
        "The Reviewer must reread the synchronized Task on every round, may read worktree files needed for context, and must not run tests, lint, builds, or modify files.",
        "The Reviewer returns every Task exactly once with an integer completion percentage; incomplete tasks also include a concise reason and implementation suggestion; completionPercentage is their rounded arithmetic mean.",
        "Submit that result to smartflow_review_turn with the unchanged turnToken. The Daemon owns claim renewal, review decisions, safe repair approval, repair counting, and publish transitions.",
        "When it returns USER_INPUT_REQUIRED, present its message and options to the user. If requiredInput.mode is COLLECT, collect every listed field and construct the complete structured answer only from the user's approved values. If its mode is CONFIRM, ask the user to confirm the supplied complete answer before returning it through the same tool.",
        "Never ask the Daemon to create a Reviewer, never use the Worker session as Reviewer, and never replace a lost bound Reviewer session.",
        "The lower-level status, wait, claim, renew, submit-review, leader-decision, resume, cancel, and result tools remain available only for backward-compatible manual orchestration."
      ].join(" ")
    }
  );
  const handlers = createToolHandlers(gateway);

  // Submit approved tasks and start a new execution run.
  server.registerTool(
    "smartflow_execute",
    {
      description:
        "Start an approved run. Continue only with smartflow_review_turn until it returns DONE or requires user input.",
      inputSchema: executeInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_execute(input))
  );

  // Drive all deterministic workflow transitions while leaving only Review execution to the Host.
  server.registerTool(
    "smartflow_review_turn",
    {
      description:
        "Single Host-loop entry point after smartflow_execute. Returns NOT_READY, REVIEW_REQUIRED, USER_INPUT_REQUIRED, or DONE. On REVIEW_REQUIRED, run or resume the specified independent Reviewer and return its task scores with the unchanged turnToken; the Daemon handles every mechanical transition and claim renewal.",
      inputSchema: reviewTurnInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_review_turn(input))
  );

  // Get the run's phase, progress, and pending human actions.
  server.registerTool(
    "smartflow_status",
    {
      description:
        "Read current run state. A REVIEW action must be handled by this invoking Host using its own native Reviewer session capability.",
      inputSchema: statusInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_status(input))
  );

  // Wait for a state change without polling repeatedly.
  server.registerTool(
    "smartflow_wait",
    {
      description:
        "Wait for the next run state change. Keep waiting while work runs; handle pending REVIEW actions and return Review results to the same Leader.",
      inputSchema: waitInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_wait(input))
  );

  // Claim a pending human action to prevent duplicate decisions.
  server.registerTool(
    "smartflow_claim_action",
    {
      description:
        "Claim the current action and receive its Run worktree path. For REVIEW, CREATE means durably map reviewAttemptId to one independent native Reviewer session before reviewing; a retry of that attempt must reuse the mapping. RESUME means restore exactly the supplied session. In both modes open that worktree, reread the synchronized Task and current files, score every task from 0 to 100, then round their arithmetic mean for completionPercentage.",
      inputSchema: claimActionInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_claim_action(input))
  );

  // Keep an active Review claim alive while the Host waits for its Reviewer.
  server.registerTool(
    "smartflow_renew_action_claim",
    {
      description:
        "Renew the current Review claim. Only the Host turn that owns the unexpired claim may renew it.",
      inputSchema: renewActionClaimInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_renew_action_claim(input))
  );

  // Submit the host review outcome for the run.
  server.registerTool(
    "smartflow_submit_review",
    {
      description:
        "Submit the task completion result produced by the invoking Host's Reviewer session. Include every Task exactly once; completionPercentage is their rounded arithmetic mean. SmartFlow derives findings and path coverage internally. The complete normalized result is returned to the same Leader; this does not finish the run.",
      inputSchema: submitReviewInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_submit_review(input))
  );

  // Submit the leader's decision on the review outcome.
  server.registerTool(
    "smartflow_submit_leader_decision",
    {
      description:
        "Submit the original Leader's decision after reviewing the complete Reviewer result. Automatically repair when any task is incomplete and automatically accept only when every task is 100%. Repair includes all incomplete-task finding fingerprints.",
      inputSchema: submitLeaderDecisionInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_submit_leader_decision(input))
  );

  // Resume, retry, revise tasks, or take another permitted follow-up action.
  server.registerTool("smartflow_resume", { inputSchema: resumeInputSchema }, async (input) =>
    toolResult(await handlers.smartflow_resume(input))
  );

  // Request cancellation through the recoverable cancellation flow.
  server.registerTool("smartflow_cancel", { inputSchema: cancelInputSchema }, async (input) =>
    toolResult(await handlers.smartflow_cancel(input))
  );

  // Get the final result, generated artifacts, and next-step guidance.
  server.registerTool("smartflow_result", { inputSchema: resultInputSchema }, async (input) =>
    toolResult(await handlers.smartflow_result(input))
  );
  return server;
}

export async function connectSmartFlowStdioServer(gateway: DaemonGateway): Promise<McpServer> {
  const server = createSmartFlowMcpServer(gateway);
  await server.connect(new StdioServerTransport());
  return server;
}
