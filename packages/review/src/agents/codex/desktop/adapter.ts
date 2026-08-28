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

export type CodexDesktopSpawn = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type CodexDesktopKill = (
  pid: number,
  signal: NodeJS.Signals | number
) => boolean;

export interface CodexDesktopAdapterOptions {
  readonly executable?: string;
  readonly spawn?: CodexDesktopSpawn;
  readonly kill?: CodexDesktopKill;
  readonly forceKillAfterMs?: number;
}

type InterruptedKind = "TIMED_OUT" | "CANCELED";
type ShutdownMode = "graceful" | "immediate";

interface ActiveRun {
  stop(kind: InterruptedKind): boolean;
}

interface PendingRequest {
  readonly method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface CompletedAgentMessage {
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
}

class CodexDesktopFailure extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const defaultSpawn: CodexDesktopSpawn = (executable, argv, options) =>
  spawnChild(executable, [...argv], options);

const defaultKill: CodexDesktopKill = (pid, signal) => process.kill(pid, signal);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
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

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > 4_000 ? next.slice(-4_000) : next;
}

function nestedMessage(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!isRecord(value)) return undefined;
  return nonEmptyString(value.message) ?? nestedMessage(value.error);
}

function responseId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function nestedId(result: unknown, key: "thread" | "turn"): string | undefined {
  if (!isRecord(result) || !isRecord(result[key])) return undefined;
  return nonEmptyString(result[key].id);
}

export class CodexDesktopAdapter implements AgentAdapter {
  private readonly executable: string;
  private readonly spawnProcess: CodexDesktopSpawn;
  private readonly killProcess: CodexDesktopKill;
  private readonly forceKillAfterMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly reservedRunIds = new Set<string>();

  public constructor(options: CodexDesktopAdapterOptions = {}) {
    this.executable = options.executable ?? "codex";
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.killProcess = options.kill ?? defaultKill;
    this.forceKillAfterMs = options.forceKillAfterMs ?? 1_000;
  }

  public createSession(request: AgentRunRequest): Promise<AgentRunOutcome> {
    return this.run(request);
  }

  public resume(
    sessionId: string,
    request: AgentRunRequest
  ): Promise<AgentRunOutcome> {
    if (sessionId.trim().length === 0) {
      return Promise.resolve(failedOutcome(
        "CODEX_SESSION_INVALID",
        "Codex Desktop resume requires a non-empty sessionId"
      ));
    }
    return this.run(request, sessionId);
  }

  public cancel(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    return Promise.resolve(active?.stop("CANCELED") ?? false);
  }

  private async run(
    request: AgentRunRequest,
    expectedSessionId?: string
  ): Promise<AgentRunOutcome> {
    if (
      request.runId.trim().length === 0 ||
      request.cwd.trim().length === 0 ||
      request.prompt.trim().length === 0 ||
      request.outputSchemaPath.trim().length === 0 ||
      request.outputPath.trim().length === 0 ||
      !Number.isFinite(request.deadlineMs) ||
      request.deadlineMs < 0
    ) {
      return failedOutcome(
        "CODEX_REQUEST_INVALID",
        "Codex Desktop run requires non-empty request fields and a finite non-negative deadlineMs",
        expectedSessionId
      );
    }
    if (this.reservedRunIds.has(request.runId)) {
      return failedOutcome(
        "CODEX_RUN_ACTIVE",
        `A Codex Desktop process is already active for runId ${request.runId}`,
        expectedSessionId
      );
    }
    let preflightInterrupted: InterruptedKind | undefined;
    const preflightRun: ActiveRun = {
      stop: (kind): boolean => {
        if (preflightInterrupted !== undefined) return false;
        preflightInterrupted = kind;
        return true;
      }
    };
    this.reservedRunIds.add(request.runId);
    this.activeRuns.set(request.runId, preflightRun);

    const releasePreflight = (outcome: AgentRunOutcome): AgentRunOutcome => {
      if (this.activeRuns.get(request.runId) === preflightRun) {
        this.activeRuns.delete(request.runId);
      }
      this.reservedRunIds.delete(request.runId);
      return outcome;
    };
    const preflightInterruption = (): AgentRunOutcome | undefined =>
      preflightInterrupted === undefined
        ? undefined
        : interruptedOutcome(preflightInterrupted, expectedSessionId);

    try {
      await rm(request.outputPath, { force: true });
    } catch (error) {
      const interruption = preflightInterruption();
      if (interruption !== undefined) return releasePreflight(interruption);
      return releasePreflight(failedOutcome(
        "CODEX_OUTPUT_CLEANUP_FAILED",
        `Could not remove stale Codex Desktop output: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }
    const cleanupInterruption = preflightInterruption();
    if (cleanupInterruption !== undefined) {
      return releasePreflight(cleanupInterruption);
    }

    let outputSchemaText: string;
    try {
      outputSchemaText = await readFile(request.outputSchemaPath, "utf8");
    } catch (error) {
      const interruption = preflightInterruption();
      if (interruption !== undefined) return releasePreflight(interruption);
      return releasePreflight(failedOutcome(
        "CODEX_SCHEMA_READ_FAILED",
        `Could not read Codex Desktop output schema: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }
    const schemaReadInterruption = preflightInterruption();
    if (schemaReadInterruption !== undefined) {
      return releasePreflight(schemaReadInterruption);
    }

    let outputSchema: unknown;
    try {
      outputSchema = JSON.parse(outputSchemaText) as unknown;
    } catch (error) {
      return releasePreflight(failedOutcome(
        "CODEX_SCHEMA_INVALID",
        `Codex Desktop output schema was not valid JSON: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        this.executable,
        ["app-server", "--listen", "stdio://"],
        {
          cwd: request.cwd,
          detached: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
    } catch (error) {
      return releasePreflight(failedOutcome(
        "CODEX_SPAWN_FAILED",
        `Unable to start Codex app-server: ${errorMessage(error)}`,
        expectedSessionId
      ));
    }

    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited after exposing invalid stdio.
      }
      return releasePreflight(failedOutcome(
        "CODEX_PROTOCOL_ERROR",
        "Codex app-server stdin and stdout must be piped",
        expectedSessionId
      ));
    }

    stdout.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    return await new Promise<AgentRunOutcome>((settle) => {
      let settled = false;
      let processClosed = false;
      let sessionId = expectedSessionId;
      let turnId: string | undefined;
      let lastAgentMessage: CompletedAgentMessage | undefined;
      let stdoutRemainder = "";
      let stderr = "";
      let nextRequestId = 1;
      let completionReceived = false;
      let terminateTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const pendingRequests = new Map<string, PendingRequest>();

      let resolveCompletion: (params: unknown) => void = () => undefined;
      let rejectCompletion: (error: Error) => void = () => undefined;
      const completion = new Promise<unknown>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => undefined);

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
          // The private helper can exit while shutdown is being requested.
        }
      };

      const endInput = (): void => {
        if (stdin.destroyed || stdin.writableEnded) return;
        try {
          stdin.end();
        } catch {
          // Signal fallback below still cleans up the private helper.
        }
      };

      const scheduleForceKill = (): void => {
        if (processClosed || this.forceKillAfterMs < 0) return;
        forceKillTimer = setTimeout(() => {
          if (!processClosed) signalTree("SIGKILL");
        }, this.forceKillAfterMs);
        forceKillTimer.unref();
      };

      const shutdown = (mode: ShutdownMode): void => {
        endInput();
        if (processClosed) return;
        if (mode === "immediate") {
          signalTree("SIGTERM");
          scheduleForceKill();
          return;
        }
        if (this.forceKillAfterMs < 0) return;
        terminateTimer = setTimeout(() => {
          if (processClosed) return;
          signalTree("SIGTERM");
          scheduleForceKill();
        }, this.forceKillAfterMs);
        terminateTimer.unref();
      };

      const rejectWaiters = (error: Error): void => {
        for (const pending of pendingRequests.values()) pending.reject(error);
        pendingRequests.clear();
        rejectCompletion(error);
      };

      const finish = (
        outcome: AgentRunOutcome,
        shutdownMode: ShutdownMode
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        this.activeRuns.delete(request.runId);
        this.reservedRunIds.delete(request.runId);
        rejectWaiters(new Error("Codex Desktop run has finished"));
        shutdown(shutdownMode);
        settle(outcome);
      };

      const abortProtocol = (failure: CodexDesktopFailure): void => {
        if (settled) return;
        rejectWaiters(failure);
      };

      const writeMessage = (message: Record<string, unknown>): void => {
        if (settled || stdin.destroyed || stdin.writableEnded) {
          throw new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server stdin closed before the protocol completed"
          );
        }
        try {
          stdin.write(`${JSON.stringify(message)}\n`);
        } catch (error) {
          throw new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            `Could not write to Codex app-server: ${errorMessage(error)}`
          );
        }
      };

      const requestRpc = (
        method: string,
        params: Record<string, unknown>
      ): Promise<unknown> => {
        const id = nextRequestId;
        nextRequestId += 1;
        return new Promise<unknown>((resolve, reject) => {
          pendingRequests.set(String(id), { method, resolve, reject });
          try {
            writeMessage({ id, method, params });
          } catch (error) {
            pendingRequests.delete(String(id));
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };

      const handleNotification = (
        method: string,
        params: unknown
      ): void => {
        if (method === "item/completed") {
          if (!isRecord(params) || !isRecord(params.item)) return;
          if (params.item.type !== "agentMessage") return;
          const itemThreadId = nonEmptyString(params.threadId);
          const itemTurnId = nonEmptyString(params.turnId);
          if (
            typeof params.item.text !== "string" ||
            itemThreadId === undefined ||
            itemTurnId === undefined
          ) {
            abortProtocol(new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              "Codex agentMessage item did not include threadId, turnId, and text"
            ));
            return;
          }
          if (sessionId !== undefined && itemThreadId !== sessionId) {
            abortProtocol(new CodexDesktopFailure(
              "CODEX_SESSION_MISMATCH",
              `Codex agentMessage used thread ${itemThreadId} instead of ${sessionId}`
            ));
            return;
          }
          if (turnId !== undefined && itemTurnId !== turnId) {
            abortProtocol(new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              `Codex agentMessage used turn ${itemTurnId} instead of ${turnId}`
            ));
            return;
          }
          lastAgentMessage = {
            threadId: itemThreadId,
            turnId: itemTurnId,
            text: params.item.text
          };
          return;
        }
        if (method === "turn/completed") {
          completionReceived = true;
          resolveCompletion(params);
          return;
        }
        if (method === "error") {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            nestedMessage(params) ?? "Codex app-server reported an error"
          ));
        }
      };

      const handleLine = (line: string): void => {
        if (settled || line.trim().length === 0) return;

        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch (error) {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            `Codex app-server emitted invalid JSON: ${errorMessage(error)}`
          ));
          return;
        }
        if (!isRecord(message)) {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server emitted a non-object message"
          ));
          return;
        }

        const method = nonEmptyString(message.method);
        if (method !== undefined) {
          if (Object.hasOwn(message, "id")) {
            abortProtocol(new CodexDesktopFailure(
              "CODEX_INTERACTION_REQUIRED",
              `Codex app-server requested unsupported interaction: ${method}`
            ));
            return;
          }
          handleNotification(method, message.params);
          return;
        }

        const id = responseId(message.id);
        if (id === undefined) {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server emitted a message without a method or response id"
          ));
          return;
        }
        const pending = pendingRequests.get(id);
        if (pending === undefined) {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            `Codex app-server responded with unknown id ${id}`
          ));
          return;
        }
        pendingRequests.delete(id);
        if (Object.hasOwn(message, "error")) {
          pending.reject(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            `Codex app-server ${pending.method} failed: ${nestedMessage(message.error) ?? "unknown RPC error"}`
          ));
          return;
        }
        if (!Object.hasOwn(message, "result")) {
          pending.reject(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            `Codex app-server ${pending.method} response omitted result`
          ));
          return;
        }
        pending.resolve(message.result);
      };

      const consumeStdout = (chunk: string): void => {
        stdoutRemainder += chunk;
        let newlineIndex = stdoutRemainder.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutRemainder.slice(0, newlineIndex);
          stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
          handleLine(line);
          newlineIndex = stdoutRemainder.indexOf("\n");
        }
        if (stdoutRemainder.length > 1_000_000) {
          abortProtocol(new CodexDesktopFailure(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server emitted an oversized unterminated message"
          ));
        }
      };

      const handleStreamError = (
        stream: "stdin" | "stdout" | "stderr",
        error: Error
      ): void => {
        if (settled) return;
        finish(failedOutcome(
          "CODEX_PROTOCOL_ERROR",
          `Codex app-server ${stream} failed: ${error.message}`,
          sessionId
        ), "immediate");
      };

      stdin.on("error", (error) => handleStreamError("stdin", error));
      stdout.on("error", (error) => handleStreamError("stdout", error));
      stdout.on("data", consumeStdout);
      child.stderr?.on("error", (error) => handleStreamError("stderr", error));
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendBounded(stderr, chunk);
      });

      child.once("error", (error) => {
        if (settled || (completionReceived && pendingRequests.size === 0)) return;
        abortProtocol(new CodexDesktopFailure(
          "CODEX_SPAWN_FAILED",
          `Codex app-server process error: ${error.message}`
        ));
      });

      child.once("close", (exitCode, signal) => {
        processClosed = true;
        if (terminateTimer !== undefined) clearTimeout(terminateTimer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (stdoutRemainder.length > 0) {
          handleLine(stdoutRemainder);
          stdoutRemainder = "";
        }
        if (settled || (completionReceived && pendingRequests.size === 0)) return;
        const detail = diagnostics(
          stderr,
          exitCode === null ? undefined : `exit code ${String(exitCode)}`,
          signal === null ? undefined : `signal ${signal}`
        );
        abortProtocol(new CodexDesktopFailure(
          "CODEX_PROTOCOL_ERROR",
          detail.length > 0
            ? `Codex app-server exited before turn completion: ${detail}`
            : "Codex app-server exited before turn completion"
        ));
      });

      const stop = (kind: InterruptedKind): boolean => {
        if (settled) return false;
        const canInterrupt = sessionId !== undefined && turnId !== undefined;
        if (canInterrupt) {
          void requestRpc("turn/interrupt", {
            threadId: sessionId,
            turnId
          }).catch(() => undefined);
        }
        finish(
          interruptedOutcome(kind, sessionId),
          canInterrupt ? "graceful" : "immediate"
        );
        return true;
      };

      const active: ActiveRun = { stop };
      this.activeRuns.set(request.runId, active);
      const deadlineTimer = setTimeout(() => stop("TIMED_OUT"), request.deadlineMs);
      deadlineTimer.unref();

      void (async (): Promise<void> => {
        try {
          await requestRpc("initialize", {
            clientInfo: {
              name: "smartflow",
              title: "SmartFlow",
              version: "0.1.0"
            }
          });
          writeMessage({ method: "initialized" });

          const configResult = await requestRpc("config/read", {
            cwd: request.cwd,
            includeLayers: false
          });
          if (
            !isRecord(configResult) ||
            !isRecord(configResult.config) ||
            !isRecord(configResult.config.mcp_servers)
          ) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              "Codex app-server config/read response omitted config.mcp_servers"
            );
          }
          const disabledMcpServers = Object.fromEntries(
            Object.keys(configResult.config.mcp_servers).map((serverId) => [
              serverId,
              { enabled: false }
            ])
          );
          const threadOverrides = {
            cwd: request.cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            config: {
              features: { hooks: false },
              mcp_servers: disabledMcpServers
            },
            ...(request.model === undefined ? {} : { model: request.model })
          };
          const threadMethod = expectedSessionId === undefined
            ? "thread/start"
            : "thread/resume";
          const threadResult = await requestRpc(threadMethod, {
            ...threadOverrides,
            ...(expectedSessionId === undefined
              ? {}
              : { threadId: expectedSessionId })
          });
          const actualSessionId = nestedId(threadResult, "thread");
          if (actualSessionId === undefined) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              `Codex app-server ${threadMethod} response omitted thread.id`
            );
          }
          if (
            expectedSessionId !== undefined &&
            actualSessionId !== expectedSessionId
          ) {
            throw new CodexDesktopFailure(
              "CODEX_SESSION_MISMATCH",
              `Codex app-server resumed ${actualSessionId} instead of ${expectedSessionId}`
            );
          }
          sessionId = actualSessionId;

          const turnResult = await requestRpc("turn/start", {
            threadId: actualSessionId,
            input: [{ type: "text", text: request.prompt }],
            cwd: request.cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
            outputSchema,
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.effort === undefined ? {} : { effort: request.effort })
          });
          turnId = nestedId(turnResult, "turn");
          if (turnId === undefined) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              "Codex app-server turn/start response omitted turn.id"
            );
          }
          if (
            lastAgentMessage !== undefined &&
            lastAgentMessage.threadId !== actualSessionId
          ) {
            throw new CodexDesktopFailure(
              "CODEX_SESSION_MISMATCH",
              `Codex agentMessage used thread ${lastAgentMessage.threadId} instead of ${actualSessionId}`
            );
          }
          if (
            lastAgentMessage !== undefined &&
            lastAgentMessage.turnId !== turnId
          ) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              `Codex agentMessage used turn ${lastAgentMessage.turnId} instead of ${turnId}`
            );
          }

          const completedParams = await completion;
          if (!isRecord(completedParams) || !isRecord(completedParams.turn)) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              "Codex turn/completed notification omitted turn"
            );
          }
          const completedSessionId = nonEmptyString(completedParams.threadId);
          const completedTurnId = nonEmptyString(completedParams.turn.id);
          if (completedSessionId !== actualSessionId) {
            throw new CodexDesktopFailure(
              "CODEX_SESSION_MISMATCH",
              `Codex turn/completed used thread ${completedSessionId ?? "<missing>"} instead of ${actualSessionId}`
            );
          }
          if (completedTurnId !== turnId) {
            throw new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              `Codex turn/completed used turn ${completedTurnId ?? "<missing>"} instead of ${turnId}`
            );
          }

          const status = nonEmptyString(completedParams.turn.status);
          if (status !== "completed") {
            throw new CodexDesktopFailure(
              "CODEX_TURN_FAILED",
              nestedMessage(completedParams.turn.error) ??
                `Codex turn completed with status ${status ?? "<missing>"}`
            );
          }
          if (lastAgentMessage === undefined) {
            throw new CodexDesktopFailure(
              "CODEX_TURN_INCOMPLETE",
              "Codex completed without an agentMessage item"
            );
          }

          try {
            await writeFile(request.outputPath, lastAgentMessage.text, "utf8");
          } catch (error) {
            throw new CodexDesktopFailure(
              "CODEX_OUTPUT_WRITE_FAILED",
              `Could not write Codex Desktop output: ${errorMessage(error)}`
            );
          }

          let finalResponse: unknown;
          try {
            finalResponse = JSON.parse(lastAgentMessage.text) as unknown;
          } catch (error) {
            throw new CodexDesktopFailure(
              "CODEX_OUTPUT_INVALID",
              `Codex Desktop output was not valid JSON: ${errorMessage(error)}`
            );
          }

          finish({
            kind: "COMPLETED",
            sessionId: actualSessionId,
            finalResponse
          }, "graceful");
        } catch (error) {
          const failure = error instanceof CodexDesktopFailure
            ? error
            : new CodexDesktopFailure(
              "CODEX_PROTOCOL_ERROR",
              `Codex app-server protocol failed: ${errorMessage(error)}`
            );
          finish(
            failedOutcome(failure.code, failure.message, sessionId),
            "immediate"
          );
        }
      })();
    });
  }
}
