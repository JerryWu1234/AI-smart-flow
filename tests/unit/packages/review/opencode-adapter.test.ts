import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenCodeAdapter,
  type AgentRunRequest
} from "@smartflow/review";

type OpenCodeAdapterOptions = NonNullable<
  ConstructorParameters<typeof OpenCodeAdapter>[0]
>;
type OpenCodeKill = NonNullable<OpenCodeAdapterOptions["kill"]>;

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
  readonly adapter: OpenCodeAdapter;
  readonly children: FakeChildProcess[];
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn<OpenCodeKill>>;
}

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "smartflow-opencode-adapter-"));
  directories.push(directory);
  return directory;
}

async function request(
  root: string,
  overrides: Partial<AgentRunRequest> = {}
): Promise<AgentRunRequest> {
  const candidate = resolve(root, "candidate");
  const reviews = resolve(root, "data", "runs", "job-1", "reviews");
  await Promise.all([
    mkdir(candidate, { recursive: true }),
    mkdir(reviews, { recursive: true })
  ]);
  const value: AgentRunRequest = {
    runId: "review-attempt-1",
    cwd: candidate,
    prompt: "Review the approved tasks.",
    outputSchemaPath: resolve(reviews, "review.schema.json"),
    outputPath: resolve(reviews, "review.output.json"),
    deadlineMs: 5_000,
    model: "mock/review",
    ...overrides
  };
  await writeFile(value.outputSchemaPath, JSON.stringify({
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
    const child = new FakeChildProcess(6_000 + children.length);
    children.push(child);
    return child.asChildProcess();
  });
  const kill = vi.fn<OpenCodeKill>(() => true);
  const adapter = new OpenCodeAdapter({
    executable: "/fake/opencode",
    spawn,
    kill,
    forceKillAfterMs: options.forceKillAfterMs ?? 1_000
  });
  return { adapter, children, spawn, kill };
}

async function childAt(children: FakeChildProcess[], index = 0): Promise<FakeChildProcess> {
  await vi.waitFor(() => {
    expect(children.length).toBeGreaterThan(index);
  });
  const child = children[index];
  if (child === undefined) throw new Error("fake child was not spawned");
  return child;
}

function emitStepStart(child: FakeChildProcess, sessionID: string): void {
  child.stdout.write(`${JSON.stringify({
    type: "step_start",
    sessionID,
    part: { type: "step-start" }
  })}\n`);
}

function emitSuccess(
  child: FakeChildProcess,
  sessionID: string,
  text = JSON.stringify({ tasks: [] })
): void {
  emitStepStart(child, sessionID);
  child.stdout.write(`${JSON.stringify({
    type: "text",
    sessionID,
    part: { type: "text", text }
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "step_finish",
    sessionID,
    part: { type: "step-finish", reason: "stop" }
  })}\n`);
}

function spawnedArgv(subject: Harness, index = 0): string[] {
  const argv = subject.spawn.mock.calls[index]?.[1] as readonly string[] | undefined;
  if (argv === undefined) throw new Error("OpenCode was not spawned");
  return [...argv];
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("OpenCodeAdapter", () => {
  it("runs CREATE from an isolated Reviewer root with a read-only config", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root, { effort: "high" });
    await writeFile(runRequest.outputPath, JSON.stringify({ stale: true }), "utf8");

    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    child.stderr.write("non-fatal diagnostic\n");
    emitSuccess(child, "ses_create");
    child.complete(0);

    await expect(run).resolves.toEqual({
      kind: "COMPLETED",
      sessionId: "ses_create",
      finalResponse: { tasks: [] }
    });
    expect(JSON.parse(await readFile(runRequest.outputPath, "utf8"))).toEqual({ tasks: [] });

    const reviewerRoot = resolve(dirname(runRequest.outputPath), ".opencode-reviewer");
    const argv = spawnedArgv(subject);
    expect(argv.slice(0, 2)).toEqual(["--pure", "run"]);
    expect(argv).toContain("json");
    expect(argv.slice(argv.indexOf("--dir"), argv.indexOf("--dir") + 2))
      .toEqual(["--dir", reviewerRoot]);
    expect(argv.slice(argv.indexOf("--agent"), argv.indexOf("--agent") + 2))
      .toEqual(["--agent", "smartflow-reviewer"]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2))
      .toEqual(["--model", "mock/review"]);
    expect(argv.slice(argv.indexOf("--variant"), argv.indexOf("--variant") + 2))
      .toEqual(["--variant", "high"]);
    expect(argv).not.toContain("--session");
    expect(argv).not.toContain("--continue");
    expect(argv).not.toContain("--attach");
    expect(argv.at(-1)).toContain(runRequest.prompt);
    expect(argv.at(-1)).toContain(runRequest.cwd);
    expect(argv.at(-1)).toContain("\"required\":[\"tasks\"]");

    const spawnOptions = subject.spawn.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(spawnOptions).toMatchObject({
      cwd: reviewerRoot,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const environment = spawnOptions?.env;
    expect(environment?.XDG_CONFIG_HOME).toBe(resolve(reviewerRoot, "xdg-config"));
    expect(environment?.OPENCODE_CONFIG).toBeUndefined();
    expect(environment?.OPENCODE_CONFIG_DIR).toBeUndefined();
    const config = JSON.parse(environment?.OPENCODE_CONFIG_CONTENT ?? "null") as {
      tools?: unknown;
      permission?: Record<string, unknown>;
      mcp?: unknown;
      plugin?: unknown;
      agent?: Record<string, { tools?: unknown; permission?: unknown }>;
    };
    const allowedTools = { "*": false, read: true, glob: true, grep: true };
    expect(config.tools).toEqual(allowedTools);
    expect(config.mcp).toEqual({});
    expect(config.plugin).toEqual([]);
    expect(config.permission).toMatchObject({
      "*": "deny",
      bash: "deny",
      edit: "deny",
      write: "deny",
      task: "deny",
      webfetch: "deny",
      skill: "deny",
      external_directory: {
        "*": "deny",
        [runRequest.cwd]: "allow",
        [`${runRequest.cwd}/**`]: "allow"
      }
    });
    expect(config.agent?.["smartflow-reviewer"]).toMatchObject({
      tools: allowedTools,
      permission: config.permission
    });
    expect(await readFile(resolve(reviewerRoot, ".git", "HEAD"), "utf8"))
      .toBe("ref: refs/heads/smartflow-reviewer\n");
  });

  it("resumes only the exact session and rejects a changed event session", async () => {
    const root = await temporaryDirectory();
    const acceptedSubject = harness();
    const acceptedRequest = await request(root, { runId: "review-resume" });
    const accepted = acceptedSubject.adapter.resume("ses_resume", acceptedRequest);
    const acceptedChild = await childAt(acceptedSubject.children);
    emitSuccess(acceptedChild, "ses_resume");
    acceptedChild.complete(0);

    await expect(accepted).resolves.toMatchObject({
      kind: "COMPLETED",
      sessionId: "ses_resume"
    });
    const argv = spawnedArgv(acceptedSubject);
    expect(argv.slice(argv.indexOf("--session"), argv.indexOf("--session") + 2))
      .toEqual(["--session", "ses_resume"]);

    const changedSubject = harness();
    const changedRequest = await request(root, {
      runId: "review-mismatch",
      outputPath: resolve(root, "data", "runs", "job-1", "reviews", "mismatch.json")
    });
    const changed = changedSubject.adapter.resume("ses_expected", changedRequest);
    const changedChild = await childAt(changedSubject.children);
    emitSuccess(changedChild, "ses_other");
    changedChild.complete(0);
    await expect(changed).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "ses_expected",
      code: "OPENCODE_SESSION_MISMATCH"
    });
  });

  it("requires an explicit model and strict JSON output", async () => {
    const root = await temporaryDirectory();
    const missingModelSubject = harness();
    const missingModelRequest = await request(root);
    Reflect.deleteProperty(missingModelRequest, "model");
    await expect(missingModelSubject.adapter.createSession(
      missingModelRequest
    )).resolves.toMatchObject({
      kind: "FAILED",
      code: "OPENCODE_REQUEST_INVALID"
    });
    expect(missingModelSubject.spawn).not.toHaveBeenCalled();

    const invalidSubject = harness();
    const invalidRequest = await request(root, {
      runId: "review-invalid-json",
      outputPath: resolve(root, "data", "runs", "job-1", "reviews", "invalid.json")
    });
    const invalid = invalidSubject.adapter.createSession(invalidRequest);
    const invalidChild = await childAt(invalidSubject.children);
    emitSuccess(invalidChild, "ses_invalid", "```json\n{\"tasks\":[]}\n```");
    invalidChild.complete(0);
    await expect(invalid).resolves.toMatchObject({
      kind: "FAILED",
      sessionId: "ses_invalid",
      code: "OPENCODE_OUTPUT_INVALID"
    });
  });

  it("reports process startup and OpenCode error events", async () => {
    const root = await temporaryDirectory();
    const startupSubject = harness({ spawnError: new Error("spawn ENOENT") });
    await expect(startupSubject.adapter.createSession(await request(root))).resolves.toEqual({
      kind: "FAILED",
      code: "OPENCODE_PROCESS_FAILED",
      message: "Unable to start OpenCode: spawn ENOENT"
    });

    const errorSubject = harness();
    const errorRequest = await request(root, {
      runId: "review-error",
      outputPath: resolve(root, "data", "runs", "job-1", "reviews", "error.json")
    });
    const run = errorSubject.adapter.createSession(errorRequest);
    const child = await childAt(errorSubject.children);
    child.stdout.write(`${JSON.stringify({
      type: "error",
      sessionID: "ses_error",
      error: { data: { message: "provider unavailable" } }
    })}\n`);
    child.complete(0);
    await expect(run).resolves.toEqual({
      kind: "FAILED",
      sessionId: "ses_error",
      code: "OPENCODE_ERROR",
      message: "provider unavailable"
    });
  });

  it("retains run ownership until a canceled child closes", async () => {
    const root = await temporaryDirectory();
    const subject = harness();
    const runRequest = await request(root);
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    emitStepStart(child, "ses_cancel");
    let runSettled = false;
    void run.then(() => {
      runSettled = true;
    });

    const cancellation = subject.adapter.cancel(runRequest.runId);
    expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await expect(subject.adapter.createSession(runRequest)).resolves.toMatchObject({
      kind: "FAILED",
      code: "OPENCODE_RUN_ACTIVE"
    });
    await Promise.resolve();
    expect(runSettled).toBe(false);

    child.complete(null, "SIGTERM");
    await expect(cancellation).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED", sessionId: "ses_cancel" });
  });

  it("escalates cancellation to SIGKILL but still waits for close", async () => {
    const root = await temporaryDirectory();
    const subject = harness({ forceKillAfterMs: 10 });
    const runRequest = await request(root, { runId: "review-force-kill" });
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);

    const cancellation = subject.adapter.cancel(runRequest.runId);
    await vi.waitFor(() => {
      expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    });
    child.complete(null, "SIGKILL");
    await expect(cancellation).resolves.toBe(true);
    await expect(run).resolves.toEqual({ kind: "CANCELED" });
  });

  it("times out without releasing ownership before close", async () => {
    const root = await temporaryDirectory();
    const subject = harness({ forceKillAfterMs: -1 });
    const runRequest = await request(root, { runId: "review-timeout", deadlineMs: 50 });
    const run = subject.adapter.createSession(runRequest);
    const child = await childAt(subject.children);
    emitStepStart(child, "ses_timeout");
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(subject.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    });
    expect(settled).toBe(false);
    child.complete(null, "SIGTERM");
    await expect(run).resolves.toEqual({ kind: "TIMED_OUT", sessionId: "ses_timeout" });
  });
});
