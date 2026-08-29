import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClaudeCodeAdapter,
  type AgentRunRequest
} from "@smartflow/review";

type ClaudeCodeAdapterOptions = NonNullable<
  ConstructorParameters<typeof ClaudeCodeAdapter>[0]
>;
type ClaudeCodeKill = NonNullable<ClaudeCodeAdapterOptions["kill"]>;

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killSignals: Array<NodeJS.Signals | number> = [];

  public constructor(public readonly pid: number) {
    super();
  }

  public kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
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
}

interface Harness {
  readonly adapter: ClaudeCodeAdapter;
  readonly children: FakeChildProcess[];
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn<ClaudeCodeKill>>;
}

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-claude-code-adapter-"));
  directories.push(directory);
  return directory;
}

async function request(
  root: string,
  overrides: Partial<AgentRunRequest> = {}
): Promise<AgentRunRequest> {
  const value: AgentRunRequest = {
    runId: "review-attempt-1",
    cwd: root,
    prompt: "Review the approved tasks.",
    outputSchemaPath: resolve(root, "review.schema.json"),
    outputPath: resolve(root, "review.output.json"),
    deadlineMs: 5_000,
    ...overrides
  };
  await writeFile(value.outputSchemaPath, JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { tasks: { type: "array" } },
    required: ["tasks"],
    additionalProperties: false
  }), "utf8");
  return value;
}

function harness(options: { forceKillAfterMs?: number; spawnError?: Error } = {}): Harness {
  const children: FakeChildProcess[] = [];
  const spawn = vi.fn((
    executable: string,
    argv: readonly string[],
    spawnOptions: SpawnOptions
  ): ChildProcess => {
    void executable;
    void argv;
    void spawnOptions;
    if (options.spawnError !== undefined) throw options.spawnError;
    const child = new FakeChildProcess(5_000 + children.length);
    children.push(child);
    return child.asChildProcess();
  });
  const kill = vi.fn<ClaudeCodeKill>(() => true);
  const adapter = new ClaudeCodeAdapter({
    executable: "/fake/claude",
    spawn,
    kill,
    forceKillAfterMs: options.forceKillAfterMs ?? 1_000
  });
  return { adapter, children, spawn, kill };
}

function spawnedArgv(subject: Harness, index = 0): string[] {
  const argv = subject.spawn.mock.calls[index]?.[1] as readonly string[] | undefined;
  if (argv === undefined) throw new Error("claude was not spawned");
  return [...argv];
}

async function childAt(children: FakeChildProcess[], index = 0): Promise<FakeChildProcess> {
  await vi.waitFor(() => {
    expect(children.length).toBeGreaterThan(index);
  });
  const child = children[index];
  if (child === undefined) throw new Error("fake child was not spawned");
  return child;
}

function emitResult(child: FakeChildProcess, result: Record<string, unknown>): void {
  child.stdout.write(JSON.stringify({ type: "result", ...result }));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("ClaudeCodeAdapter", () => {
  it("uses safe CREATE argv and writes structured_output", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root, { model: "sonnet", effort: "high" });
    await writeFile(runRequest.outputPath, JSON.stringify({ stale: true }), "utf8");

    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    child.stderr.write("non-fatal diagnostic\n");
    emitResult(child, {
      subtype: "success",
      session_id: "session-create",
      structured_output: { tasks: [] }
    });
    child.complete(0);

    await expect(run).resolves.toEqual({
      kind: "COMPLETED",
      sessionId: "session-create",
      finalResponse: { tasks: [] }
    });
    expect(JSON.parse(await readFile(runRequest.outputPath, "utf8"))).toEqual({ tasks: [] });
    const schema = JSON.stringify(JSON.parse(
      await readFile(runRequest.outputSchemaPath, "utf8")
    ));
    expect(spawnedArgv(subject)).toEqual([
      "-p",
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
      "--model",
      "sonnet",
      "--effort",
      "high",
      runRequest.prompt
    ]);
    expect(subject.spawn.mock.calls[0]?.[0]).toBe("/fake/claude");
    expect(subject.spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: root,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(spawnedArgv(subject)).not.toContain("--version");
    expect(spawnedArgv(subject)).not.toContain("--bare");
  });

  it("resumes the exact session and omits unconfigured model and effort", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root, {
      runId: "review-attempt-2",
      prompt: "Correct the rejected review."
    });

    const run = subject.adapter.resume("session-resume", runRequest);
    const child = await childAt(subject.children);
    emitResult(child, {
      subtype: "success",
      session_id: "session-resume",
      structured_output: { tasks: [{ id: "T001" }] }
    });
    child.complete(0);

    await expect(run).resolves.toMatchObject({
      kind: "COMPLETED",
      sessionId: "session-resume"
    });
    const resumeArgv = spawnedArgv(subject);
    expect(resumeArgv.slice(0, 3)).toEqual(["-p", "--resume", "session-resume"]);
    expect(resumeArgv).not.toContain("--continue");
    expect(resumeArgv).not.toContain("--fork-session");
    expect(resumeArgv).not.toContain("--model");
    expect(resumeArgv).not.toContain("--effort");
    expect(resumeArgv.at(-1)).toBe(runRequest.prompt);
  });

  it.each([
    "error_max_turns",
    "error_during_execution",
    "error_max_budget_usd",
    "error_max_structured_output_retries"
  ])("maps official result subtype %s to one run failure", async (subtype) => {
    const root = await temporaryDirectory();
    const subject = harness();
    const run = subject.adapter.createSession(await request(root));
    const child = await childAt(subject.children);
    emitResult(child, {
      subtype,
      session_id: "session-failed",
      terminal_reason: "model_error",
      errors: ["request failed"]
    });
    child.complete(1);

    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "FAILED",
      sessionId: "session-failed",
      code: "CLAUDE_RUN_FAILED"
    });
    if (outcome.kind !== "FAILED") throw new Error("expected Claude run failure");
    expect(outcome.message).toContain(`subtype=${subtype}`);
  });

  it("rejects success without structured output and a changed resume session", async () => {
    const root = await temporaryDirectory();
    const missingSubject = harness();
    const missingRun = missingSubject.adapter.createSession(await request(root));
    const missingChild = await childAt(missingSubject.children);
    emitResult(missingChild, { subtype: "success", session_id: "session-missing" });
    missingChild.complete(0);
    await expect(missingRun).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "session-missing",
      code: "CLAUDE_RESULT_INVALID"
    });

    const mismatchSubject = harness();
    const mismatchRequest = await request(root, { runId: "review-attempt-mismatch" });
    const mismatchRun = mismatchSubject.adapter.resume("session-expected", mismatchRequest);
    const mismatchChild = await childAt(mismatchSubject.children);
    emitResult(mismatchChild, {
      subtype: "success",
      session_id: "session-observed",
      structured_output: { tasks: [] }
    });
    mismatchChild.complete(0);
    await expect(mismatchRun).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "session-expected",
      code: "CLAUDE_RESULT_INVALID"
    });
  });

  it("distinguishes startup and invalid-schema failures", async () => {
    const root = await temporaryDirectory();
    const startupSubject = harness({ spawnError: new Error("spawn ENOENT") });
    await expect(startupSubject.adapter.createSession(await request(root))).resolves.toEqual({
      kind: "FAILED",
      code: "CLAUDE_PROCESS_FAILED",
      message: "Unable to start Claude: spawn ENOENT"
    });
    expect(startupSubject.spawn).toHaveBeenCalledTimes(1);

    const schemaSubject = harness();
    const schemaRequest = await request(root, { runId: "invalid-schema" });
    await writeFile(schemaRequest.outputSchemaPath, "{broken", "utf8");
    await expect(schemaSubject.adapter.createSession(schemaRequest)).resolves.toMatchObject({
      kind: "FAILED",
      code: "CLAUDE_REQUEST_INVALID"
    });
    expect(schemaSubject.spawn).not.toHaveBeenCalled();
  });

  it("uses process failure only when a non-zero exit has no valid result", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const run = subject.adapter.createSession(await request(root));
    const child = await childAt(subject.children);
    child.stdout.write("not-json");
    child.stderr.write("authentication unavailable");
    child.complete(1);

    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "FAILED",
      code: "CLAUDE_PROCESS_FAILED"
    });
    if (outcome.kind !== "FAILED") throw new Error("expected Claude process failure");
    expect(outcome.message).toContain("authentication unavailable");
  });

  it("cancels during preflight without spawning Claude", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root, { runId: "review-preflight-cancel" });

    const run = subject.adapter.createSession(runRequest);
    const cancellation = subject.adapter.cancel(runRequest.runId);

    await expect(cancellation).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED" });
    expect(subject.spawn).not.toHaveBeenCalled();
  });

  it("reserves runId until the canceled detached process exits", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root);
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    let runSettled = false;
    void run.then(() => {
      runSettled = true;
    });

    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      code: "CLAUDE_RUN_ACTIVE"
    });
    const cancellation = subject.adapter.cancel(runRequest.runId);
    expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      code: "CLAUDE_RUN_ACTIVE"
    });
    await Promise.resolve();
    expect(runSettled).toBe(false);

    child.complete(null, "SIGTERM");
    await expect(cancellation).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED" });
    await expect(subject.adapter.cancel(runRequest.runId)).resolves.toBe(false);
  });

  it("force-kills a canceled child that does not exit after SIGTERM", async () => {
    const root = await temporaryDirectory();
    const subject = harness({ forceKillAfterMs: 10 });
    const runRequest = await request(root, { runId: "review-force-kill" });
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);

    const cancellation = subject.adapter.cancel(runRequest.runId);
    await vi.waitFor(() => {
      expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    });
    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      code: "CLAUDE_RUN_ACTIVE"
    });

    child.complete(null, "SIGKILL");
    await expect(cancellation).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED" });
  });

  it("times out and retains ownership until the detached process exits", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const run = subject.adapter.resume(
      "session-timeout",
      await request(root, { deadlineMs: 100 })
    );
    const child = await childAt(subject.children);
    let runSettled = false;
    void run.then(() => {
      runSettled = true;
    });

    await vi.waitFor(() => {
      expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    });
    expect(runSettled).toBe(false);
    child.complete(null, "SIGTERM");

    await expect(run).resolves.toEqual({
      kind: "TIMED_OUT",
      sessionId: "session-timeout"
    });
  });
});
