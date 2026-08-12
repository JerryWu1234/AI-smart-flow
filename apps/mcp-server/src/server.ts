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
        "Start an approved run with smartflow_execute, then repeatedly call smartflow_review_turn until it returns DONE or USER_INPUT_REQUIRED.",
        "When smartflow_review_turn returns NOT_READY, wait for retryAfterMs and call it again without calculating workflow state fields.",
        "When it returns REVIEW_REQUIRED, use this caller's native session capability: CREATE one independent Reviewer session once, or RESUME exactly the supplied session, with the supplied worktreePath as its working directory.",
        "The Reviewer must reread the synchronized Task on every round, may read worktree files needed for context, and must not run tests, lint, builds, or modify files.",
        "The Reviewer returns every Task exactly once with an integer completion percentage; incomplete tasks also include a concise reason and implementation suggestion; completionPercentage is their rounded arithmetic mean.",
        "Submit that result to smartflow_review_turn with the unchanged turnToken. The Daemon owns claim renewal, review decisions, safe repair approval, repair counting, and publish transitions.",
        "When it returns USER_INPUT_REQUIRED, present its message and options to the user. If requiredInput.mode is COLLECT, collect every listed field and construct the complete structured answer only from the user's approved values. If its mode is CONFIRM, ask the user to confirm the supplied complete answer before returning it through the same tool.",
        "Never ask the Daemon to create a Reviewer, never use the Worker session as Reviewer, and never replace a lost bound Reviewer session.",
        "Use smartflow_status, smartflow_resume, smartflow_cancel, and smartflow_result only for explicit run inspection, recovery, cancellation, and result retrieval; do not manually reproduce the composite Review flow."
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
        "Single Host-loop entry point after smartflow_execute. Returns NOT_READY, REVIEW_REQUIRED, USER_INPUT_REQUIRED, or DONE. On REVIEW_REQUIRED, run or resume the specified independent Reviewer and return its task scores with the unchanged turnToken; the Daemon handles every mechanical transition and claim renewal.",
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
