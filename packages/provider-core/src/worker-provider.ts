export interface ProviderCapabilities {
  officialCodingTools: boolean;
  arbitraryShell: boolean;
  networkAccess: boolean;
  streaming: boolean;
  cancellation: boolean;
  sessionPersistence: boolean;
}

export type ProviderProbeResult =
  | {
      available: true;
      capabilities: ProviderCapabilities;
      providerRuntimeConfigHash: string;
      details: Readonly<Record<string, string>>;
    }
  | {
      available: false;
      code: "PROVIDER_UNAVAILABLE";
      reason: string;
      capabilities: ProviderCapabilities;
      details: Readonly<Record<string, string>>;
    };

export interface WorkerContainmentInput {
  readonly registryPath: string;
  readonly homeDirectory: string;
  readonly tempDirectory: string;
  readonly runtimeReadPaths: readonly string[];
  readonly deniedReadPaths: readonly string[];
}

export interface WorkerStartInput {
  readonly attemptId: string;
  readonly generation: number;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly providerRuntimeConfigHash: string;
  readonly deadlineAt: string;
  readonly resumeSession?: {
    readonly expectedPiSessionId: string;
    readonly sessionFile: string;
  };
  readonly containment: WorkerContainmentInput;
}

export type WorkerEvent =
  | {
      type: "STARTED";
      attemptId: string;
      piSessionId: string;
      containmentId: string;
      pid: number;
      processStartToken: string;
    }
  | { type: "TEXT_DELTA"; attemptId: string; text: string }
  | { type: "TOOL_STARTED"; attemptId: string; toolName: string; callId: string }
  | { type: "TOOL_FINISHED"; attemptId: string; toolName: string; callId: string; isError: boolean }
  | { type: "BLOCKED"; attemptId: string; code: string; message: string }
  | { type: "COMPLETED"; attemptId: string; piSessionId: string; sessionFile?: string }
  | { type: "FAILED"; attemptId: string; code: string; message: string }
  | { type: "TIMED_OUT"; attemptId: string; code: "ATTEMPT_DEADLINE_EXCEEDED" }
  | { type: "CANCELED"; attemptId: string };

export interface CancelReceipt {
  readonly attemptId: string;
  readonly requested: boolean;
  readonly treeEmpty: boolean;
}

export interface WorkerProvider {
  probe(): Promise<ProviderProbeResult>;
  start(input: WorkerStartInput): AsyncIterable<WorkerEvent>;
  cancel(attemptId: string): Promise<CancelReceipt>;
}
