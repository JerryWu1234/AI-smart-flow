import type {
  AgentAdapter,
  AgentRunOutcome,
  AgentRunRequest
} from "../../agent-adapter.js";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions
} from "../code-cli/adapter.js";

export type ClaudeCodeDesktopAdapterOptions = ClaudeCodeAdapterOptions;

/**
 * A distinct Desktop-host Review strategy backed by the standalone Claude Code
 * CLI. Claude Desktop does not expose a headless reviewer transport, so this
 * adapter intentionally delegates without attaching to or controlling the GUI.
 */
export class ClaudeCodeDesktopAdapter implements AgentAdapter {
  private readonly cliAdapter: ClaudeCodeAdapter;

  public constructor(options: ClaudeCodeDesktopAdapterOptions = {}) {
    this.cliAdapter = new ClaudeCodeAdapter(options);
  }

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.cliAdapter.createSession(request);
  }

  public resume(
    sessionId: string,
    request: AgentRunRequest
  ): Promise<AgentRunOutcome> {
    return this.cliAdapter.resume(sessionId, request);
  }

  public cancel(runId: string): Promise<boolean> {
    return this.cliAdapter.cancel(runId);
  }
}
