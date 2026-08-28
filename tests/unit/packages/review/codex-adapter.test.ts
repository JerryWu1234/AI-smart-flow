import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAdapter,
  type AgentRunRequest
} from "@smartflow/review";

type CodexAdapterOptions = NonNullable<ConstructorParameters<typeof CodexAdapter>[0]>;
type CodexKill = NonNullable<CodexAdapterOptions["kill"]>;

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
  readonly adapter: CodexAdapter;
  readonly children: FakeChildProcess[];
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn<CodexKill>>;
}

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-codex-adapter-"));
  directories.push(directory);
  return directory;
}

function request(root: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
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
    const child = new FakeChildProcess(4_000 + children.length);
    children.push(child);
    return child.asChildProcess();
  });
  const kill = vi.fn<CodexKill>(() => true);
  const adapter = new CodexAdapter({
    executable: "/fake/codex",
    spawn,
    kill,
    forceKillAfterMs: options.forceKillAfterMs ?? 1_000
  });
  return { adapter, children, spawn, kill };
}

function spawnedArgv(subject: Harness, index = 0): string[] {
  const argv = subject.spawn.mock.calls[index]?.[1] as readonly string[] | undefined;
  if (argv === undefined) throw new Error("codex was not spawned");
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

function emitSuccess(child: FakeChildProcess, sessionId: string): void {
  child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { output_tokens: 8 } })}\n`);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("CodexAdapter", () => {
  it("reports executable startup failures from the real Review attempt", async () => {
    const root = await temporaryDirectory();
    const subject = harness({ spawnError: new Error("spawn ENOENT") });
    const runRequest = request(root);

    await expect(subject.adapter.createSession(runRequest)).resolves.toEqual({
      kind: "FAILED",
      code: "CODEX_SPAWN_FAILED",
      message: "Unable to start Codex: spawn ENOENT"
    });
    expect(subject.spawn).toHaveBeenCalledTimes(1);
    expect(spawnedArgv(subject)[0]).toBe("exec");
    expect(spawnedArgv(subject)).not.toContain("--version");
  });

  it("uses CREATE argv and ignores non-fatal stderr on a successful run", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = request(root, { model: "review-model", effort: "xhigh" });
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);

    await writeFile(runRequest.outputPath, JSON.stringify({ tasks: [] }), "utf8");
    child.stderr.write("ERROR telemetry export unavailable; continuing\n");
    child.stdout.write("non-json wrapper diagnostics\n");
    emitSuccess(child, "thread-create");
    child.complete(0);

    await expect(run).resolves.toEqual({
      kind: "COMPLETED",
      sessionId: "thread-create",
      finalResponse: { tasks: [] }
    });
    expect(subject.spawn.mock.calls[0]?.[1]).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-c",
      'sandbox_mode="read-only"',
      "--output-schema",
      runRequest.outputSchemaPath,
      "--output-last-message",
      runRequest.outputPath,
      "-m",
      "review-model",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--cd",
      root,
      runRequest.prompt
    ]);
    expect(subject.spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: root,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(subject.spawn.mock.calls[0]?.[1]).not.toContain("--ephemeral");
  });

  it("forwards model and effort on RESUME without flags codex exec resume rejects", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = request(root, {
      runId: "review-attempt-2",
      prompt: "Correct the rejected review.",
      model: "review-model",
      effort: "low"
    });
    const run = subject.adapter.resume("thread-resume", runRequest);
    const child = await childAt(subject.children);

    await writeFile(runRequest.outputPath, JSON.stringify({ tasks: [{ id: "T001" }] }), "utf8");
    emitSuccess(child, "thread-resume");
    child.complete(0);

    await expect(run).resolves.toMatchObject({
      kind: "COMPLETED",
      sessionId: "thread-resume"
    });
    const resumeArgv = spawnedArgv(subject);
    expect(resumeArgv).toEqual([
      "exec",
      "resume",
      "thread-resume",
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-c",
      'sandbox_mode="read-only"',
      "--output-schema",
      runRequest.outputSchemaPath,
      "--output-last-message",
      runRequest.outputPath,
      "-m",
      "review-model",
      "-c",
      'model_reasoning_effort="low"',
      runRequest.prompt
    ]);
    // `codex exec resume` rejects both of these outright, so forwarding either
    // one breaks every repair round.
    expect(resumeArgv).not.toContain("--sandbox");
    expect(resumeArgv).not.toContain("--cd");
    // The worktree still comes from the spawned process instead.
    expect(subject.spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: root });
  });

  it.each(["CREATE", "RESUME"] as const)(
    "omits model and effort flags on %s when neither is configured",
    async (mode) => {
      const root = await temporaryDirectory();
      const subject = harness();
      const runRequest = request(root);
      const run = mode === "CREATE"
        ? subject.adapter.createSession(runRequest)
        : subject.adapter.resume("thread-bare", runRequest);
      const child = await childAt(subject.children);

      await writeFile(runRequest.outputPath, JSON.stringify({ tasks: [] }), "utf8");
      emitSuccess(child, "thread-bare");
      child.complete(0);

      await expect(run).resolves.toMatchObject({ kind: "COMPLETED" });
      const argv = spawnedArgv(subject);
      expect(argv).not.toContain("-m");
      expect(argv.filter((token) => token === "-c")).toHaveLength(1);
      expect(argv).toContain('sandbox_mode="read-only"');
      expect(argv.some((token) => token.startsWith("model_reasoning_effort"))).toBe(false);
      if (mode === "RESUME") {
        expect(argv).not.toContain("--sandbox");
        expect(argv).not.toContain("--cd");
        expect(subject.spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: root });
      }
    }
  );

  it("removes stale output and fails when Codex does not produce a new file", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = request(root);
    await writeFile(runRequest.outputPath, JSON.stringify({ stale: true }), "utf8");

    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    emitSuccess(child, "thread-missing-output");
    child.complete(0);

    await expect(run).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "thread-missing-output",
      code: "CODEX_OUTPUT_MISSING"
    });
  });

  it("lets an explicit failure event override a zero exit and output file", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = request(root);
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);

    await writeFile(runRequest.outputPath, JSON.stringify({ tasks: [] }), "utf8");
    child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-failed" })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: "turn.failed",
      error: { message: "response schema rejected" }
    })}\n`);
    child.complete(0);

    await expect(run).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "thread-failed",
      code: "CODEX_TURN_FAILED",
      message: "response schema rejected"
    });
  });

  it("times out and terminates the detached process group", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const run = subject.adapter.createSession(request(root, { deadlineMs: 100 }));
    const child = await childAt(subject.children);
    child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-timeout" })}\n`);

    await expect(run).resolves.toEqual({
      kind: "TIMED_OUT",
      sessionId: "thread-timeout"
    });
    expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    child.complete(null, "SIGTERM");
  });

  it("cancels by runId and terminates the same detached process group", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const run = subject.adapter.createSession(request(root));
    const child = await childAt(subject.children);
    child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-cancel" })}\n`);

    await expect(subject.adapter.cancel("review-attempt-1")).resolves.toBe(true);
    await expect(run).resolves.toEqual({
      kind: "CANCELED",
      sessionId: "thread-cancel"
    });
    expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await expect(subject.adapter.cancel("review-attempt-1")).resolves.toBe(false);
    child.complete(null, "SIGTERM");
  });
});
