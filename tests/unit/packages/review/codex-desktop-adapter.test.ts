import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexDesktopAdapter,
  type AgentRunRequest
} from "@smartflow/review";

type CodexDesktopAdapterOptions = NonNullable<
  ConstructorParameters<typeof CodexDesktopAdapter>[0]
>;
type CodexDesktopKill = NonNullable<CodexDesktopAdapterOptions["kill"]>;
type CodexDesktopSpawn = NonNullable<CodexDesktopAdapterOptions["spawn"]>;

type WireMessage = Record<string, unknown>;

interface FakeServerOptions {
  readonly actualThreadId?: string;
  readonly turnId?: string;
  readonly output?: string;
  readonly autoComplete?: boolean;
  readonly rpcErrorMethod?: string;
  readonly interactionMethod?: string;
  readonly emitInvalidJson?: boolean;
  readonly itemThreadId?: string;
  readonly itemTurnId?: string;
  readonly closeBeforeTurnResponse?: boolean;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly malformedConfig?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killSignals: Array<NodeJS.Signals | number> = [];
  public readonly clientMessages: WireMessage[] = [];
  private inputRemainder = "";

  public constructor(
    public readonly pid: number,
    private readonly onClientMessage: (
      child: FakeChildProcess,
      message: WireMessage
    ) => void
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.consumeInput(chunk.toString("utf8"));
    });
  }

  public kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  public respond(id: string | number, result: unknown): void {
    this.writeServerMessage({ id, result });
  }

  public respondError(id: string | number, message: string): void {
    this.writeServerMessage({ id, error: { code: -32_000, message } });
  }

  public notify(method: string, params: unknown): void {
    this.writeServerMessage({ method, params });
  }

  public requestInteraction(
    id: string | number,
    method: string,
    params: unknown
  ): void {
    this.writeServerMessage({ id, method, params });
  }

  public writeInvalidJson(): void {
    this.stdout.write("not-json\n");
  }

  public complete(
    exitCode: number | null = 0,
    signal: NodeJS.Signals | null = null
  ): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signal);
  }

  public asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  private writeServerMessage(message: WireMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private consumeInput(chunk: string): void {
    this.inputRemainder += chunk;
    let newlineIndex = this.inputRemainder.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.inputRemainder.slice(0, newlineIndex);
      this.inputRemainder = this.inputRemainder.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        const message = JSON.parse(line) as unknown;
        if (!isRecord(message)) throw new Error("Client emitted a non-object message");
        this.clientMessages.push(message);
        this.onClientMessage(this, message);
      }
      newlineIndex = this.inputRemainder.indexOf("\n");
    }
  }
}

interface Harness {
  readonly adapter: CodexDesktopAdapter;
  readonly children: FakeChildProcess[];
  readonly spawn: ReturnType<typeof vi.fn<CodexDesktopSpawn>>;
  readonly kill: ReturnType<typeof vi.fn<CodexDesktopKill>>;
}

const directories: string[] = [];
const schema = {
  type: "object",
  additionalProperties: false,
  properties: { tasks: { type: "array" } },
  required: ["tasks"]
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-codex-desktop-"));
  directories.push(directory);
  return directory;
}

function request(
  root: string,
  overrides: Partial<AgentRunRequest> = {}
): AgentRunRequest {
  return {
    runId: "review-attempt-1",
    cwd: root,
    prompt: "Review the approved tasks.",
    outputSchemaPath: resolve(root, "review.schema.json"),
    outputPath: resolve(root, "review.output.json"),
    deadlineMs: 5_000,
    ...overrides
  };
}

async function writeSchema(runRequest: AgentRunRequest): Promise<void> {
  await writeFile(runRequest.outputSchemaPath, JSON.stringify(schema), "utf8");
}

function requiredId(message: WireMessage): string | number {
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    throw new Error("Client request omitted id");
  }
  return message.id;
}

function fakeServer(
  options: FakeServerOptions,
  child: FakeChildProcess,
  message: WireMessage
): void {
  const method = typeof message.method === "string" ? message.method : undefined;
  if (method === undefined) throw new Error("Client message omitted method");
  if (method === "initialized") return;

  const id = requiredId(message);
  if (options.rpcErrorMethod === method) {
    child.respondError(id, `${method} rejected`);
    return;
  }

  switch (method) {
    case "initialize":
      child.respond(id, { userAgent: "codex-app-server-test" });
      break;
    case "config/read":
      child.respond(id, options.malformedConfig === true
        ? { config: { mcp_servers: [] } }
        : {
            config: {
              mcp_servers: options.mcpServers ?? {
                "user-server": { command: "ignored-user-command" },
                "project-server": { url: "https://mcp.example.test" }
              }
            }
          });
      break;
    case "thread/start":
      child.respond(id, { thread: { id: options.actualThreadId ?? "thread-create" } });
      break;
    case "thread/resume": {
      const requestedThreadId = isRecord(message.params) &&
        typeof message.params.threadId === "string"
        ? message.params.threadId
        : "thread-resume";
      child.respond(id, {
        thread: { id: options.actualThreadId ?? requestedThreadId }
      });
      break;
    }
    case "turn/start": {
      const turnId = options.turnId ?? "turn-1";
      const params = isRecord(message.params) ? message.params : {};
      const threadId = typeof params.threadId === "string"
        ? params.threadId
        : "thread-create";
      if (options.closeBeforeTurnResponse === true) {
        child.notify("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed" }
        });
        child.complete(0);
        return;
      }
      child.respond(id, { turn: { id: turnId } });
      queueMicrotask(() => {
        if (options.interactionMethod !== undefined) {
          child.requestInteraction(900, options.interactionMethod, {
            reason: "approval required"
          });
          return;
        }
        if (options.emitInvalidJson === true) {
          child.writeInvalidJson();
          return;
        }
        if (options.autoComplete === false) return;
        child.notify("item/completed", {
          threadId: options.itemThreadId ?? threadId,
          turnId: options.itemTurnId ?? turnId,
          item: {
            id: "item-1",
            type: "agentMessage",
            text: options.output ?? JSON.stringify({ tasks: [] })
          }
        });
        child.notify("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed" }
        });
      });
      break;
    }
    case "turn/interrupt":
      child.respond(id, {});
      break;
    default:
      throw new Error(`Unexpected client method ${method}`);
  }
}

function harness(
  options: FakeServerOptions & {
    readonly forceKillAfterMs?: number;
    readonly spawnError?: Error;
  } = {}
): Harness {
  const children: FakeChildProcess[] = [];
  const spawn = vi.fn<CodexDesktopSpawn>((
    executable: string,
    argv: readonly string[],
    spawnOptions: SpawnOptions
  ): ChildProcess => {
    void executable;
    void argv;
    void spawnOptions;
    if (options.spawnError !== undefined) throw options.spawnError;
    const child = new FakeChildProcess(
      5_000 + children.length,
      (current, message) => fakeServer(options, current, message)
    );
    children.push(child);
    return child.asChildProcess();
  });
  const kill = vi.fn<CodexDesktopKill>(() => true);
  const adapter = new CodexDesktopAdapter({
    executable: "/fake/codex",
    spawn,
    kill,
    forceKillAfterMs: options.forceKillAfterMs ?? -1
  });
  return { adapter, children, spawn, kill };
}

function childAt(subject: Harness, index = 0): FakeChildProcess {
  const child = subject.children[index];
  if (child === undefined) throw new Error("Fake app-server was not spawned");
  return child;
}

function messageFor(child: FakeChildProcess, method: string): WireMessage {
  const message = child.clientMessages.find((candidate) => candidate.method === method);
  if (message === undefined) throw new Error(`Client did not send ${method}`);
  return message;
}

function paramsFor(child: FakeChildProcess, method: string): Record<string, unknown> {
  const params = messageFor(child, method).params;
  if (!isRecord(params)) throw new Error(`${method} did not include object params`);
  return params;
}

async function waitForMethod(
  child: FakeChildProcess,
  method: string
): Promise<void> {
  await vi.waitFor(() => {
    expect(child.clientMessages.some((message) => message.method === method)).toBe(true);
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("CodexDesktopAdapter", () => {
  it("runs CREATE through app-server and writes the final structured response", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root, {
      model: "review-model",
      effort: "xhigh"
    });
    await writeSchema(runRequest);
    await writeFile(runRequest.outputPath, JSON.stringify({ stale: true }), "utf8");
    const subject = harness({ output: JSON.stringify({ tasks: [{ id: "T001" }] }) });

    await expect(subject.adapter.createSession(runRequest)).resolves.toEqual({
      kind: "COMPLETED",
      sessionId: "thread-create",
      finalResponse: { tasks: [{ id: "T001" }] }
    });

    const child = childAt(subject);
    expect(subject.spawn).toHaveBeenCalledWith(
      "/fake/codex",
      ["app-server", "--listen", "stdio://"],
      {
        cwd: root,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    expect(child.clientMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "thread/start",
      "turn/start"
    ]);
    expect(child.clientMessages.every((message) => !Object.hasOwn(message, "jsonrpc")))
      .toBe(true);
    expect(paramsFor(child, "initialize")).toEqual({
      clientInfo: {
        name: "smartflow",
        title: "SmartFlow",
        version: "0.1.0"
      }
    });
    expect(paramsFor(child, "config/read")).toEqual({
      cwd: root,
      includeLayers: false
    });
    expect(paramsFor(child, "thread/start")).toEqual({
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        features: { hooks: false },
        mcp_servers: {
          "user-server": { enabled: false },
          "project-server": { enabled: false }
        }
      },
      model: "review-model"
    });
    expect(paramsFor(child, "turn/start")).toEqual({
      threadId: "thread-create",
      input: [{ type: "text", text: runRequest.prompt }],
      cwd: root,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      outputSchema: schema,
      model: "review-model",
      effort: "xhigh"
    });
    await expect(readFile(runRequest.outputPath, "utf8")).resolves.toBe(
      JSON.stringify({ tasks: [{ id: "T001" }] })
    );
  });

  it("resumes the requested thread and omits unset model overrides", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root, {
      runId: "review-attempt-2",
      prompt: "Correct the rejected review.",
      effort: "low"
    });
    await writeSchema(runRequest);
    const subject = harness();

    await expect(subject.adapter.resume("thread-resume", runRequest)).resolves.toMatchObject({
      kind: "COMPLETED",
      sessionId: "thread-resume"
    });

    const child = childAt(subject);
    expect(paramsFor(child, "config/read")).toEqual({
      cwd: root,
      includeLayers: false
    });
    expect(paramsFor(child, "thread/resume")).toEqual({
      threadId: "thread-resume",
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        features: { hooks: false },
        mcp_servers: {
          "user-server": { enabled: false },
          "project-server": { enabled: false }
        }
      }
    });
    expect(paramsFor(child, "thread/resume")).not.toHaveProperty("model");
    expect(paramsFor(child, "turn/start")).toMatchObject({
      threadId: "thread-resume",
      effort: "low"
    });
    expect(paramsFor(child, "turn/start")).not.toHaveProperty("model");
  });

  it.each([
    {
      name: "CREATE config/read rejection",
      mode: "CREATE" as const,
      options: { rpcErrorMethod: "config/read" }
    },
    {
      name: "CREATE thread/start rejection",
      mode: "CREATE" as const,
      options: { rpcErrorMethod: "thread/start" }
    },
    {
      name: "RESUME config/read rejection",
      mode: "RESUME" as const,
      options: { rpcErrorMethod: "config/read" }
    },
    {
      name: "RESUME thread/resume rejection",
      mode: "RESUME" as const,
      options: { rpcErrorMethod: "thread/resume" }
    },
    {
      name: "malformed effective config",
      mode: "CREATE" as const,
      options: { malformedConfig: true }
    }
  ])("fails closed before turn/start for $name", async ({ mode, options }) => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness(options);

    const outcome = mode === "CREATE"
      ? subject.adapter.createSession(runRequest)
      : subject.adapter.resume("thread-resume", runRequest);
    await expect(outcome).resolves.toMatchObject({
      kind: "FAILED",
      code: "CODEX_PROTOCOL_ERROR"
    });
    expect(childAt(subject).clientMessages.some(
      (message) => message.method === "turn/start"
    )).toBe(false);
  });

  it("rejects a thread/resume response for a different session", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ actualThreadId: "thread-other" });

    await expect(subject.adapter.resume("thread-expected", runRequest)).resolves.toEqual({
      kind: "FAILED",
      sessionId: "thread-expected",
      code: "CODEX_SESSION_MISMATCH",
      message: "Codex app-server resumed thread-other instead of thread-expected"
    });
  });

  it("rejects an agent message for a different thread or turn", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ itemThreadId: "thread-stale" });

    await expect(subject.adapter.createSession(runRequest)).resolves.toEqual({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_SESSION_MISMATCH",
      message: "Codex agentMessage used thread thread-stale instead of thread-create"
    });
  });

  it("reports schema and startup failures before beginning the protocol", async () => {
    const root = await temporaryDirectory();
    const missingSchemaRequest = request(root);
    const missingSubject = harness();

    await expect(missingSubject.adapter.createSession(missingSchemaRequest)).resolves
      .toMatchObject({ kind: "FAILED", code: "CODEX_SCHEMA_READ_FAILED" });
    expect(missingSubject.spawn).not.toHaveBeenCalled();

    await writeFile(missingSchemaRequest.outputSchemaPath, "not-json", "utf8");
    const invalidSubject = harness();
    await expect(invalidSubject.adapter.createSession(missingSchemaRequest)).resolves
      .toMatchObject({ kind: "FAILED", code: "CODEX_SCHEMA_INVALID" });
    expect(invalidSubject.spawn).not.toHaveBeenCalled();

    await writeSchema(missingSchemaRequest);
    const spawnSubject = harness({ spawnError: new Error("spawn ENOENT") });
    await expect(spawnSubject.adapter.createSession(missingSchemaRequest)).resolves.toEqual({
      kind: "FAILED",
      code: "CODEX_SPAWN_FAILED",
      message: "Unable to start Codex app-server: spawn ENOENT"
    });
  });

  it.each([
    {
      name: "RPC errors",
      options: { rpcErrorMethod: "turn/start" },
      message: "Codex app-server turn/start failed: turn/start rejected"
    },
    {
      name: "invalid JSON",
      options: { emitInvalidJson: true },
      message: "Codex app-server emitted invalid JSON"
    }
  ])("maps $name to a bounded protocol failure", async ({ options, message }) => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness(options);

    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_PROTOCOL_ERROR",
      message: expect.stringContaining(message) as unknown
    });
  });

  it("fails promptly when a completion arrives but app-server closes with an RPC pending", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ closeBeforeTurnResponse: true });

    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_PROTOCOL_ERROR",
      message: expect.stringContaining("exited before turn completion") as unknown
    });
  });

  it("maps asynchronous app-server stdin errors instead of leaking EPIPE", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ autoComplete: false });

    const run = subject.adapter.createSession(runRequest);
    await vi.waitFor(() => expect(subject.children).toHaveLength(1));
    const child = childAt(subject);
    await waitForMethod(child, "turn/start");
    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(run).resolves.toEqual({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_PROTOCOL_ERROR",
      message: "Codex app-server stdin failed: write EPIPE"
    });
  });

  it("fails instead of trying to answer an app-server interaction request", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({
      interactionMethod: "item/commandExecution/requestApproval"
    });

    await expect(subject.adapter.createSession(runRequest)).resolves.toEqual({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_INTERACTION_REQUIRED",
      message: "Codex app-server requested unsupported interaction: item/commandExecution/requestApproval"
    });
  });

  it("latches cancellation during output/schema preflight and never spawns", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness();

    const run = subject.adapter.createSession(runRequest);
    await expect(subject.adapter.cancel(runRequest.runId)).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED" });
    expect(subject.spawn).not.toHaveBeenCalled();
  });

  it("rejects a duplicate runId and interrupts the active turn on cancel", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ autoComplete: false, forceKillAfterMs: 0 });

    const run = subject.adapter.createSession(runRequest);
    await vi.waitFor(() => expect(subject.children).toHaveLength(1));
    const child = childAt(subject);
    await waitForMethod(child, "turn/start");

    await expect(subject.adapter.createSession(runRequest)).resolves.toEqual({
      kind: "FAILED",
      code: "CODEX_RUN_ACTIVE",
      message: "A Codex Desktop process is already active for runId review-attempt-1"
    });
    await expect(subject.adapter.cancel(runRequest.runId)).resolves.toBe(true);
    await expect(run).resolves.toEqual({
      kind: "CANCELED",
      sessionId: "thread-create"
    });
    expect(paramsFor(child, "turn/interrupt")).toEqual({
      threadId: "thread-create",
      turnId: "turn-1"
    });
    await vi.waitFor(() => {
      expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    });
    await expect(subject.adapter.cancel(runRequest.runId)).resolves.toBe(false);
  });

  it("interrupts the active turn when its deadline expires", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root, { deadlineMs: 50 });
    await writeSchema(runRequest);
    const subject = harness({ autoComplete: false });

    const run = subject.adapter.createSession(runRequest);
    await vi.waitFor(() => expect(subject.children).toHaveLength(1));
    const child = childAt(subject);
    await waitForMethod(child, "turn/start");

    await expect(run).resolves.toEqual({
      kind: "TIMED_OUT",
      sessionId: "thread-create"
    });
    expect(paramsFor(child, "turn/interrupt")).toEqual({
      threadId: "thread-create",
      turnId: "turn-1"
    });
  });

  it("writes but rejects a final agent message that is not JSON", async () => {
    const root = await temporaryDirectory();
    const runRequest = request(root);
    await writeSchema(runRequest);
    const subject = harness({ output: "not-json" });

    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "thread-create",
      code: "CODEX_OUTPUT_INVALID"
    });
    await expect(readFile(runRequest.outputPath, "utf8")).resolves.toBe("not-json");
  });
});
