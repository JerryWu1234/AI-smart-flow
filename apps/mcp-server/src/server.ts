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
        "Start an approved run with smartflow_execute. Keep one stable hostTurnId for the whole composite Host flow, then repeatedly call smartflow_review_turn with a new requestId plus projectId, jobId, and that hostTurnId until it returns DONE. Do not track or invent revision, stateVersion, Review attempt identity, source or Candidate hashes, Provider session identity, or Reviewer session identity; the Daemon owns all of it.",
        "smartflow_review_turn returns exactly one of NOT_READY, USER_INPUT_REQUIRED, or DONE. On NOT_READY, sleep for retryAfterMs and poll again with a new requestId.",
        "Review is performed internally by the Daemon. Keep polling until DONE, and read the latest per-Task completion and issues from result.review when present.",
        "On USER_INPUT_REQUIRED, present pause.message to the user and submit exactly one options[].answer with the unchanged turnToken. A stale token changes nothing and returns NOT_READY. requiredInput may be absent; for COLLECT, collect every field in inputForm and submit the complete structured answer only after user approval, and for CONFIRM, ask the user to confirm requiredInput.answer unchanged before submitting it.",
        "The Daemon owns durable atomic transitions, deterministic accept/repair/pause decisions, repair counting, criterion-scoped automatic repair approval, Review deadlines, Reviewer retries, and publish scheduling; a pause or publish conflict may still require user input.",
        "Use smartflow_status, smartflow_resume, smartflow_cancel, and smartflow_result only for explicit inspection, permitted out-of-turn recovery or approval, cancellation, and result retrieval. During an active Host turn, submit listed answers through smartflow_review_turn rather than bypassing ownership. Cancellation stays owner-bound: pass your hostTurnId to smartflow_cancel to cancel a run whose turn you still own, and keep that hostTurnId stable across restarts."
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
        "Single Host-loop entry point after smartflow_execute. Returns NOT_READY, USER_INPUT_REQUIRED, or DONE. Poll after NOT_READY; on USER_INPUT_REQUIRED, echo its turnToken with one listed answer. Review runs inside the Daemon, and DONE.result.review contains the latest Review result.",
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
