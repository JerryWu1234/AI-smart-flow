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
        "Start an approved run with smartflow_execute. Keep one stable hostTurnId for the whole composite Host flow, then repeatedly call smartflow_review_turn with a new requestId plus projectId, jobId, and that hostTurnId until it returns DONE. Do not track or invent revision, stateVersion, Review attempt identity, source or Candidate hashes, or Provider session identity; the Daemon owns all of it and never asks a caller to resupply it.",
        "smartflow_review_turn returns exactly one of NOT_READY, REVIEW_REQUIRED, USER_INPUT_REQUIRED, or DONE. On NOT_READY, sleep for retryAfterMs and poll again with a new requestId.",
        "Every actionable turn carries a turnToken. Echo that exact token back with the review, answer, or reviewUnavailableReason for that same turn. A token that no longer matches the Daemon's current turn is treated as stale, changes nothing, and returns NOT_READY.",
        "REVIEW_REQUIRED means this caller owns the independent Reviewer session. On reviewerSession.mode CREATE, create exactly one Reviewer session and reuse it for the rest of the run; on RESUME, resume exactly reviewerSession.reviewerSessionId. Use worktreePath as the Reviewer working directory and finish before deadlineAt. If the required Reviewer session is unavailable, submit reviewUnavailableReason with the unchanged turnToken instead of substituting a different session.",
        "The Reviewer reviews the Candidate in the supplied worktree against the approved Task source at tasksPath inside that worktree, and must reread it every round. taskIds lists the approved Task IDs to report; never infer Task IDs by parsing the source yourself. changedPaths lists what the run modified.",
        "Review only against the approved Task requirements and acceptance criteria, prioritizing functional correctness. Report only concrete unmet requirements, regressions, or material risks introduced by the change. Do not report optional refactors, style preferences, speculative improvements, unrelated pre-existing issues, or scope expansion. If every approved criterion is met, mark the Task 100% even when nonessential improvements remain.",
        "The Reviewer is a caller-enforced read-only role. It may read worktree files needed for context, but must not modify files or run tests, lint, builds, or other commands.",
        "Submit review as { reviewerSessionId, result: { tasks: [...] } }. result.tasks must contain every ID from taskIds exactly once as { id, completionPercentage, issues }. A 100% Task requires issues: []; a lower percentage requires at least one issue. Missing, extra, or duplicate Task IDs are rejected atomically and change nothing.",
        "Each issue may contain only path, message, and optional suggestedFix. path must be a safe project-relative file path without line, range, symbol, or location suffixes. message must identify the concrete function or behavior, triggering condition, and impact.",
        "The Daemon owns durable atomic transitions, deterministic accept/repair/pause decisions, repair counting, criterion-scoped automatic repair approval, the review deadline, and publish scheduling; a pause or publish conflict may still require user input.",
        "On USER_INPUT_REQUIRED, present pause.message to the user and submit exactly one options[].answer with the turnToken. review carries the current Reviewer findings when they are relevant to the decision. requiredInput may be absent; for COLLECT, collect every field in inputForm and submit the complete structured answer only after user approval, and for CONFIRM, ask the user to confirm requiredInput.answer unchanged before submitting it. result carries the paused run snapshot, including artifacts for the durable evidence behind the pause.",
        "Use smartflow_status, smartflow_resume, smartflow_cancel, and smartflow_result only for explicit inspection, permitted out-of-turn recovery or approval, cancellation, and result retrieval. During an active Host turn, submit the listed answers through smartflow_review_turn rather than bypassing ownership. Cancellation stays owner-bound: pass your hostTurnId to smartflow_cancel to cancel a run whose turn you still own, and keep that hostTurnId stable across restarts so you never lose the ability to abort your own run."
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
        "Single Host-loop entry point after smartflow_execute. Returns NOT_READY, REVIEW_REQUIRED, USER_INPUT_REQUIRED, or DONE. Reply to an actionable turn by echoing its turnToken. On REVIEW_REQUIRED, run or resume the specified independent Reviewer and return every approved task with its completionPercentage and nested issues; the Daemon handles every atomic transition and the durable review deadline.",
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
