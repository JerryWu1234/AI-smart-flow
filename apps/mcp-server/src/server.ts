import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  cancelInputSchema,
  claimActionInputSchema,
  executeInputSchema,
  renewActionClaimInputSchema,
  resultInputSchema,
  resumeInputSchema,
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
        "The MCP caller is the Leader and owns the Host loop.",
        "After smartflow_execute, keep using smartflow_wait/status and handle every Review, repair Revision, and publish transition until the run completes or reaches a pause that requires the user.",
        "For a REVIEW action, claim it and use this caller's native session capability: CREATE one independent Reviewer session once, or RESUME exactly the supplied session.",
        "While that Reviewer is running, renew the claim until the result is ready.",
        "The Reviewer must open the claimed Run worktree, reread its synchronized Task on every round, may read any worktree files needed for context, and must not run tests, lint, or builds.",
        "The Reviewer returns task completion percentages plus a concise reason and implementation suggestion for each incomplete task; the overall percentage is the rounded arithmetic mean of all task percentages.",
        "Retry Reviewer creation or transient failures up to three times; after creation, retry invalid output with that same session up to three times.",
        "If any task is below 100%, submit all incomplete-task findings for repair and automatically approve a safe REPAIR_TASKS_READY Revision without user confirmation.",
        "Reuse the bound Reviewer for the next full review. If every task is 100%, automatically accept so publishing starts.",
        "The initial review does not count toward the repair limit. Pause after fifteen repair rounds and ask the user whether to grant another fifteen rounds.",
        "Never ask the Daemon to create a Reviewer and never replace a lost bound Reviewer session."
      ].join(" ")
    }
  );
  const handlers = createToolHandlers(gateway);

  // Submit approved tasks and start a new execution run.
  server.registerTool(
    "smartflow_execute",
    {
      description:
        "Start an approved run. The invoking MCP Host remains the Leader and must drive the automatic Review-repair loop through publish or a user-required pause.",
      inputSchema: executeInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_execute(input))
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
