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

export const SMARTFLOW_MCP_INSTRUCTIONS = [
  "Before calling smartflow_execute, apply an implementation-intent gate. Enter task preparation only when the user explicitly asks to implement, change code, or execute work. For casual chat, explanations, evaluations, discussions, or planning-only requests, answer normally and do not create a task file or call smartflow_execute.",
  "If a requested implementation lacks a critical goal, scope, target, or acceptance criterion, tell the user what is missing and wait for their answer instead of inventing product requirements.",
  "For every new implementation request, including a later request in the same Host conversation, create a fresh filesystem-safe requestId. Normalize chat context, one source file, or multiple source files into exactly one canonical SmartFlow file at .smartflow/tasks/<requestId>/tasks.md. Never reuse a previous execute requestId, directory, or canonical task file, and pass that same requestId to smartflow_execute.",
  "Generate canonical SmartFlow syntax: use ## M01 module headings; - [ ] T001 tasks with unique IDs; only [P] and [M01]-style labels; at least one backtick-wrapped target path per task; the exact separator ' — 验收：' before acceptance criteria; and at least one incomplete task.",
  "After writing the canonical file, re-read it from disk, show the user its project-relative path and complete contents, and explicitly ask whether to execute those tasks. The user's initial implementation request is permission to prepare the draft, not permission to execute it. Do not call smartflow_execute until the user explicitly confirms the displayed file.",
  "After explicit confirmation, compute approvedSourceHash from the exact confirmed disk bytes and call smartflow_execute with projectRoot, .smartflow/tasks/<requestId>/tasks.md, that hash, and the same requestId. Compute this user-approved source hash, but do not invent Daemon-owned task, Candidate, run, session, or Review hashes, and do not create or pass a business Revision.",
  "After smartflow_execute, keep one stable hostTurnId for the whole composite Host flow, then repeatedly call smartflow_review_turn with a new requestId plus projectId, jobId, and that hostTurnId until it returns DONE. Do not track or invent internal run epochs, stateVersion, Review attempt identity, Provider session identity, or Reviewer session identity; the Daemon owns all of it.",
  "smartflow_review_turn returns exactly one of NOT_READY, USER_INPUT_REQUIRED, or DONE. On NOT_READY, sleep for retryAfterMs and poll again with a new requestId.",
  "Review is performed internally by the Daemon. Keep polling until DONE, and read the latest per-Task completion and issues from result.review when present.",
  "On USER_INPUT_REQUIRED, present pause.message to the user and submit exactly one options[].answer with the unchanged turnToken. A stale token changes nothing and returns NOT_READY. Out-of-scope repair offers cancellation only; after canceling, prepare, display, and obtain confirmation for a new canonical task file before calling smartflow_execute with a new requestId.",
  "The Daemon owns durable atomic transitions, deterministic accept/repair/pause decisions, repair counting, in-scope same-Job repair continuation, Review deadlines, Reviewer retries, and publish scheduling; a pause or publish conflict may still require user input.",
  "Use smartflow_status, smartflow_resume, smartflow_cancel, and smartflow_result only for explicit inspection, permitted out-of-turn recovery or approval, cancellation, and result retrieval. During an active Host turn, submit listed answers through smartflow_review_turn rather than bypassing ownership. Cancellation stays owner-bound: pass your hostTurnId to smartflow_cancel to cancel a run whose turn you still own, and keep that hostTurnId stable across restarts."
].join(" ");

export const SMARTFLOW_EXECUTE_DESCRIPTION =
  "Execute one canonical SmartFlow task file that the Host wrote at .smartflow/tasks/<requestId>/tasks.md, re-read from disk, showed in full, and received explicit user confirmation for. This tool does not plan or generate tasks. Use a fresh requestId for every new implementation request, pass that same ID in the path and input, and compute approvedSourceHash from the exact confirmed disk bytes. Continue only with smartflow_review_turn until it returns DONE or requires user input.";

function toolResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createSmartFlowMcpServer(gateway: DaemonGateway): McpServer {
  const server = new McpServer(
    { name: "smartflow", version: "0.1.0" },
    { instructions: SMARTFLOW_MCP_INSTRUCTIONS }
  );
  const handlers = createToolHandlers(gateway);

  server.registerTool(
    "smartflow_execute",
    {
      description: SMARTFLOW_EXECUTE_DESCRIPTION,
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
