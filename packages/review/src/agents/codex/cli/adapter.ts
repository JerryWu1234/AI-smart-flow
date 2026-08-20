import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";
import { readFile, rm } from "node:fs/promises";

import type {
  AgentAdapter,
  AgentProbe,
  AgentRunOutcome,
  AgentRunRequest
} from "../../agent-adapter.js";
import {
  createCodexEventState,
  reduceCodexEventLine,
  type CodexEventState
} from "./events.js";

export type CodexSpawn = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type CodexKill = (pid: number, signal: NodeJS.Signals | number) => boolean;

export interface CodexAdapterOptions {
  readonly executable?: string;
  readonly spawn?: CodexSpawn;
  readonly kill?: CodexKill;
  readonly forceKillAfterMs?: number;
  readonly probeTimeoutMs?: number;
}

type InterruptedKind = "TIMED_OUT" | "CANCELED";

interface ActiveRun {
  stop(kind: InterruptedKind): boolean;
}

const defaultSpawn: CodexSpawn = (executable, argv, options) =>
  spawnChild(executable, [...argv], options);

const defaultKill: CodexKill = (pid, signal) => process.kill(pid, signal);

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

function createArgv(request: AgentRunRequest): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--output-schema",
    request.outputSchemaPath,
    "--output-last-message",
    request.outputPath,
    "--cd",
    request.cwd,
    "--skip-git-repo-check",
    "--ignore-user-config",
    ...(request.model === undefined ? [] : ["-m", request.model]),
    request.prompt
  ];
}

function resumeArgv(sessionId: string, request: AgentRunRequest): string[] {
  return [
    "exec",
    "resume",
    sessionId,
    "--json",
    "--sandbox",
    "read-only",
    "--output-schema",
    request.outputSchemaPath,
    "--output-last-message",
    request.outputPath,
    "--cd",
    request.cwd,
    request.prompt
  ];
}

export class CodexAdapter implements AgentAdapter {
  public readonly id = "codex";

  private readonly executable: string;
  private readonly spawnProcess: CodexSpawn;
  private readonly killProcess: CodexKill;
  private readonly forceKillAfterMs: number;
  private readonly probeTimeoutMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reservedRunIds = new Set<string>();

  public constructor(options: CodexAdapterOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.killProcess = options.kill ?? defaultKill;
    this.forceKillAfterMs = options.forceKillAfterMs ?? 1_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  }

  public async probe(): Promise<AgentProbe> {
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executable, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return {
        available: false,
        agentId: this.id,
        reason: `Unable to start Codex: ${errorMessage(error)}`
      };
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    return await new Promise<AgentProbe>((settle) => {
      let settled = false;
      const finish = (probe: AgentProbe): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(probe);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited between the timeout and the signal.
        }
        finish({
          available: false,
          agentId: this.id,
          reason: `Codex version probe timed out after ${String(this.probeTimeoutMs)}ms`
        });
      }, this.probeTimeoutMs);
      timer.unref();

      child.once("error", (error) => {
        finish({
          available: false,
          agentId: this.id,
          reason: `Unable to start Codex: ${error.message}`
        });
      });
      child.once("close", (exitCode, signal) => {
        const version = stdout.trim();
        if (exitCode === 0 && version.length > 0) {
          finish({ available: true, agentId: this.id, version });
          return;
        }
        const detail = diagnostics(
          stderr,
          exitCode === null ? undefined : `exit code ${String(exitCode)}`,
          signal === null ? undefined : `signal ${signal}`
        );
        finish({
          available: false,
          agentId: this.id,
          reason: detail.length > 0 ? `Codex probe failed: ${detail}` : "Codex did not report a version"
        });
      });
    });
  }

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.run(request, createArgv(request));
  }

  public resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome> {
    if (sessionId.trim().length === 0) {
      return Promise.resolve(failedOutcome(
        "CODEX_SESSION_INVALID",
        "Codex resume requires a non-empty sessionId"
      ));
    }
    return this.run(request, resumeArgv(sessionId, request), sessionId);
  }

  public cancel(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    return Promise.resolve(active?.stop("CANCELED") ?? false);
  }

  private async run(
    request: AgentRunRequest,
    argv: readonly string[],
    expectedSessionId?: string
  ): Promise<AgentRunOutcome> {
    if (
      request.runId.length === 0 ||
      !Number.isFinite(request.deadlineMs) ||
      request.deadlineMs < 0
    ) {
      return failedOutcome(
        "CODEX_REQUEST_INVALID",
        "Codex run requires a runId and a finite non-negative deadlineMs",
        expectedSessionId
      );
    }
    if (this.reservedRunIds.has(request.runId)) {
      return failedOutcome(
        "CODEX_RUN_ACTIVE",
        `A Codex process is already active for runId ${request.runId}`,
        expectedSessionId
      );
    }
    this.reservedRunIds.add(request.runId);

    try {
      await rm(request.outputPath, { force: true });
    } catch (error) {
      this.reservedRunIds.delete(request.runId);
      return failedOutcome(
        "CODEX_OUTPUT_CLEANUP_FAILED",
        `Could not remove stale Codex output: ${errorMessage(error)}`,
        expectedSessionId
      );
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executable, argv, {
        cwd: request.cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      this.reservedRunIds.delete(request.runId);
      return failedOutcome(
        "CODEX_SPAWN_FAILED",
        `Unable to start Codex: ${errorMessage(error)}`,
        expectedSessionId
      );
    }

    const stdout = child.stdout;
    if (stdout === null) {
      this.reservedRunIds.delete(request.runId);
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing else can be done without a process identity or stdout stream.
      }
      return failedOutcome(
        "CODEX_STDOUT_UNAVAILABLE",
        "Codex stdout was not piped",
        expectedSessionId
      );
    }

    stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    return await new Promise<AgentRunOutcome>((settle) => {
      let eventState: CodexEventState = expectedSessionId === undefined
        ? createCodexEventState()
        : { ...createCodexEventState(), sessionId: expectedSessionId };
      let stdoutRemainder = "";
      let stderr = "";
      let settled = false;
      let processClosed = false;
      let requestedKind: InterruptedKind | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (outcome: AgentRunOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        this.activeRuns.delete(request.runId);
        this.reservedRunIds.delete(request.runId);
        settle(outcome);
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

      const stop = (kind: InterruptedKind): boolean => {
        if (settled) return false;
        requestedKind = kind;
        signalTree("SIGTERM");
        if (!processClosed && this.forceKillAfterMs >= 0) {
          forceKillTimer = setTimeout(() => {
            if (!processClosed) signalTree("SIGKILL");
          }, this.forceKillAfterMs);
          forceKillTimer.unref();
        }
        finish(interruptedOutcome(kind, eventState.sessionId));
        return true;
      };

      const active: ActiveRun = { stop };
      this.activeRuns.set(request.runId, active);

      const consumeStdout = (chunk: string): void => {
        stdoutRemainder += chunk;
        let newlineIndex = stdoutRemainder.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutRemainder.slice(0, newlineIndex);
          stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
          eventState = reduceCodexEventLine(eventState, line);
          newlineIndex = stdoutRemainder.indexOf("\n");
        }
      };

      stdout.on("data", consumeStdout);
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", (error) => {
        finish(failedOutcome(
          "CODEX_SPAWN_FAILED",
          `Codex process error: ${error.message}`,
          eventState.sessionId
        ));
      });

      child.once("close", (exitCode, signal) => {
        processClosed = true;
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (stdoutRemainder.length > 0) {
          eventState = reduceCodexEventLine(eventState, stdoutRemainder);
          stdoutRemainder = "";
        }
        if (settled || requestedKind !== undefined) return;
        void this.finishRun(
          request.outputPath,
          eventState,
          stderr,
          exitCode,
          signal
        ).then(finish);
      });

      const deadlineTimer = setTimeout(() => stop("TIMED_OUT"), request.deadlineMs);
      deadlineTimer.unref();
    });
  }

  private async finishRun(
    outputPath: string,
    events: CodexEventState,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<AgentRunOutcome> {
    if (events.failure !== undefined) {
      return failedOutcome(events.failure.code, events.failure.message, events.sessionId);
    }
    if (exitCode !== 0) {
      const detail = diagnostics(
        stderr,
        exitCode === null ? undefined : `exit code ${String(exitCode)}`,
        signal === null ? undefined : `signal ${signal}`
      );
      return failedOutcome(
        "CODEX_EXIT_FAILED",
        detail.length > 0 ? `Codex process failed: ${detail}` : "Codex process did not exit successfully",
        events.sessionId
      );
    }
    if (!events.turnCompleted) {
      return failedOutcome(
        "CODEX_TURN_INCOMPLETE",
        "Codex exited without a turn.completed event",
        events.sessionId
      );
    }
    if (events.sessionId === undefined) {
      return failedOutcome(
        "CODEX_SESSION_MISSING",
        "Codex completed without a thread.started sessionId"
      );
    }

    let output: string;
    try {
      output = await readFile(outputPath, "utf8");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const detail = diagnostics(events.agentMessage, stderr);
      return failedOutcome(
        missing ? "CODEX_OUTPUT_MISSING" : "CODEX_OUTPUT_READ_FAILED",
        `${missing ? "Codex did not create its output file" : `Could not read Codex output: ${errorMessage(error)}`}${detail.length > 0 ? `; diagnostic: ${detail}` : ""}`,
        events.sessionId
      );
    }

    try {
      return {
        kind: "COMPLETED",
        sessionId: events.sessionId,
        finalResponse: JSON.parse(output) as unknown
      };
    } catch (error) {
      return failedOutcome(
        "CODEX_OUTPUT_INVALID",
        `Codex output was not valid JSON: ${errorMessage(error)}`,
        events.sessionId
      );
    }
  }
}
