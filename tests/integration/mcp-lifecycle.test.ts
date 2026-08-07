import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LocalIpcClient, LocalIpcServer, ProjectRuntime } from "@smartflow/daemon";
import {
  HostActionLoop,
  PlanningSession,
  approveTasksSource,
  executeApprovedTasks,
  type HostGateway,
  type ReviewActionResult
} from "@smartflow/host-skill";
import type {
  HostAction,
  RunPhase
} from "@smartflow/protocol";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createLifecycleStore } from "../crash/recovery-test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

class LifecycleError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class LifecycleGateway implements HostGateway {
  public phase: RunPhase = "PREPARING";
  public revision = 1;
  public stateVersion = 0;
  public pendingAction: HostAction | undefined;
  public executeCalls = 0;
  private readonly receipts = new Map<string, unknown>();
  private claimedActionId: string | undefined;

  public async call(toolName: string, input: unknown): Promise<unknown> {
    const request = input as Record<string, unknown>;
    if (toolName !== "smartflow_execute") this.assertRun(request);
    if (toolName === "smartflow_execute") return this.execute(request);
    if (toolName === "smartflow_status") return this.summary();
    if (toolName === "smartflow_wait") {
      return { changed: true, stateVersion: this.stateVersion, summary: this.summary() };
    }
    if (toolName === "smartflow_claim_action") return this.claim(request);
    if (toolName === "smartflow_submit_review") {
      this.assertMutation(request);
      if (typeof request.hostUnavailableReason === "string") {
        this.phase = "PAUSED";
        this.stateVersion += 1;
        return this.mutationResult();
      }
      if (
        typeof request.reviewAttemptId !== "string" ||
        typeof request.taskSourceHash !== "string" ||
        typeof request.candidateHash !== "string" ||
        typeof request.reviewerSessionId !== "string" ||
        typeof request.result !== "object" ||
        request.result === null
      ) {
        throw new LifecycleError("REVIEW_RESULT_REQUIRED", "Host must submit the current Review result");
      }
      this.phase = "LEADER_DECISION";
      this.pendingAction = undefined;
      this.stateVersion += 1;
      return {
        ...this.mutationResult(),
        reviewHash: "d".repeat(64),
        reviewAttemptId: request.reviewAttemptId,
        reviewerSessionId: request.reviewerSessionId,
        result: request.result
      };
    }
    if (toolName === "smartflow_submit_leader_decision") {
      this.assertMutation(request);
      this.phase = request.decision === "accept" ? "READY_TO_PUBLISH" : "PAUSED";
      this.stateVersion += 1;
      return this.mutationResult();
    }
    if (toolName === "smartflow_resume") {
      this.assertMutation(request);
      this.phase = "RUNNING";
      this.stateVersion += 1;
      return this.mutationResult();
    }
    if (toolName === "smartflow_cancel") {
      this.assertMutation(request);
      this.phase = "CANCELING";
      this.stateVersion += 1;
      return this.mutationResult();
    }
    if (toolName === "smartflow_result") {
      return {
        projectId: "project-1",
        jobId: "job-1",
        phase: this.phase,
        status: this.phase === "PAUSED" ? "PAUSED" : "RUNNING",
        artifacts: [],
        nextActions: this.phase === "PAUSED" ? ["resume"] : []
      };
    }
    throw new LifecycleError("UNKNOWN_TOOL", toolName);
  }

  private async execute(request: Record<string, unknown>): Promise<unknown> {
    const requestId = String(request.requestId);
    const existing = this.receipts.get(requestId);
    if (existing !== undefined) return existing;
    const projectRoot = String(request.projectRoot);
    const tasksPath = String(request.tasksPath);
    const bytes = await readFile(resolve(projectRoot, tasksPath));
    const observedHash = createHash("sha256").update(bytes).digest("hex");
    if (observedHash !== request.approvedSourceHash) {
      throw new LifecycleError("APPROVED_SOURCE_DRIFT", "Daemon observed a different tasks.md");
    }
    this.executeCalls += 1;
    this.stateVersion = 1;
    const response = this.mutationResult();
    this.receipts.set(requestId, response);
    return response;
  }

  private claim(request: Record<string, unknown>): unknown {
    this.assertMutation(request);
    const action = this.pendingAction;
    if (action === undefined || action.actionId !== request.actionId) {
      throw new LifecycleError("ACTION_STALE", "Action is no longer active");
    }
    if (this.claimedActionId === action.actionId) {
      return {
        claimId: `claim:${action.actionId}`,
        action: { ...action, worktreePath: "/tmp/worktree" },
        stateVersion: this.stateVersion,
        expiresAt: "2026-07-20T12:00:00+08:00"
      };
    }
    this.claimedActionId = action.actionId;
    this.stateVersion += 1;
    return {
      claimId: `claim:${action.actionId}`,
      action: { ...action, worktreePath: "/tmp/worktree" },
      stateVersion: this.stateVersion,
      expiresAt: "2026-07-20T12:00:00+08:00"
    };
  }

  private assertRun(request: Record<string, unknown>): void {
    if (request.projectId !== "project-1" || request.jobId !== "job-1") {
      throw new LifecycleError("RUN_SCOPE_MISMATCH", "Request belongs to another run");
    }
  }

  private assertMutation(request: Record<string, unknown>): void {
    this.assertRun(request);
    if (request.expectedRevision !== this.revision) {
      throw new LifecycleError("REVISION_MISMATCH", "Stale revision");
    }
    if (request.expectedStateVersion !== this.stateVersion) {
      throw new LifecycleError("STATE_VERSION_MISMATCH", "Stale stateVersion");
    }
  }

  private mutationResult(): object {
    return {
      projectId: "project-1",
      jobId: "job-1",
      revision: this.revision,
      stateVersion: this.stateVersion,
      phase: this.phase
    };
  }

  private summary(): object {
    return {
      projectId: "project-1",
      jobId: "job-1",
      phase: this.phase,
      revision: this.revision,
      stateVersion: this.stateVersion,
      progress: { completed: 0, total: 1 },
      ...(this.pendingAction === undefined ? {} : { pendingAction: this.pendingAction })
    };
  }
}

const activeHarnesses: RuntimeHarness[] = [];
const activeSocketServers: Server[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(activeSocketServers.splice(0).map((server) => new Promise<void>((settle) => {
    server.close(() => settle());
  })));
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Host planning, approval, and MCP lifecycle", () => {
  it("blocks unapproved drift, then handles review, resume, cancel, and result actions", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksPath = resolve(harness.projectDir, "tasks.md");
    const planner = new PlanningSession();
    planner.revise("# Tasks\n\n- first draft\n");
    const finalDraft = planner.revise("# Tasks\n\n- approved task\n");
    expect(finalDraft.diff.added).toContain("- approved task");
    expect(finalDraft.diff.removed).toContain("- first draft");
    await writeFile(tasksPath, finalDraft.source, "utf8");
    const approval = approveTasksSource("tasks.md", finalDraft.source);
    const gateway = new LifecycleGateway();

    await writeFile(tasksPath, `${finalDraft.source}drift`, "utf8");
    await expect(
      executeApprovedTasks(gateway, harness.projectDir, approval, "execute-1", 0)
    ).rejects.toMatchObject({ code: "APPROVED_SOURCE_DRIFT" });
    expect(gateway.executeCalls).toBe(0);

    await writeFile(tasksPath, finalDraft.source, "utf8");
    const execute = await executeApprovedTasks(
      gateway,
      harness.projectDir,
      approval,
      "execute-1",
      0
    );
    expect(execute).toMatchObject({ phase: "PREPARING", stateVersion: 1 });
    expect(
      await executeApprovedTasks(gateway, harness.projectDir, approval, "execute-1", 0)
    ).toEqual(execute);
    expect(gateway.executeCalls).toBe(1);

    gateway.phase = "PAUSED";
    await gateway.call("smartflow_resume", {
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: gateway.stateVersion,
      requestId: "resume-1",
      resumeAction: "approve_new_manifest_revision"
    });
    expect(gateway.phase).toBe("RUNNING");

    gateway.phase = "REVIEW_PENDING";
    gateway.pendingAction = {
      type: "REVIEW",
      actionId: "action-review",
      revision: 1,
      taskSourceHash: approval.sourceHash,
      candidateHash: "b".repeat(64),
      reviewAttemptId: "review-attempt-1",
      changedPaths: ["sum.js"],
      reviewerSession: { mode: "CREATE" },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T12:00:00+08:00"
    };
    const reviewLoop = new HostActionLoop(gateway, {
      review(context): Promise<ReviewActionResult> {
        expect(context.reviewerSession).toEqual({ mode: "CREATE" });
        expect(context.piSessionId).toBe("pi-session-1");
        return Promise.resolve({
          reviewerSessionId: "reviewer-session-1",
          result: {
            verdict: "APPROVE",
            completionPercentage: 100,
            convergeFindings: [],
            adversarialFindings: [],
            pathCoverage: { "sum.js": "FULL" },
            residualRisks: []
          }
        });
      }
    });
    await reviewLoop.pollOnce({
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: gateway.stateVersion,
      hostTurnId: "turn-2",
      requestId: "action-request-2"
    });
    expect(gateway.phase).toBe("LEADER_DECISION");

    gateway.phase = "REVIEW_PENDING";
    gateway.pendingAction = {
      type: "REVIEW",
      actionId: "action-review-unavailable",
      revision: 1,
      taskSourceHash: approval.sourceHash,
      candidateHash: "c".repeat(64),
      reviewAttemptId: "review-attempt-2",
      changedPaths: ["sum.js"],
      reviewerSession: {
        mode: "RESUME",
        reviewerSessionId: "reviewer-session-1"
      },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T12:00:00+08:00"
    };
    const unavailableLoop = new HostActionLoop(gateway, {});
    await unavailableLoop.pollOnce({
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: gateway.stateVersion,
      hostTurnId: "turn-3",
      requestId: "action-request-3"
    });
    expect(gateway.phase).toBe("PAUSED");
    expect(gateway.pendingAction.actionId).toBe("action-review-unavailable");

    await expect(
      gateway.call("smartflow_cancel", {
        projectId: "other-project",
        jobId: "job-1",
        expectedRevision: 1,
        expectedStateVersion: gateway.stateVersion,
        requestId: "cross-project",
        reason: "stop"
      })
    ).rejects.toMatchObject({ code: "RUN_SCOPE_MISMATCH" });
    await gateway.call("smartflow_cancel", {
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: gateway.stateVersion,
      requestId: "cancel-1",
      reason: "stop"
    });
    expect(await gateway.call("smartflow_result", { projectId: "project-1", jobId: "job-1" })).toMatchObject({
      phase: "CANCELING",
      status: "RUNNING"
    });
  });

  it("uses the real IPC ProjectRuntime, replays execute once, and survives daemon restart", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource();
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const dataDirectory = resolve(harness.dataDir, "d");
    let pipelineCalls = 0;
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: async ({ store, jobId }): Promise<void> => {
        pipelineCalls += 1;
        const state = await store.readState();
        const run = state.runs[jobId];
        if (run === undefined) throw new Error("runtime test run missing");
        const updatedAt = new Date().toISOString();
        await store.writeState({
          ...state,
          stateVersion: state.stateVersion + 1,
          runs: {
            ...state.runs,
            [jobId]: {
              ...run,
              phase: "PAUSED",
              pause: {
                code: "TEST_PIPELINE_PAUSED",
                resumeActions: ["resume", "cancel"]
              },
              updatedAt
            }
          },
          updatedAt
        });
      }
    });
    const firstServer = new LocalIpcServer(dataDirectory, runtime.handle);
    await firstServer.start();
    let firstClient: LocalIpcClient | undefined;
    try {
      firstClient = await LocalIpcClient.connect(firstServer.endpoint);
      const request = {
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: createHash("sha256").update(tasksSource).digest("hex"),
        requestId: "real-execute-1",
        expectedStateVersion: 0
      };
      const execute = await firstClient.call("smartflow_execute", request) as {
        projectId: string;
        jobId: string;
        revision: number;
        stateVersion: number;
        phase: RunPhase;
      };
      expect(execute).toMatchObject({ revision: 1, stateVersion: 1, phase: "PREPARING" });
      expect(await firstClient.call("smartflow_execute", request)).toEqual(execute);
      const waited = await firstClient.call("smartflow_wait", {
        projectId: execute.projectId,
        jobId: execute.jobId,
        afterStateVersion: execute.stateVersion,
        timeoutMs: 2_000
      });
      expect(waited).toMatchObject({ changed: true, summary: { phase: "PAUSED" } });
      expect(pipelineCalls).toBe(1);
      firstClient.close();
      firstClient = undefined;
      await firstServer.close();

      const restartedRuntime = new ProjectRuntime({ dataDirectory });
      const restartedServer = new LocalIpcServer(dataDirectory, restartedRuntime.handle);
      await restartedServer.start();
      try {
        const restartedClient = await LocalIpcClient.connect(restartedServer.endpoint);
        try {
          expect(await restartedClient.call("smartflow_result", {
            projectId: execute.projectId,
            jobId: execute.jobId
          })).toMatchObject({
            projectId: execute.projectId,
            jobId: execute.jobId,
            phase: "PAUSED",
            status: "PAUSED"
          });
        } finally {
          restartedClient.close();
        }
      } finally {
        await restartedServer.close();
      }
    } finally {
      firstClient?.close();
      await firstServer.close().catch(() => undefined);
    }
  });

  it("returns TASK_ALREADY_ACTIVE for a second execute of the same task without changing the active Run", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource();
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    await symlink("tasks.md", resolve(harness.projectDir, "tasks-alias.md"));
    let pipelineCalls = 0;
    let markStarted!: () => void;
    let releasePipeline!: () => void;
    const started = new Promise<void>((settle) => { markStarted = settle; });
    const held = new Promise<void>((settle) => { releasePipeline = settle; });
    const dataDirectory = resolve(harness.rootDir, "active");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: async (): Promise<void> => {
        pipelineCalls += 1;
        markStarted();
        await held;
      }
    });
    const server = new LocalIpcServer(dataDirectory, runtime.handle);
    await server.start();
    const client = await LocalIpcClient.connect(server.endpoint);
    const firstRequest = {
      projectRoot: harness.projectDir,
      tasksPath: "tasks.md",
      approvedSourceHash: createHash("sha256").update(tasksSource).digest("hex"),
      requestId: "active-project-first",
      expectedStateVersion: 0
    };
    try {
      const first = await client.call("smartflow_execute", firstRequest) as {
        projectId: string;
        jobId: string;
      };
      await started;
      const statePath = resolve(dataDirectory, "projects", first.projectId, "state.json");
      const before = await readFile(statePath);
      await expect(client.call("smartflow_execute", {
        ...firstRequest,
        tasksPath: "tasks-alias.md",
        requestId: "active-project-second",
        expectedStateVersion: undefined
      })).rejects.toMatchObject({ code: "TASK_ALREADY_ACTIVE" });
      expect(await readFile(statePath)).toEqual(before);
      expect(await client.call("smartflow_execute", firstRequest)).toEqual(first);
      expect(pipelineCalls).toBe(1);
    } finally {
      releasePipeline();
      client.close();
      await server.close();
    }
  });

  it("runs different task files concurrently and keeps each approved task source frozen", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const firstSource = createTasksSource();
    const secondSource = firstSource.replace("T001", "T101");
    const firstPath = resolve(harness.projectDir, "tasks-a.md");
    const secondPath = resolve(harness.projectDir, "tasks-b.md");
    await writeFile(firstPath, firstSource, "utf8");
    await writeFile(secondPath, secondSource, "utf8");
    let pipelineCalls = 0;
    let markBothStarted!: () => void;
    let releasePipeline!: () => void;
    const bothStarted = new Promise<void>((settle) => { markBothStarted = settle; });
    const held = new Promise<void>((settle) => { releasePipeline = settle; });
    const dataDirectory = resolve(harness.rootDir, "multi-active");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: async (): Promise<void> => {
        pipelineCalls += 1;
        if (pipelineCalls === 2) markBothStarted();
        await held;
      }
    });
    const server = new LocalIpcServer(dataDirectory, runtime.handle);
    await server.start();
    const client = await LocalIpcClient.connect(server.endpoint);
    try {
      const first = await client.call("smartflow_execute", {
        projectRoot: harness.projectDir,
        tasksPath: "tasks-a.md",
        approvedSourceHash: createHash("sha256").update(firstSource).digest("hex"),
        requestId: "multi-active-first",
        expectedStateVersion: 0
      }) as { projectId: string; jobId: string };
      const second = await client.call("smartflow_execute", {
        projectRoot: harness.projectDir,
        tasksPath: "tasks-b.md",
        approvedSourceHash: createHash("sha256").update(secondSource).digest("hex"),
        requestId: "multi-active-second"
      }) as { projectId: string; jobId: string };
      await bothStarted;

      await writeFile(firstPath, "changed after execute", "utf8");
      await rename(firstPath, resolve(harness.projectDir, "tasks-a-renamed.md"));
      await rm(resolve(harness.projectDir, "tasks-a-renamed.md"));

      await expect(client.call("smartflow_status", {
        projectId: first.projectId,
        jobId: first.jobId
      })).resolves.toMatchObject({ phase: "PREPARING" });
      await expect(client.call("smartflow_status", {
        projectId: second.projectId,
        jobId: second.jobId
      })).resolves.toMatchObject({ phase: "PREPARING" });
      const state = JSON.parse(await readFile(
        resolve(dataDirectory, "projects", first.projectId, "state.json"),
        "utf8"
      )) as {
        activeRunsByTaskPath: Record<string, string>;
        runs: Record<string, { taskSource: { relativePath: string } }>;
      };
      expect(Object.keys(state.activeRunsByTaskPath)).toHaveLength(2);
      const frozenRun = state.runs[first.jobId];
      if (frozenRun === undefined) throw new Error("frozen run missing");
      const frozenSourcePath = resolve(
        dataDirectory,
        "projects",
        first.projectId,
        frozenRun.taskSource.relativePath
      );
      expect(await readFile(frozenSourcePath, "utf8")).toBe(firstSource);
    } finally {
      releasePipeline();
      client.close();
      await server.close();
    }
  });

  it("rejects unsafe or non-regular tasksPath inputs before creating Project state", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource();
    const approvedSourceHash = createHash("sha256").update(tasksSource).digest("hex");
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    await mkdir(resolve(harness.projectDir, "task-directory"));
    const outsideTasks = resolve(harness.dataDir, "outside-tasks.md");
    await writeFile(outsideTasks, tasksSource, "utf8");
    await symlink(outsideTasks, resolve(harness.projectDir, "outside-link.md"));

    const socketPath = resolve(harness.projectDir, "tasks.sock");
    const socketServer = createServer();
    activeSocketServers.push(socketServer);
    await new Promise<void>((settle, reject) => {
      socketServer.once("error", reject);
      socketServer.listen(socketPath, () => {
        socketServer.off("error", reject);
        settle();
      });
    });
    if (process.platform !== "win32") {
      await execFileAsync("mkfifo", [resolve(harness.projectDir, "tasks.fifo")]);
      await symlink("/dev/null", resolve(harness.projectDir, "device-link"));
    }

    const dataDirectory = resolve(harness.dataDir, "tasks-path-contract");
    let pipelineCalls = 0;
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => {
        pipelineCalls += 1;
        return Promise.resolve();
      }
    });
    const execute = (tasksPath: string, requestId: string): Promise<unknown> => runtime.handle({
      id: requestId,
      method: "smartflow_execute",
      payload: {
        projectRoot: harness.projectDir,
        tasksPath,
        approvedSourceHash,
        requestId,
        expectedStateVersion: 0
      }
    });

    await expect(execute(resolve(harness.projectDir, "tasks.md"), "absolute-path"))
      .rejects.toMatchObject({ code: "TASKS_PATH_UNSAFE" });
    await expect(execute("nested/../tasks.md", "parent-traversal"))
      .rejects.toMatchObject({ code: "TASKS_PATH_UNSAFE" });
    await expect(execute("outside-link.md", "outside-symlink"))
      .rejects.toMatchObject({ code: "TASKS_PATH_UNSAFE" });
    for (const [tasksPath, requestId] of [
      ["task-directory", "directory-path"],
      ["tasks.sock", "socket-path"],
      ...(process.platform === "win32" ? [] : [["tasks.fifo", "fifo-path"]])
    ] as const) {
      await expect(execute(tasksPath, requestId))
        .rejects.toMatchObject({ code: "TASKS_PATH_NOT_REGULAR" });
    }
    if (process.platform !== "win32") {
      await expect(execute("device-link", "device-path"))
        .rejects.toMatchObject({ code: "TASKS_PATH_UNSAFE" });
    }
    expect(pipelineCalls).toBe(0);
    await expect(access(dataDirectory)).rejects.toBeDefined();

    await expect(execute("tasks.md", "valid-relative-path"))
      .resolves.toMatchObject({ phase: "PREPARING", revision: 1 });
  });

  it("applies the same tasksPath guard before a new Revision resume mutation", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    await mkdir(resolve(harness.projectDir, "revision-directory"));
    const dataDirectory = resolve(harness.dataDir, "revision-tasks-path");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "PAUSED", {
      pause: {
        code: "POLICY_CHANGE_REQUIRED",
        resumeActions: ["approve_new_manifest_revision", "cancel"]
      }
    }, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const initialState = await store.readState();
    const state = await store.writeState({
      ...initialState,
      canonicalProjectRoot: await realpath(harness.projectDir),
      stateVersion: initialState.stateVersion + 1,
      updatedAt: new Date().toISOString()
    });
    const runtime = new ProjectRuntime({ dataDirectory });
    const resume = (tasksPath: string, requestId: string): Promise<unknown> => runtime.handle({
      id: requestId,
      method: "smartflow_resume",
      payload: {
        requestId,
        projectId,
        jobId: "job-1",
        resumeAction: "approve_new_manifest_revision",
        tasksPath,
        approvedSourceHash: "0".repeat(64),
        approval: { kind: "USER", parentRevision: null, authorizedCriterionIds: [] },
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion
      }
    });
    const before = await readFile(store.statePath);
    await expect(resume(resolve(harness.projectDir, "sum.js"), "revision-absolute"))
      .rejects.toMatchObject({ code: "TASKS_PATH_UNSAFE" });
    expect(await readFile(store.statePath)).toEqual(before);
    await expect(resume("revision-directory", "revision-directory"))
      .rejects.toMatchObject({ code: "TASKS_PATH_NOT_REGULAR" });
    expect(await readFile(store.statePath)).toEqual(before);
  });

  it("keeps CANCELING byte-identical when a late pipeline failure arrives", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksSource = createTasksSource();
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    let pipelineStarted!: () => void;
    let rejectPipeline!: (error: Error) => void;
    const started = new Promise<void>((settle) => { pipelineStarted = settle; });
    const blockedPipeline = new Promise<void>((_settle, reject) => { rejectPipeline = reject; });
    const dataDirectory = resolve(harness.dataDir, "late-failure");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: async (): Promise<void> => {
        pipelineStarted();
        await blockedPipeline;
      },
      cancel: (): Promise<void> => Promise.resolve()
    });
    const execute = await runtime.handle({
      id: "ipc-execute-late-failure",
      method: "smartflow_execute",
      payload: {
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: createHash("sha256").update(tasksSource).digest("hex"),
        requestId: "execute-late-failure",
        expectedStateVersion: 0
      }
    }) as { projectId: string; jobId: string; revision: number; stateVersion: number };
    await started;
    await runtime.handle({
      id: "ipc-cancel-late-failure",
      method: "smartflow_cancel",
      payload: {
        projectId: execute.projectId,
        jobId: execute.jobId,
        expectedRevision: execute.revision,
        expectedStateVersion: execute.stateVersion,
        requestId: "cancel-before-late-failure",
        reason: "race test"
      }
    });
    const statePath = resolve(dataDirectory, "projects", execute.projectId, "state.json");
    const before = await readFile(statePath);
    rejectPipeline(new Error("late pipeline failure"));
    await new Promise((settle) => setTimeout(settle, 25));
    expect(await readFile(statePath)).toEqual(before);
    expect(await runtime.handle({
      id: "ipc-status-late-failure",
      method: "smartflow_status",
      payload: { projectId: execute.projectId, jobId: execute.jobId }
    })).toMatchObject({ phase: "CANCELING" });
  });

  it("blocks a direct claim inside the mutation lock when Candidate evidence is missing", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "claim-integrity");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    const actionId = run?.pendingAction?.actionId;
    if (run === undefined || typeof actionId !== "string") {
      throw new Error("claim integrity fixture is incomplete");
    }
    const corrupted = { ...run };
    delete corrupted.candidate;
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: { ...state.runs, "job-1": corrupted },
      updatedAt: new Date().toISOString()
    });
    const before = await readFile(store.statePath);
    const runtime = new ProjectRuntime({ dataDirectory });

    await expect(runtime.handle({
      id: "claim-with-missing-candidate",
      method: "smartflow_claim_action",
      payload: {
        requestId: "claim-with-missing-candidate",
        projectId,
        jobId: "job-1",
        actionId,
        hostTurnId: "host-turn-integrity",
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion + 1
      }
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_BLOCKED",
      message: "ARTIFACT_REF_MISSING:candidate"
    });
    expect(await readFile(store.statePath)).toEqual(before);
  });

  it("accepts the current Host Review result without running a Daemon reviewer", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "forged-review");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "REVIEWING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    const action = run?.pendingAction as
      | (Extract<HostAction, { type: "REVIEW" }> & { claimId?: string })
      | undefined;
    if (
      run === undefined ||
      action?.type !== "REVIEW" ||
      typeof action.claimId !== "string"
    ) {
      throw new Error("Host Review fixture is incomplete");
    }
    const reviewerSessionId = action.reviewerSession.mode === "RESUME"
      ? action.reviewerSession.reviewerSessionId
      : "current-host-reviewer-session";
    const result = {
      completionPercentage: 100,
      tasks: [{ id: "T001", completionPercentage: 100 }]
    };
    const runtime = new ProjectRuntime({ dataDirectory });
    await expect(runtime.handle({
      id: "incomplete-task-coverage",
      method: "smartflow_submit_review",
      payload: {
        requestId: "incomplete-task-coverage",
        projectId,
        jobId: "job-1",
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion,
        claimId: action.claimId,
        reviewAttemptId: action.reviewAttemptId,
        taskSourceHash: action.taskSourceHash,
        candidateHash: action.candidateHash,
        reviewerSessionId,
        result: {
          completionPercentage: 100,
          tasks: [{ id: "T999", completionPercentage: 100 }]
        }
      }
    })).rejects.toThrow(/REVIEW_TASK_COVERAGE_INCOMPLETE/u);
    const response = await runtime.handle({
      id: "current-host-review-submission",
      method: "smartflow_submit_review",
      payload: {
        requestId: "current-host-review-submission",
        projectId,
        jobId: "job-1",
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion,
        claimId: action.claimId,
        reviewAttemptId: action.reviewAttemptId,
        taskSourceHash: action.taskSourceHash,
        candidateHash: action.candidateHash,
        reviewerSessionId,
        result
      }
    });
    expect(response).toMatchObject({
      phase: "LEADER_DECISION",
      reviewAttemptId: action.reviewAttemptId,
      reviewerSessionId,
      result: {
        verdict: "APPROVE",
        completionPercentage: 100,
        convergeFindings: [],
        adversarialFindings: [],
        pathCoverage: Object.fromEntries(action.changedPaths.map((path) => [path, "FULL"])),
        residualRisks: []
      }
    });
    const reviewed = (await store.readState()).runs["job-1"];
    expect(reviewed).toMatchObject({
      phase: "LEADER_DECISION",
      reviewHistory: [{
        reviewAttemptId: action.reviewAttemptId,
        reviewerSessionId
      }]
    });
    expect(reviewed?.review).toBeDefined();
    expect(reviewed?.pendingAction).toBeUndefined();
  });

  it("pauses each Review acceptance boundary on approved source drift and rejects the old action epoch", async () => {
    for (const phase of ["REVIEW_PENDING", "REVIEWING", "LEADER_DECISION"] as const) {
      const harness = await createRuntimeHarness();
      activeHarnesses.push(harness);
      const tasksSource = createTasksSource();
      const tasksPath = resolve(harness.projectDir, "tasks.md");
      await writeFile(tasksPath, tasksSource, "utf8");
      const dataDirectory = resolve(harness.dataDir, `review-source-drift-${phase.toLowerCase()}`);
      const projectId = `project-${createHash("sha256")
        .update(harness.projectDir, "utf8")
        .digest("hex")
        .slice(0, 40)}`;
      const store = await createLifecycleStore(harness, phase, {}, {
        dataDirectory: resolve(dataDirectory, "projects", projectId),
        projectId
      });
      const initial = await store.readState();
      const initialRun = initial.runs["job-1"];
      if (initialRun === undefined) throw new Error("review source drift fixture is incomplete");
      const prepared = await store.writeState({
        ...initial,
        stateVersion: initial.stateVersion + 1,
        runs: {
          ...initial.runs,
          "job-1": {
            ...initialRun,
            approvedTasks: {
              path: tasksPath,
              sourceHash: createHash("sha256").update(tasksSource).digest("hex")
            }
          }
        },
        updatedAt: new Date().toISOString()
      });
      const run = prepared.runs["job-1"];
      if (run === undefined) throw new Error("prepared Review Run is missing");
      const requestId = `review-source-drift-${phase.toLowerCase()}`;
      let method: string;
      let payload: Record<string, unknown>;
      if (phase === "REVIEW_PENDING") {
        method = "smartflow_claim_action";
        payload = {
          requestId,
          projectId,
          jobId: "job-1",
          actionId: run.pendingAction?.actionId,
          hostTurnId: "host-turn-source-drift",
          expectedRevision: 1,
          expectedStateVersion: prepared.stateVersion
        };
      } else if (phase === "REVIEWING") {
        const action = run.pendingAction as
          | (Extract<HostAction, { type: "REVIEW" }> & { claimId?: string })
          | undefined;
        if (action?.type !== "REVIEW" || typeof action.claimId !== "string") {
          throw new Error("Reviewing source drift action is missing");
        }
        method = "smartflow_submit_review";
        payload = {
          requestId,
          projectId,
          jobId: "job-1",
          claimId: action.claimId,
          reviewAttemptId: action.reviewAttemptId,
          taskSourceHash: action.taskSourceHash,
          candidateHash: action.candidateHash,
          reviewerSessionId: action.reviewerSession.mode === "RESUME"
            ? action.reviewerSession.reviewerSessionId
            : "source-drift-reviewer-session",
          result: {
            verdict: "APPROVE",
            completionPercentage: 100,
            convergeFindings: [],
            adversarialFindings: [],
            pathCoverage: Object.fromEntries(
              action.changedPaths.map((path) => [path, "FULL"])
            ),
            residualRisks: []
          },
          expectedRevision: 1,
          expectedStateVersion: prepared.stateVersion
        };
      } else {
        const reviewRef = run.review;
        if (reviewRef === undefined) throw new Error("Leader Review artifact is missing");
        const review = JSON.parse(new TextDecoder().decode(await store.readArtifact(reviewRef))) as {
          reviewHash: string;
        };
        method = "smartflow_submit_leader_decision";
        payload = {
          requestId,
          projectId,
          jobId: "job-1",
          reviewHash: review.reviewHash,
          decision: "accept",
          reason: "source drift boundary test",
          expectedRevision: 1,
          expectedStateVersion: prepared.stateVersion
        };
      }

      let pipelineCalls = 0;
      let publishCalls = 0;
      const runtime = new ProjectRuntime({
        dataDirectory,
        runPipeline: (): Promise<void> => {
          pipelineCalls += 1;
          return Promise.resolve();
        },
        publish: (): Promise<void> => {
          publishCalls += 1;
          return Promise.resolve();
        }
      });
      await writeFile(tasksPath, `${tasksSource}\nsource drift`, "utf8");
      await expect(runtime.handle({ id: requestId, method, payload }))
        .rejects.toMatchObject({ code: "APPROVED_SOURCE_DRIFT" });
      const paused = await store.readState();
      const pausedRun = paused.runs["job-1"];
      expect(pausedRun).toMatchObject({
        phase: "PAUSED",
        pause: {
          code: "APPROVED_SOURCE_DRIFT",
          resumeActions: ["approve_new_manifest_revision", "restore_approved_tasks", "cancel"]
        }
      });
      expect(pausedRun?.leaderDecision).toBeUndefined();
      if (phase !== "LEADER_DECISION") {
        expect(pausedRun?.pendingAction?.claimId).toBeUndefined();
      }
      expect(pipelineCalls).toBe(0);
      expect(publishCalls).toBe(0);

      await writeFile(tasksPath, tasksSource, "utf8");
      const resumed = await runtime.handle({
        id: `restore-source-${phase.toLowerCase()}`,
        method: "smartflow_resume",
        payload: {
          requestId: `restore-source-${phase.toLowerCase()}`,
          projectId,
          jobId: "job-1",
          resumeAction: "restore_approved_tasks",
          expectedRevision: 1,
          expectedStateVersion: paused.stateVersion
        }
      });
      expect(resumed).toMatchObject({
        phase: phase === "LEADER_DECISION" ? "LEADER_DECISION" : "REVIEW_PENDING"
      });
      const latePayload = phase === "LEADER_DECISION"
        ? payload
        : {
            ...payload,
            requestId: `${requestId}-late`,
            expectedStateVersion: paused.stateVersion + 1
          };
      await expect(runtime.handle({ id: `${requestId}-late`, method, payload: latePayload }))
        .rejects.toBeDefined();
      expect(pipelineCalls).toBe(0);
      expect(publishCalls).toBe(0);
    }
  });

  it("blocks retry_publish before state mutation or publish scheduling when Candidate evidence is missing", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "resume-integrity");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "PUBLISHING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run === undefined) throw new Error("resume integrity fixture is incomplete");
    const corrupted = {
      ...run,
      phase: "PAUSED" as const,
      pause: {
        code: "PUBLISH_ADAPTER_UNAVAILABLE",
        resumeActions: ["retry_publish", "export_bundle", "cancel"]
      }
    };
    delete corrupted.candidate;
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: { ...state.runs, "job-1": corrupted },
      updatedAt: new Date().toISOString()
    });
    const before = await readFile(store.statePath);
    let publishCalls = 0;
    const runtime = new ProjectRuntime({
      dataDirectory,
      publish: (): Promise<void> => {
        publishCalls += 1;
        return Promise.resolve();
      }
    });

    await expect(runtime.handle({
      id: "retry-publish-with-missing-candidate",
      method: "smartflow_resume",
      payload: {
        requestId: "retry-publish-with-missing-candidate",
        projectId,
        jobId: "job-1",
        resumeAction: "retry_publish",
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion + 1
      }
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_BLOCKED",
      message: "ARTIFACT_REF_MISSING:candidate"
    });
    expect(await readFile(store.statePath)).toEqual(before);
    expect(publishCalls).toBe(0);
  });

  it("blocks retry_host_review inside the mutation lock when Candidate evidence is missing", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "review-resume-integrity");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run === undefined) throw new Error("review resume integrity fixture is incomplete");
    const corrupted = {
      ...run,
      phase: "PAUSED" as const,
      pause: {
        code: "HOST_REVIEW_UNAVAILABLE",
        resumeActions: ["retry_host_review", "cancel"]
      }
    };
    delete corrupted.candidate;
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: { ...state.runs, "job-1": corrupted },
      updatedAt: new Date().toISOString()
    });
    const before = await readFile(store.statePath);
    const runtime = new ProjectRuntime({ dataDirectory });

    await expect(runtime.handle({
      id: "retry-host-review-with-missing-candidate",
      method: "smartflow_resume",
      payload: {
        requestId: "retry-host-review-with-missing-candidate",
        projectId,
        jobId: "job-1",
        resumeAction: "retry_host_review",
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion + 1
      }
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_BLOCKED",
      message: "ARTIFACT_REF_MISSING:candidate"
    });
    expect(await readFile(store.statePath)).toEqual(before);
  });

  it("keeps informational and illegal pause actions byte-identical", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "closed-resume-readonly");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "RUNNING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run === undefined) throw new Error("closed resume fixture missing");
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        "job-1": {
          ...run,
          phase: "PAUSED",
          pause: {
            code: "PAUSED_PROCESS_RECONCILIATION",
            resumeActions: ["inspect_processes", "resume_review_decision", "cancel"]
          }
        }
      },
      updatedAt: new Date().toISOString()
    });
    const runtime = new ProjectRuntime({ dataDirectory });
    const paused = await store.readState();
    const beforeReadOnly = await readFile(store.statePath);
    await expect(runtime.handle({
      id: "inspect-processes-is-readonly",
      method: "smartflow_resume",
      payload: {
        requestId: "inspect-processes-is-readonly",
        projectId,
        jobId: "job-1",
        resumeAction: "inspect_processes",
        expectedRevision: 1,
        expectedStateVersion: paused.stateVersion
      }
    })).rejects.toMatchObject({ code: "RESUME_ACTION_READ_ONLY" });
    expect(await readFile(store.statePath)).toEqual(beforeReadOnly);

    await expect(runtime.handle({
      id: "illegal-code-action-pair",
      method: "smartflow_resume",
      payload: {
        requestId: "illegal-code-action-pair",
        projectId,
        jobId: "job-1",
        resumeAction: "resume_review_decision",
        expectedRevision: 1,
        expectedStateVersion: paused.stateVersion
      }
    })).rejects.toMatchObject({ code: "RESUME_CODE_ACTION_MISMATCH" });
    expect(await readFile(store.statePath)).toEqual(beforeReadOnly);
  });

  it("routes explicit provider retry through a new pipeline and cancel through cancellation", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "closed-provider-resume");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "RUNNING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run === undefined) throw new Error("provider resume fixture missing");
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        "job-1": {
          ...run,
          phase: "PAUSED",
          pause: {
            code: "PAUSED_PROCESS_RECONCILIATION",
            resumeActions: ["inspect_processes", "retry_provider", "cancel"]
          }
        }
      },
      updatedAt: new Date().toISOString()
    });
    let pipelineCalls = 0;
    let recoveryCalls = 0;
    let cancelCalls = 0;
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => {
        pipelineCalls += 1;
        return Promise.resolve();
      },
      recover: (): Promise<void> => {
        recoveryCalls += 1;
        return Promise.resolve();
      },
      cancel: (): Promise<void> => {
        cancelCalls += 1;
        return Promise.resolve();
      }
    });
    const paused = await store.readState();
    const retry = await runtime.handle({
      id: "retry-provider-through-recovery",
      method: "smartflow_resume",
      payload: {
        requestId: "retry-provider-through-recovery",
        projectId,
        jobId: "job-1",
        resumeAction: "retry_provider",
        expectedRevision: 1,
        expectedStateVersion: paused.stateVersion
      }
    });
    expect(retry).toMatchObject({ phase: "PREPARING" });
    expect({ pipelineCalls, recoveryCalls, cancelCalls }).toEqual({
      pipelineCalls: 1,
      recoveryCalls: 0,
      cancelCalls: 0
    });

    const running = await store.readState();
    const runningRun = running.runs["job-1"];
    if (runningRun === undefined) throw new Error("provider retry run missing");
    await store.writeState({
      ...running,
      stateVersion: running.stateVersion + 1,
      runs: {
        ...running.runs,
        "job-1": {
          ...runningRun,
          phase: "PAUSED",
          pause: { code: "PROVIDER_ERROR", resumeActions: ["cancel"] }
        }
      },
      updatedAt: new Date().toISOString()
    });
    const cancelState = await store.readState();
    const canceled = await runtime.handle({
      id: "cancel-through-cancel-chain",
      method: "smartflow_resume",
      payload: {
        requestId: "cancel-through-cancel-chain",
        projectId,
        jobId: "job-1",
        resumeAction: "cancel",
        expectedRevision: 1,
        expectedStateVersion: cancelState.stateVersion
      }
    });
    expect(canceled).toMatchObject({ phase: "CANCELING" });
    expect((await store.readState()).runs["job-1"]?.workerAttempts.at(-1)?.status).toBe("RUNNING");
    expect({ pipelineCalls, recoveryCalls, cancelCalls }).toEqual({
      pipelineCalls: 1,
      recoveryCalls: 0,
      cancelCalls: 1
    });
  });

  it("routes a Leader pause back to the bound decision phase", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "closed-leader-resume");
    const leaderProjectId = `project-${createHash("sha256")
      .update(`${harness.projectDir}:leader`, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const leaderStore = await createLifecycleStore(harness, "READY_TO_PUBLISH", {}, {
      dataDirectory: resolve(dataDirectory, "projects", leaderProjectId),
      projectId: leaderProjectId
    });
    const leaderState = await leaderStore.readState();
    const leaderRun = leaderState.runs["job-1"];
    if (leaderRun === undefined) throw new Error("leader resume fixture missing");
    await leaderStore.writeState({
      ...leaderState,
      stateVersion: leaderState.stateVersion + 1,
      runs: {
        ...leaderState.runs,
        "job-1": {
          ...leaderRun,
          phase: "PAUSED",
          pause: { code: "LEADER_PAUSED", resumeActions: ["resume_review_decision", "cancel"] }
        }
      },
      updatedAt: new Date().toISOString()
    });
    const leaderRuntime = new ProjectRuntime({ dataDirectory });
    const leaderPaused = await leaderStore.readState();
    const leaderResult = await leaderRuntime.handle({
      id: "resume-leader-decision",
      method: "smartflow_resume",
      payload: {
        requestId: "resume-leader-decision",
        projectId: leaderProjectId,
        jobId: "job-1",
        resumeAction: "resume_review_decision",
        expectedRevision: 1,
        expectedStateVersion: leaderPaused.stateVersion
      }
    });
    expect(leaderResult).toMatchObject({ phase: "LEADER_DECISION" });
  });

  it("rejects retry_cancel combined with Revision approval fields", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "cancel-resume-payload");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "PUBLISHING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const state = await store.readState();
    const run = state.runs["job-1"];
    if (run === undefined) throw new Error("cancel resume fixture is incomplete");
    await store.writeState({
      ...state,
      stateVersion: state.stateVersion + 1,
      runs: {
        ...state.runs,
        "job-1": {
          ...run,
          phase: "PAUSED",
          pause: { code: "CANCEL_RETRY_REQUIRED", resumeActions: ["retry_cancel"] }
        }
      },
      updatedAt: new Date().toISOString()
    });
    const before = await readFile(store.statePath);
    const runtime = new ProjectRuntime({ dataDirectory });

    await expect(runtime.handle({
      id: "retry-cancel-with-revision-payload",
      method: "smartflow_resume",
      payload: {
        requestId: "retry-cancel-with-revision-payload",
        projectId,
        jobId: "job-1",
        resumeAction: "retry_cancel",
        tasksPath: "tasks.md",
        approvedSourceHash: "0".repeat(64),
        approval: { kind: "USER", parentRevision: null, authorizedCriterionIds: [] },
        expectedRevision: 1,
        expectedStateVersion: state.stateVersion + 1
      }
    })).rejects.toMatchObject({ code: "RESUME_ACTION_PAYLOAD_MISMATCH" });
    expect(await readFile(store.statePath)).toEqual(before);
  });
});
