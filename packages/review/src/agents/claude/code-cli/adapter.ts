import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";

import type {
  AgentAdapter,
  AgentRunOutcome,
  AgentRunRequest
} from "../../agent-adapter.js";

export type ClaudeCodeSpawn = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type ClaudeCodeKill = (
  pid: number,
  signal: NodeJS.Signals | number
) => boolean;

export interface ClaudeCodeAdapterOptions {
  readonly executable?: string;
  readonly spawn?: ClaudeCodeSpawn;
  readonly kill?: ClaudeCodeKill;
  readonly forceKillAfterMs?: number;
}

type InterruptedKind = "TIMED_OUT" | "CANCELED";

interface ActiveRun {
  stop(kind: InterruptedKind): boolean;
}

interface ClaudeResult {
  readonly value: Record<string, unknown>;
  readonly subtype: string;
  readonly sessionId: string;
}

const defaultSpawn: ClaudeCodeSpawn = (executable, argv, options) =>
  spawnChild(executable, [...argv], options);

const defaultKill: ClaudeCodeKill = (pid, signal) => process.kill(pid, signal);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedOutcome(
  code: string,
  message: string,
  sessionId?: string
): AgentRunOutcome {
  return sessionId === undefined
    ? { kind: "FAILED", code, message }
    : { kind: "FAILED", sessionId, code, message };
}

function interruptedOutcome(
  kind: InterruptedKind,
  sessionId?: string
): AgentRunOutcome {
  return sessionId === undefined ? { kind } : { kind, sessionId };
}

function diagnostics(...values: Array<string | undefined>): string {
  const text = values
    .map((value) => value?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" | ");
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
}

function argv(
  request: AgentRunRequest,
  schema: string,
  sessionId?: string
): string[] {
  return [
    "-p",
    ...(sessionId === undefined ? [] : ["--resume", sessionId]),
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--safe-mode",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
    "--disallowedTools",
    "mcp__*",
    "--no-chrome",
    ...(request.model === undefined ? [] : ["--model", request.model]),
    ...(request.effort === undefined ? [] : ["--effort", request.effort]),
    request.prompt
  ];
}

function parseResult(stdout: string): ClaudeResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "result") return undefined;
  const subtype = nonEmptyString(value.subtype);
  const sessionId = nonEmptyString(value.session_id);
  return subtype === undefined || sessionId === undefined
    ? undefined
    : { value, subtype, sessionId };
}

function runFailureDetail(
  result: ClaudeResult,
  stderr: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): string {
  const terminalReason = nonEmptyString(result.value.terminal_reason);
  const errors = Array.isArray(result.value.errors)
    ? result.value.errors.filter((value): value is string => typeof value === "string").join("; ")
    : undefined;
  return diagnostics(
    `subtype=${result.subtype}`,
    terminalReason === undefined ? undefined : `terminal_reason=${terminalReason}`,
    errors === undefined || errors.length === 0 ? undefined : `errors=${errors}`,
    stderr,
    exitCode === null ? undefined : `exit code ${String(exitCode)}`,
    signal === null ? undefined : `signal ${signal}`
  );
}

export class ClaudeCodeAdapter implements AgentAdapter {
  private readonly executable: string;
  private readonly spawnProcess: ClaudeCodeSpawn;
  private readonly killProcess: ClaudeCodeKill;
  private readonly forceKillAfterMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reservedRunIds = new Set<string>();
  private readonly runCompletions = new Map<string, Promise<void>>();

  public constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.executable = options.executable ?? "claude";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.killProcess = options.kill ?? defaultKill;
    this.forceKillAfterMs = options.forceKillAfterMs ?? 1_000;
  }

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.run(request);
  }

  public resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome> {
    if (sessionId.trim().length === 0) {
      return Promise.resolve(failedOutcome(
        "CLAUDE_REQUEST_INVALID",
        "Claude resume requires a non-empty sessionId"
      ));
    }
    return this.run(request, sessionId);
  }

  public async cancel(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (active === undefined) return false;
    const completion = this.runCompletions.get(runId);
    const requested = active.stop("CANCELED");
    if (completion !== undefined) await completion;
    return requested;
  }

  private async run(
    request: AgentRunRequest,
    expectedSessionId?: string
  ): Promise<AgentRunOutcome> {
    if (
      request.runId.length === 0 ||
      !Number.isFinite(request.deadlineMs) ||
      request.deadlineMs < 0
    ) {
      return failedOutcome(
        "CLAUDE_REQUEST_INVALID",
        "Claude run requires a runId and a finite non-negative deadlineMs",
        expectedSessionId
      );
    }
    if (this.reservedRunIds.has(request.runId)) {
      return failedOutcome(
        "CLAUDE_RUN_ACTIVE",
        `A Claude process is already active for runId ${request.runId}`,
        expectedSessionId
      );
    }

    let requestedKind: InterruptedKind | undefined;
    let stopProcess: (() => void) | undefined;
    let released = false;
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveRun = {
      stop: (kind): boolean => {
        if (released || requestedKind !== undefined) return false;
        requestedKind = kind;
        stopProcess?.();
        return true;
      }
    };
    const release = (outcome: AgentRunOutcome): AgentRunOutcome => {
      if (released) return outcome;
      released = true;
      clearTimeout(deadlineTimer);
      if (this.activeRuns.get(request.runId) === active) {
        this.activeRuns.delete(request.runId);
      }
      this.reservedRunIds.delete(request.runId);
      this.runCompletions.delete(request.runId);
      resolveCompletion();
      return outcome;
    };
    const interruption = (): AgentRunOutcome | undefined =>
      requestedKind === undefined
        ? undefined
        : interruptedOutcome(requestedKind, expectedSessionId);

    this.reservedRunIds.add(request.runId);
    this.runCompletions.set(request.runId, completion);
    this.activeRuns.set(request.runId, active);
    const deadlineTimer = setTimeout(() => active.stop("TIMED_OUT"), request.deadlineMs);
    deadlineTimer.unref();

    let schema: string;
    try {
      const source = await readFile(request.outputSchemaPath, "utf8");
      schema = JSON.stringify(JSON.parse(source) as unknown);
    } catch (error) {
      const interrupted = interruption();
      if (interrupted !== undefined) return release(interrupted);
      const code = (error as NodeJS.ErrnoException).code;
      return release(failedOutcome(
        code === undefined ? "CLAUDE_REQUEST_INVALID" : "CLAUDE_IO_FAILED",
        code === undefined
          ? `Claude output schema was not valid JSON: ${errorMessage(error)}`
          : `Could not read Claude output schema: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }
    const schemaInterruption = interruption();
    if (schemaInterruption !== undefined) return release(schemaInterruption);

    try {
      await rm(request.outputPath, { force: true });
    } catch (error) {
      const interrupted = interruption();
      if (interrupted !== undefined) return release(interrupted);
      return release(failedOutcome(
        "CLAUDE_IO_FAILED",
        `Could not remove stale Claude output: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }
    const cleanupInterruption = interruption();
    if (cleanupInterruption !== undefined) return release(cleanupInterruption);

    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executable, argv(request, schema, expectedSessionId), {
        cwd: request.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return release(failedOutcome(
        "CLAUDE_PROCESS_FAILED",
        `Unable to start Claude: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }

    const stdout = child.stdout;
    if (stdout === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing else can be done without a process identity or stdout stream.
      }
      return release(failedOutcome(
        "CLAUDE_PROCESS_FAILED",
        "Claude stdout was not piped",
        expectedSessionId
      ));
    }

    stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    return await new Promise<AgentRunOutcome>((settle) => {
      let stdoutText = "";
      let stderr = "";
      let settled = false;
      let processClosed = false;
      let processError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (outcome: AgentRunOutcome): void => {
        if (settled) return;
        settled = true;
        settle(release(outcome));
      };

      const signalTree = (signal: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid !== undefined && pid > 0 && process.platform !== "win32") {
          try {
            this.killProcess(-pid, signal);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
          }
        }
        try {
          child.kill(signal);
        } catch {
          // The child can exit while cancellation is being requested.
        }
      };

      const terminate = (): void => {
        if (processClosed) return;
        signalTree("SIGTERM");
        if (this.forceKillAfterMs < 0 || forceKillTimer !== undefined) return;
        forceKillTimer = setTimeout(() => {
          if (!processClosed) signalTree("SIGKILL");
        }, this.forceKillAfterMs);
        forceKillTimer.unref();
      };
      stopProcess = terminate;

      stdout.on("data", (chunk: string) => {
        stdoutText += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", (error) => {
        processError = error;
      });

      child.once("close", (exitCode, signal) => {
        processClosed = true;
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        const interrupted = interruption();
        if (interrupted !== undefined) {
          finish(interrupted);
          return;
        }
        if (processError !== undefined) {
          finish(failedOutcome(
            "CLAUDE_PROCESS_FAILED",
            `Claude process error: ${processError.message}`,
            expectedSessionId
          ));
          return;
        }
        void this.finishRun(
          request.outputPath,
          stdoutText,
          stderr,
          exitCode,
          signal,
          expectedSessionId
        ).then((outcome) => finish(interruption() ?? outcome));
      });

      if (requestedKind !== undefined) terminate();
    });
  }

  private async finishRun(
    outputPath: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    expectedSessionId?: string
  ): Promise<AgentRunOutcome> {
    const result = parseResult(stdout);
    if (
      result !== undefined &&
      expectedSessionId !== undefined &&
      result.sessionId !== expectedSessionId
    ) {
      return failedOutcome(
        "CLAUDE_RESULT_INVALID",
        `Claude changed session_id from ${expectedSessionId} to ${result.sessionId}`,
        expectedSessionId
      );
    }
    if (result !== undefined && result.subtype !== "success") {
      return failedOutcome(
        "CLAUDE_RUN_FAILED",
        `Claude run failed: ${runFailureDetail(result, stderr, exitCode, signal)}`,
        result.sessionId
      );
    }
    if (exitCode !== 0) {
      const detail = diagnostics(
        stderr,
        stdout,
        exitCode === null ? undefined : `exit code ${String(exitCode)}`,
        signal === null ? undefined : `signal ${signal}`
      );
      return failedOutcome(
        "CLAUDE_PROCESS_FAILED",
        detail.length > 0
          ? `Claude process failed: ${detail}`
          : "Claude process did not exit successfully",
        result?.sessionId ?? expectedSessionId
      );
    }
    if (result === undefined) {
      const detail = diagnostics(stdout, stderr);
      return failedOutcome(
        "CLAUDE_RESULT_INVALID",
        `Claude did not return a valid result envelope${detail.length > 0 ? `: ${detail}` : ""}`,
        expectedSessionId
      );
    }
    if (!Object.hasOwn(result.value, "structured_output")) {
      return failedOutcome(
        "CLAUDE_RESULT_INVALID",
        "Claude returned success without structured_output",
        result.sessionId
      );
    }

    const output = result.value.structured_output;
    try {
      await writeFile(outputPath, JSON.stringify(output), "utf8");
    } catch (error) {
      return failedOutcome(
        "CLAUDE_IO_FAILED",
        `Could not write Claude output: ${errorMessage(error)}`,
        result.sessionId
      );
    }
    return {
      kind: "COMPLETED",
      sessionId: result.sessionId,
      finalResponse: output
    };
  }
}
