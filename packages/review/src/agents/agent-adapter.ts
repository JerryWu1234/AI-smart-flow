export interface AgentRunRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchemaPath: string;
  readonly outputPath: string;
  readonly deadlineMs: number;
  readonly model?: string;
  /**
   * Reasoning depth, passed through verbatim. Each Agent decides how to express
   * it, and each Agent owns which values it accepts.
   */
  readonly effort?: string;
}

export type AgentRunOutcome =
  | { kind: "COMPLETED"; sessionId: string; finalResponse: unknown }
  | { kind: "FAILED"; sessionId?: string; code: string; message: string }
  | { kind: "TIMED_OUT"; sessionId?: string }
  | { kind: "CANCELED"; sessionId?: string };

export interface AgentAdapter {
  createSession(request: AgentRunRequest): Promise<AgentRunOutcome>;
  resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome>;
  cancel(runId: string): Promise<boolean>;
}
