import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { WorkerStartInput } from "@smartflow/provider-core";
import {
  ExecutionSandboxAdapter,
  type SandboxCapabilities,
  type SandboxedProcessHandle,
  type SandboxedSpawnRequest
} from "@smartflow/workspace";

import { PiProvider } from "../../../../packages/provider-pi/src/pi-provider.js";
import {
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "../../../../packages/provider-pi/src/runtime-config.js";

const configuration: PiRuntimeConfiguration = {
  api: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  modelId: "test-model",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  thinkingLevel: "off",
  attemptDeadlineMs: 60_000,
  resourcePolicy: "workspace-project-resources"
};

const sessionFile = "/workspace/.smartflow-runtime/sessions/pi-session-1.jsonl";

function input(resumeSession?: WorkerStartInput["resumeSession"]): WorkerStartInput {
  return {
    attemptId: "attempt-1",
    generation: 0,
    workspaceDir: "/workspace",
    prompt: "implement",
    providerRuntimeConfigHash: piRuntimeConfigHash(configuration),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...(resumeSession === undefined ? {} : { resumeSession }),
    containment: {
      registryPath: "/workspace/.smartflow-runtime/containments.json",
      homeDirectory: "/workspace/.smartflow-runtime/home",
      tempDirectory: "/workspace/.smartflow-runtime/tmp",
      runtimeReadPaths: [],
      deniedReadPaths: ["/protected"]
    }
  };
}

class FakeSandbox extends ExecutionSandboxAdapter {
  public terminations = 0;
  public renewals = 0;
  public lastRequest: SandboxedSpawnRequest | undefined;
  public readonly commandTypes: string[] = [];

  public constructor(
    private readonly state: { sessionId: string; sessionFile: string } = {
      sessionId: "pi-session-1",
      sessionFile
    }
  ) {
    super();
  }

  public override probe(): Promise<SandboxCapabilities> {
    return Promise.resolve({
      available: true,
      engine: "darwin-sandbox-exec",
      fileIsolation: true,
      networkIsolation: true,
      processTreeControl: true
    });
  }

  public override spawn(request: SandboxedSpawnRequest): Promise<SandboxedProcessHandle> {
    this.lastRequest = request;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffered = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const command = JSON.parse(line) as { id: string; type: string };
        this.commandTypes.push(command.type);
        const data = command.type === "get_state"
          ? this.state
          : command.type === "get_last_assistant_text"
            ? { text: "done" }
            : {};
        stdout.write(`${JSON.stringify({
          id: command.id,
          type: "response",
          success: true,
          data
        })}\n`);
        if (command.type === "prompt") {
          stdout.write(`${JSON.stringify({
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: "smartflow-heartbeat",
            statusText: String(Date.now())
          })}\n`);
          stdout.write(`${JSON.stringify({
            type: "tool_execution_start",
            toolName: "write",
            toolCallId: "call-1"
          })}\n`);
          stdout.write(`${JSON.stringify({
            type: "tool_execution_end",
            toolName: "write",
            toolCallId: "call-1",
            isError: false
          })}\n`);
          stdout.write(`${JSON.stringify({ type: "agent_end", willRetry: false })}\n`);
        }
      }
    });
    let settleExit!: (result: Awaited<ReturnType<SandboxedProcessHandle["wait"]>>) => void;
    const exit = new Promise<Awaited<ReturnType<SandboxedProcessHandle["wait"]>>>((settle) => {
      settleExit = settle;
    });
    let terminated = false;
    return Promise.resolve({
      attemptId: request.attemptId,
      containmentId: "containment-1",
      configHash: request.configHash,
      pid: 1234,
      processStartToken: "process-start-1",
      stdin,
      stdout,
      stderr,
      wait: () => exit,
      renewDeadline: (): boolean => {
        this.renewals += 1;
        return true;
      },
      terminate: (): Promise<{ treeEmpty: boolean }> => {
        this.terminations += 1;
        if (!terminated) {
          terminated = true;
          settleExit({
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
            treeEmpty: true
          });
        }
        return Promise.resolve({ treeEmpty: true });
      }
    });
  }
}

describe("Pi Provider", () => {
  it("probes the one-model Extension registration without a model request", async () => {
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "test-credential" },
      createSandbox: (): ExecutionSandboxAdapter => new FakeSandbox()
    });
    await expect(provider.probe()).resolves.toMatchObject({
      available: true,
      details: {
        api: "openai-completions",
        model: "test-model",
        extensionProviderId: "smartflow-mcp",
        registeredModelCount: 1
      }
    });
  });

  it("streams official SDK tool events and one terminal session identity", async () => {
    const sandbox = new FakeSandbox();
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "test-credential" },
      createSandbox: (): ExecutionSandboxAdapter => sandbox
    });
    const events = [];
    for await (const event of provider.start(input())) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "STARTED",
      "TOOL_STARTED",
      "TOOL_FINISHED",
      "COMPLETED"
    ]);
    expect(sandbox.renewals).toBe(1);
    expect(events[0]).toMatchObject({
      piSessionId: "pi-session-1",
      containmentId: "containment-1"
    });
    expect(events.at(-1)).toMatchObject({ piSessionId: "pi-session-1", sessionFile });
    expect(sandbox.terminations).toBe(1);
    expect(sandbox.lastRequest?.argv).toEqual(expect.arrayContaining([
      "--extension",
      "--no-extensions",
      "--provider",
      "smartflow-mcp",
      "--model",
      "test-model"
    ]));
    expect(sandbox.lastRequest?.argv).not.toContain("--session");
    expect(sandbox.lastRequest?.environment).toMatchObject({
      WORK_API: "openai-completions",
      WORK_BASE_URL: "https://models.example.test/v1",
      WORK_MODEL: "test-model",
      WORK_API_KEY: "test-credential"
    });
    expect(sandbox.lastRequest?.argv.join(" ")).not.toContain("test-credential");
  });

  it("resumes the exact PI session file and preserves its session identity", async () => {
    const sandbox = new FakeSandbox();
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "test-credential" },
      createSandbox: (): ExecutionSandboxAdapter => sandbox
    });
    const events = [];
    for await (const event of provider.start(input({
      expectedPiSessionId: "pi-session-1",
      sessionFile
    }))) events.push(event);

    expect(events[0]).toMatchObject({ type: "STARTED", piSessionId: "pi-session-1" });
    expect(events.at(-1)).toMatchObject({
      type: "COMPLETED",
      piSessionId: "pi-session-1",
      sessionFile
    });
    const sessionIndex = sandbox.lastRequest?.argv.indexOf("--session") ?? -1;
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(sandbox.lastRequest?.argv.slice(sessionIndex, sessionIndex + 2))
      .toEqual(["--session", sessionFile]);
  });

  it("fails a resumed PI session identity mismatch before sending the prompt", async () => {
    const sandbox = new FakeSandbox({
      sessionId: "unexpected-session",
      sessionFile
    });
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "test-credential" },
      createSandbox: (): ExecutionSandboxAdapter => sandbox
    });
    const events = [];
    for await (const event of provider.start(input({
      expectedPiSessionId: "pi-session-1",
      sessionFile
    }))) events.push(event);

    expect(events).toEqual([expect.objectContaining({
      type: "FAILED",
      code: "PI_PROVIDER_FAILED",
      message: "PI_SESSION_RESUME_ID_MISMATCH"
    })]);
    expect(sandbox.commandTypes).toEqual(["get_state"]);
    expect(sandbox.terminations).toBe(1);
  });

  it("cancels the active Pi containment as a full tree", async () => {
    const sandbox = new FakeSandbox();
    const provider = new PiProvider({
      runtimeConfig: configuration,
      environment: { WORK_API_KEY: "test-credential" },
      createSandbox: (): ExecutionSandboxAdapter => sandbox
    });
    const iterator = provider.start(input())[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "STARTED", piSessionId: "pi-session-1" }
    });
    await expect(provider.cancel("attempt-1")).resolves.toEqual({
      attemptId: "attempt-1",
      requested: true,
      treeEmpty: true
    });
    await iterator.return?.();
  });
});
