import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  cancelInputSchema,
  executeInputSchema,
  resultInputSchema,
  resumeInputSchema,
  reviewTurnInputSchema,
  statusInputSchema
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
        "Start an approved run with smartflow_execute. Keep one stable hostTurnId for the entire composite Host flow, and repeatedly call smartflow_review_turn until it returns DONE. When it returns USER_INPUT_REQUIRED, handle the required user interaction through the same turn flow and then continue.",
        "When smartflow_review_turn returns NOT_READY, wait for retryAfterMs and call it again. Do not invent revision, stateVersion, or other workflow state fields that are not part of the review-turn input.",
        "When it returns REVIEW_REQUIRED, follow reviewerSession.mode. CREATE means this caller must create exactly one independent Reviewer session for that reviewAttemptId and reuse that mapping on retries. RESUME means this caller must resume exactly reviewerSession.reviewerSessionId. Use worktreePath as the Reviewer working directory.",
        "Reviewer session IDs are opaque bindings. This caller is responsible for actually creating or resuming the corresponding native session. Never submit piSessionId as reviewerSessionId. If the required Reviewer session is unavailable, submit reviewUnavailableReason with the unchanged turnToken instead of creating a replacement.",
        "On every round, the Reviewer must reread the synchronized Task at the run's project-relative tasksPath in the supplied worktree and ensure it corresponds to taskSourceHash. If the exact Task source is unavailable or mismatched, submit reviewUnavailableReason instead of a review.",
        "The Reviewer is a caller-enforced read-only role. It may read worktree files needed for context, but must not modify files or run tests, lint, builds, or other commands.",
        "Submit review as { reviewerSessionId, result: { tasks: [...] } }. result.tasks must contain every approved Task exactly once as { id, completionPercentage, issues }. A 100% Task requires issues: []; a lower percentage requires at least one issue.",
        "Each issue may contain only path, message, and optional suggestedFix. path must be a safe project-relative file path without line, range, symbol, or location suffixes. message must identify the concrete function or behavior, triggering condition, and impact.",
        "Submit review, answer, or reviewUnavailableReason through smartflow_review_turn with the exact turnToken returned for that turn and the same hostTurnId. The Daemon owns durable atomic transitions, deterministic accept/repair/pause decisions, repair counting, criterion-scoped automatic repair approval, and publish scheduling; a pause or publish conflict may still require user input.",
        "For USER_INPUT_REQUIRED, present pause.message and options to the user and make inspectionOptions available. requiredInput may be absent. For COLLECT, collect every required field and submit the complete structured answer only after user approval. For CONFIRM, ask the user to confirm requiredInput.answer unchanged before submitting it. Submit only an options[].answer or the complete revision-approval object as answer; inspectionOptions are not answers.",
        "Use smartflow_status, smartflow_resume, smartflow_cancel, and smartflow_result only for explicit inspection, permitted out-of-turn recovery or approval, cancellation, and result retrieval. During an active composite Host turn, submit listed answers through smartflow_review_turn rather than bypassing it with resume or cancel."
      ].join(" ")
    }
  );
  const handlers = createToolHandlers(gateway);

  server.registerTool(
    "smartflow_execute",
    {
      description:
        "Start an approved run. Continue only with smartflow_review_turn until it returns DONE or requires user input.",
      inputSchema: executeInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_execute(input))
  );

  server.registerTool(
    "smartflow_review_turn",
    {
      description:
        "Single Host-loop entry point after smartflow_execute. Returns NOT_READY, REVIEW_REQUIRED, USER_INPUT_REQUIRED, or DONE. On REVIEW_REQUIRED, run or resume the specified independent Reviewer and return every task with its completionPercentage and nested issues using the unchanged turnToken; the Daemon handles every atomic transition and the durable review deadline.",
      inputSchema: reviewTurnInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_review_turn(input))
  );

  server.registerTool(
    "smartflow_status",
    {
      description: "Read the current state of a run without advancing it.",
      inputSchema: statusInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_status(input))
  );

  server.registerTool(
    "smartflow_resume",
    {
      description:
        "Resume, retry, inspect, or approve a permitted follow-up action for a paused run.",
      inputSchema: resumeInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_resume(input))
  );

  server.registerTool(
    "smartflow_cancel",
    {
      description: "Request cancellation through the recoverable cancellation flow.",
      inputSchema: cancelInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_cancel(input))
  );

  server.registerTool(
    "smartflow_result",
    {
      description: "Read a run result and its generated artifacts.",
      inputSchema: resultInputSchema
    },
    async (input) => toolResult(await handlers.smartflow_result(input))
  );
  return server;
}

export async function connectSmartFlowStdioServer(gateway: DaemonGateway): Promise<McpServer> {
  const server = createSmartFlowMcpServer(gateway);
  await server.connect(new StdioServerTransport());
  return server;
}
