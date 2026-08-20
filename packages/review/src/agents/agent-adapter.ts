export interface AgentProbe {
  available: boolean;
  agentId: string;
  version?: string;
  reason?: string;
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchemaPath: string;
  readonly outputPath: string;
  readonly deadlineMs: number;
  readonly model?: string;
}

export type AgentRunOutcome =
  | { kind: "COMPLETED"; sessionId: string; finalResponse: unknown }
  | { kind: "FAILED"; sessionId?: string; code: string; message: string }
  | { kind: "TIMED_OUT"; sessionId?: string }
  | { kind: "CANCELED"; sessionId?: string };

export interface AgentAdapter {
  readonly id: string;
  probe(): Promise<AgentProbe>;
  createSession(request: AgentRunRequest): Promise<AgentRunOutcome>;
  resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome>;
  cancel(runId: string): Promise<boolean>;
}
