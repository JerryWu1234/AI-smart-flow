import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LocalIpcClient, LocalIpcServer, ProjectRuntime } from "@smartflow/daemon";
import {
  PlanningSession,
  approveTasksSource,
  executeApprovedTasks,
  type HostGateway
} from "@smartflow/host-skill";
import type {
  ReviewTurnOutput,
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
  public executeCalls = 0;
  private readonly receipts = new Map<string, unknown>();

  public async call(toolName: string, input: unknown): Promise<unknown> {
    const request = input as Record<string, unknown>;
    if (toolName !== "smartflow_execute") this.assertRun(request);
    if (toolName === "smartflow_execute") return this.execute(request);
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
  it("blocks unapproved drift, then handles resume, cancel, and result actions", async () => {
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
      const deadline = Date.now() + 2_000;
      let status: unknown;
      do {
        status = await firstClient.call("smartflow_status", {
          projectId: execute.projectId,
          jobId: execute.jobId
        });
        if ((status as { phase?: string }).phase === "PAUSED") break;
        await new Promise<void>((settle) => setTimeout(settle, 20));
      } while (Date.now() < deadline);
      expect(status).toMatchObject({ phase: "PAUSED" });
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

  it("blocks a composite Review turn when Candidate evidence is missing", async () => {
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
    if (run === undefined) {
      throw new Error("Review integrity fixture is incomplete");
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
      id: "review-turn-with-missing-candidate",
      method: "smartflow_review_turn",
      payload: {
        requestId: "review-turn-with-missing-candidate",
        projectId,
        jobId: "job-1",
        hostTurnId: "host-turn-integrity"
      }
    })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_BLOCKED",
      message: "ARTIFACT_REF_MISSING:candidate"
    });
    expect(await readFile(store.statePath)).toEqual(before);
  });

  it("accepts the current Host Review through the composite turn without running a Daemon reviewer", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "composite-review");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const runtime = new ProjectRuntime({
      dataDirectory,
      publish: (): Promise<void> => Promise.resolve()
    });
    const requested = await runtime.handle({
      id: "current-host-review-request",
      method: "smartflow_review_turn",
      payload: {
        requestId: "current-host-review-request",
        projectId,
        jobId: "job-1",
        hostTurnId: "current-host-reviewer"
      }
    }) as ReviewTurnOutput;
    if (requested.kind !== "REVIEW_REQUIRED") {
      throw new Error("Host Review was not requested");
    }
    const reviewerSessionId = requested.reviewerSession.mode === "RESUME"
      ? requested.reviewerSession.reviewerSessionId
      : "current-host-reviewer-session";

    await expect(runtime.handle({
      id: "incomplete-task-coverage",
      method: "smartflow_review_turn",
      payload: {
        requestId: "incomplete-task-coverage",
        projectId,
        jobId: "job-1",
        hostTurnId: "current-host-reviewer",
        turnToken: requested.turnToken,
        review: {
          reviewerSessionId,
          result: {
            completionPercentage: 100,
            tasks: [{ id: "T999", completionPercentage: 100 }]
          }
        }
      }
    })).rejects.toThrow(/REVIEW_TASK_COVERAGE_INCOMPLETE/u);

    const response = await runtime.handle({
      id: "current-host-review-submission",
      method: "smartflow_review_turn",
      payload: {
        requestId: "current-host-review-submission",
        projectId,
        jobId: "job-1",
        hostTurnId: "current-host-reviewer",
        turnToken: requested.turnToken,
        review: {
          reviewerSessionId,
          result: {
            completionPercentage: 100,
            tasks: [{ id: "T001", completionPercentage: 100 }]
          }
        }
      }
    }) as ReviewTurnOutput;
    expect(response).toMatchObject({
      kind: "NOT_READY",
      phase: "READY_TO_PUBLISH"
    });

    const reviewed = (await store.readState()).runs["job-1"];
    expect(reviewed).toMatchObject({
      phase: "READY_TO_PUBLISH",
      reviewHistory: [{
        reviewAttemptId: requested.reviewAttemptId,
        reviewerSessionId
      }]
    });
    expect(reviewed?.review).toBeDefined();
    expect(reviewed?.leaderDecision).toBeDefined();
    expect(reviewed?.pendingAction).toBeUndefined();
    expect(reviewed?.hostTurn).toBeUndefined();
    if (reviewed?.review === undefined) throw new Error("Review artifact was not persisted");
    const durableReview = JSON.parse(
      new TextDecoder().decode(await store.readArtifact(reviewed.review))
    ) as { gate: { result: { pathCoverage: Record<string, string> } } };
    expect(durableReview.gate.result.pathCoverage).toEqual(
      Object.fromEntries(requested.changedPaths.map((path) => [path, "FULL"]))
    );
  });

  it("pauses the composite Review boundary on approved source drift and replays the owned prompt", async () => {
      const harness = await createRuntimeHarness();
      activeHarnesses.push(harness);
      const tasksSource = createTasksSource();
      const tasksPath = resolve(harness.projectDir, "tasks.md");
      await writeFile(tasksPath, tasksSource, "utf8");
      const dataDirectory = resolve(harness.dataDir, "review-source-drift");
      const projectId = `project-${createHash("sha256")
        .update(harness.projectDir, "utf8")
        .digest("hex")
        .slice(0, 40)}`;
      const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
        dataDirectory: resolve(dataDirectory, "projects", projectId),
        projectId
      });
      const initial = await store.readState();
      const initialRun = initial.runs["job-1"];
      if (initialRun === undefined) throw new Error("review source drift fixture is incomplete");
      await store.writeState({
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
      const requestId = "review-source-drift";
      const payload = {
        requestId,
        projectId,
        jobId: "job-1",
        hostTurnId: "host-turn-source-drift"
      };

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
      const firstPrompt = await runtime.handle({
        id: requestId,
        method: "smartflow_review_turn",
        payload
      }) as ReviewTurnOutput;
      expect(firstPrompt).toMatchObject({
        kind: "USER_INPUT_REQUIRED",
        pause: { code: "APPROVED_SOURCE_DRIFT" }
      });
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
      expect(pausedRun?.pendingAction?.claimId).toBeUndefined();
      expect(pipelineCalls).toBe(0);
      expect(publishCalls).toBe(0);

      const prompt = await runtime.handle({
        id: "review-source-drift-prompt",
        method: "smartflow_review_turn",
        payload: {
          ...payload,
          requestId: "review-source-drift-prompt"
        }
      }) as ReviewTurnOutput;
      expect(prompt).toMatchObject({
        kind: "USER_INPUT_REQUIRED",
        pause: { code: "APPROVED_SOURCE_DRIFT" }
      });
      if (prompt.kind !== "USER_INPUT_REQUIRED") {
        throw new Error("source drift did not require user input");
      }

      await writeFile(tasksPath, tasksSource, "utf8");
      const requested = await runtime.handle({
        id: "restore-review-source",
        method: "smartflow_review_turn",
        payload: {
          ...payload,
          requestId: "restore-review-source",
          turnToken: prompt.turnToken,
          answer: "restore_approved_tasks"
        }
      }) as ReviewTurnOutput;
      expect(requested).toMatchObject({ kind: "REVIEW_REQUIRED", revision: 1 });
      expect(pipelineCalls).toBe(0);
      expect(publishCalls).toBe(0);
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

  it("blocks resume and cancel while a composite Host turn owns the run", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "composite-host-owner");
    const projectId = `project-${createHash("sha256")
      .update(harness.projectDir, "utf8")
      .digest("hex")
      .slice(0, 40)}`;
    const store = await createLifecycleStore(harness, "REVIEW_PENDING", {}, {
      dataDirectory: resolve(dataDirectory, "projects", projectId),
      projectId
    });
    const initial = await store.readState();
    const initialRun = initial.runs["job-1"];
    if (initialRun === undefined) {
      throw new Error("composite owner fixture is missing its Review run");
    }
    const startedAt = new Date().toISOString();
    await store.writeState({
      ...initial,
      stateVersion: initial.stateVersion + 1,
      runs: {
        ...initial.runs,
        "job-1": {
          ...initialRun,
          phase: "PAUSED",
          pause: {
            code: "HOST_REVIEW_UNAVAILABLE",
            resumeActions: ["retry_host_review", "cancel"]
          },
          hostTurn: {
            stage: "AWAITING_USER_INPUT",
            turnToken: "turn-owner",
            hostTurnId: "host-owner",
            revision: 1,
            pauseCode: "HOST_REVIEW_UNAVAILABLE",
            startedAt
          }
        }
      },
      updatedAt: startedAt
    });
    const runtime = new ProjectRuntime({ dataDirectory });
    const paused = await store.readState();
    const pausedBytes = await readFile(store.statePath);

    await expect(runtime.handle({
      id: "primitive-resume-owner-bypass",
      method: "smartflow_resume",
      payload: {
        requestId: "primitive-resume-owner-bypass",
        projectId,
        jobId: "job-1",
        resumeAction: "retry_host_review",
        expectedRevision: 1,
        expectedStateVersion: paused.stateVersion
      }
    })).rejects.toMatchObject({ code: "HOST_TURN_ACTIVE" });
    expect(await readFile(store.statePath)).toEqual(pausedBytes);

    await expect(runtime.handle({
      id: "primitive-cancel-owner-bypass",
      method: "smartflow_cancel",
      payload: {
        requestId: "primitive-cancel-owner-bypass",
        projectId,
        jobId: "job-1",
        reason: "attacker cancellation",
        expectedRevision: 1,
        expectedStateVersion: paused.stateVersion
      }
    })).rejects.toMatchObject({ code: "HOST_TURN_ACTIVE" });
    expect(await readFile(store.statePath)).toEqual(pausedBytes);
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

  it("replays a stored Review decision directly without a Leader phase", async () => {
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
          autoRepairRounds: 15,
          pause: { code: "LEADER_PAUSED", resumeActions: ["resume_review_decision", "cancel"] }
        }
      },
      updatedAt: new Date().toISOString()
    });
    let publishCalls = 0;
    let markPublishStarted!: () => void;
    const publishStarted = new Promise<void>((settle) => {
      markPublishStarted = settle;
    });
    const leaderRuntime = new ProjectRuntime({
      dataDirectory,
      publish: (): Promise<void> => {
        publishCalls += 1;
        markPublishStarted();
        return Promise.resolve();
      }
    });
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
    expect(leaderResult).toMatchObject({ phase: "READY_TO_PUBLISH" });
    expect((await leaderStore.readState()).runs["job-1"]?.autoRepairRounds).toBe(0);
    await publishStarted;
    expect(publishCalls).toBe(1);
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
