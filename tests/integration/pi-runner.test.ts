import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerRunner } from "@smartflow/daemon";
import { StructuredLogger } from "@smartflow/observability";
import type {
  CancelReceipt,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import {
  StateStore,
  projectStateSchema,
  runArtifactInventory,
  type ProjectState
} from "@smartflow/state-store";
import { compileTaskManifest } from "@smartflow/task-manifest";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];
const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);
const canonicalTasksPath = ".smartflow/tasks/request-1/tasks.md";

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function availableProbe(configHash: string): ProviderProbeResult {
  return {
    available: true,
    capabilities: {
      officialCodingTools: true,
      arbitraryShell: true,
      networkAccess: true,
      streaming: true,
      cancellation: true,
      sessionPersistence: true
    },
    providerRuntimeConfigHash: configHash,
    details: { test: "pi" }
  };
}

interface PiStartObservation {
  attemptId: string;
  generation: number;
  workspaceDir: string;
  prompt: string;
  piSessionId: string;
  sessionFile: string;
  resumeSession: WorkerStartInput["resumeSession"];
  restoredSessionBytes?: Buffer;
  sessionBytes: Buffer;
}

class TestPiProvider implements WorkerProvider {
  public readonly id = "pi" as const;
  public readonly starts: PiStartObservation[] = [];

  public constructor(
    private readonly configHash: string,
    private readonly terminal: "COMPLETED" | "TIMED_OUT" | "BLOCKED"
  ) {}

  public probe(): Promise<ProviderProbeResult> {
    return Promise.resolve(availableProbe(this.configHash));
  }

  public start(input: WorkerStartInput): AsyncIterable<WorkerEvent> {
    return this.events(input);
  }

  public cancel(attemptId: string): Promise<CancelReceipt> {
    return Promise.resolve({ attemptId, requested: true, treeEmpty: true });
  }

  private async *events(input: WorkerStartInput): AsyncIterable<WorkerEvent> {
    await mkdir(dirname(input.containment.registryPath), { recursive: true });
    await writeFile(input.containment.registryPath, JSON.stringify([{
      attemptId: input.attemptId,
      configHash: input.providerRuntimeConfigHash,
      containmentId: `sandbox-${input.attemptId}`,
      pid: 2_147_483_647,
      processStartToken: "test-process-start",
      status: "EXITED"
    }]), "utf8");

    const piSessionId = input.resumeSession?.expectedPiSessionId ?? "pi-session-job-1";
    const sessionFile = input.resumeSession?.sessionFile ?? resolve(
      input.workspaceDir,
      ".smartflow-runtime",
      "sessions",
      `${piSessionId}.jsonl`
    );
    const restoredSessionBytes = input.resumeSession === undefined
      ? undefined
      : await readFile(sessionFile);
    const sessionEntry = Buffer.from(`${JSON.stringify({
      type: "smartflow-test-turn",
      attemptId: input.attemptId,
      generation: input.generation,
      prompt: input.prompt,
      workspaceDir: input.workspaceDir,
      internalPath: resolve(input.workspaceDir, "sum.js")
    })}\n`, "utf8");
    const sessionBytes = restoredSessionBytes === undefined
      ? sessionEntry
      : Buffer.concat([restoredSessionBytes, sessionEntry]);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, sessionBytes);
    await writeFile(resolve(input.workspaceDir, ".smartflow-runtime/session.json"), "runtime", "utf8");
    this.starts.push({
      attemptId: input.attemptId,
      generation: input.generation,
      workspaceDir: input.workspaceDir,
      prompt: input.prompt,
      piSessionId,
      sessionFile,
      resumeSession: input.resumeSession,
      ...(restoredSessionBytes === undefined ? {} : { restoredSessionBytes }),
      sessionBytes
    });

    yield {
      type: "STARTED",
      attemptId: input.attemptId,
      piSessionId,
      containmentId: `sandbox-${input.attemptId}`,
      pid: 2_147_483_647,
      processStartToken: "test-process-start"
    };
    if (this.terminal === "COMPLETED") {
      await writeFile(
        resolve(input.workspaceDir, "sum.js"),
        `export const sum = (left, right) => left + right + ${String(input.generation + 1)};\n`,
        "utf8"
      );
      await writeFile(
        resolve(input.workspaceDir, canonicalTasksPath),
        "provider must not change the canonical task contract",
        "utf8"
      );
      yield {
        type: "COMPLETED",
        attemptId: input.attemptId,
        piSessionId,
        sessionFile
      };
    } else if (this.terminal === "TIMED_OUT") {
      yield { type: "TIMED_OUT", attemptId: input.attemptId, code: "ATTEMPT_DEADLINE_EXCEEDED" };
    } else {
      yield {
        type: "BLOCKED",
        attemptId: input.attemptId,
        code: "PI_INPUT_UNAVAILABLE",
        message: "required input is unavailable"
      };
    }
  }
}

async function initializedStore(harness: RuntimeHarness): Promise<{
  store: StateStore;
  configHash: string;
}> {
  const store = new StateStore(harness.dataDir);
  const timestamp = new Date().toISOString();
  const source = createTasksSource();
  const tasksPath = resolve(harness.projectDir, canonicalTasksPath);
  const historicalTasksPath = resolve(
    harness.projectDir,
    ".smartflow/tasks/historical-request/tasks.md"
  );
  await mkdir(dirname(tasksPath), { recursive: true });
  await mkdir(dirname(historicalTasksPath), { recursive: true });
  await writeFile(resolve(harness.projectDir, ".gitignore"), ".smartflow/\n", "utf8");
  await writeFile(tasksPath, source, "utf8");
  await writeFile(historicalTasksPath, "historical task source", "utf8");
  const compiled = compileTaskManifest(source, {
    projectId: "project-1",
    jobId: "job-1",
    canonicalTaskPath: canonicalTasksPath,
    providerRuntimeConfig: { adapter: "pi", configuration: { model: "test" } },
    approval: {
      kind: "USER",
      approvedAt: timestamp,
      authorizedCriterionIds: []
    }
  });
  const taskManifest = await store.writeArtifact("runs/job-1/task-manifest.json", compiled.artifactBytes);
  const taskSource = await store.writeArtifact("runs/job-1/task-source.md", Buffer.from(source, "utf8"));
  const state: ProjectState = {
    projectId: "project-1",
    canonicalProjectRoot: harness.projectDir,
    stateVersion: 0,
    projectFence: 1,
    activeRunsByTaskPath: { [tasksPath]: "job-1" },
    publishLease: null,
    runs: {
      "job-1": {
        jobId: "job-1",
        canonicalTaskPath: tasksPath,
        fence: 1,
        phase: "PREPARING",
        taskManifest,
        taskSource,
        reviewAdapterId: "codex",
        approvedTasks: {
          path: resolve(store.dataDirectory, taskSource.relativePath),
          sourceHash: compiled.manifest.sourceHash
        },
        workerAttempts: [],
        noProgressCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    processedRequests: {},
    updatedAt: timestamp
  };
  await store.initialize(state);
  return { store, configHash: compiled.manifest.providerRuntimeConfigHash };
}

interface StoredPiSessionBundle {
  jobId: string;
  attemptId: string;
  generation: number;
  piSessionId: string;
  terminalStatus: string;
  sessionFileRelativePath: string;
  sessionJsonlBase64: string;
}

async function sessionBundle(
  store: StateStore,
  artifact: NonNullable<ProjectState["runs"][string]["workerAttempts"][number]["sessionArtifact"]>
): Promise<StoredPiSessionBundle> {
  return JSON.parse(new TextDecoder().decode(
    await store.readArtifact(artifact)
  )) as StoredPiSessionBundle;
}

describe("Pi WorkerRunner", () => {
  it("resolves the bundled MCP model without reading or creating a model file", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-pi-model-registration-"));
    temporaryRoots.push(root);
    const modelFileCanary = resolve(root, "models.json");
    const credentialCanary = "smartflow-api-key-canary";
    await writeFile(modelFileCanary, "must-not-be-read", "utf8");

    const result = await executeFile(process.execPath, [
      resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "--no-extensions",
      "--extension",
      resolve(process.cwd(), "packages/provider-pi/src/mcp-model-extension.ts"),
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--list-models",
      "smartflow-mcp"
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: resolve(root, "home"),
        PI_CODING_AGENT_DIR: resolve(root, "agent"),
        API: "openai-completions",
        BASE_URL: "https://models.example.test/v1",
        MODEL: "model-test",
        SMARTFLOW_PI_CONTEXT_WINDOW: "1000000",
        SMARTFLOW_PI_MAX_TOKENS: "384000",
        SMARTFLOW_PI_THINKING: "high",
        SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "300000",
        API_KEY: credentialCanary
      }
    });

    expect(result.stdout).toContain("smartflow-mcp");
    expect(result.stdout).toContain("model-test");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(credentialCanary);
    await expect(readFile(modelFileCanary, "utf8")).resolves.toBe("must-not-be-read");
    await expect(readFile(resolve(root, "agent", "models.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures a Candidate and the raw PI session bundle before removing runtime files", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    const provider = new TestPiProvider(configHash, "COMPLETED");
    const logLines: string[] = [];
    const logger = new StructuredLogger("pi-runner-test", (line) => logLines.push(line));
    await new WorkerRunner(store, provider, { logger }).run({
      jobId: "job-1",
      prompt: "implement",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    const state = await store.readState();
    const run = state.runs["job-1"];
    expect(run?.phase).toBe("REVIEW_PENDING");
    if (
      run?.candidate === undefined ||
      run.baseline === undefined ||
      run.workspace === undefined ||
      run.gitWorkspace === undefined
    ) {
      throw new Error("completed Pi run evidence missing");
    }
    expect(run.gitWorkspace).not.toHaveProperty("capability");
    expect(projectStateSchema.safeParse({
      ...state,
      runs: {
        ...state.runs,
        "job-1": {
          ...run,
          gitWorkspace: {
            ...run.gitWorkspace,
            capability: run.gitWorkspace.runBaselineSnapshot
          }
        }
      }
    }).success).toBe(false);
    expect(runArtifactInventory(run).bindings.some((binding) =>
      binding.name.endsWith(".capability")
    )).toBe(false);
    expect(logLines).toHaveLength(1);
    const capabilityLog = JSON.parse(logLines[0] ?? "{}") as {
      data?: { symlinks?: unknown; fileMode?: unknown };
      [key: string]: unknown;
    };
    expect(capabilityLog).toMatchObject({
      level: "info",
      event: "worker.git_capability_ready",
      stage: "git-capability",
      correlation: { jobId: "job-1" },
      data: {
        repositoryId: run.gitWorkspace.repositoryId,
        inclusionPolicyHash: run.gitWorkspace.inclusionPolicyHash,
        worktreeSupported: true
      }
    });
    expect(typeof capabilityLog.data?.symlinks).toBe("boolean");
    expect(typeof capabilityLog.data?.fileMode).toBe("boolean");
    const capabilityLogLine = logLines.join("\n");
    expect(capabilityLogLine).not.toContain(harness.projectDir);
    expect(capabilityLogLine).not.toContain(store.dataDirectory);
    expect(run.workerAttempts).toHaveLength(1);
    const attempt = run.workerAttempts[0];
    expect(attempt?.status).toBe("COMPLETED");
    expect(attempt?.piSessionId).toBe("pi-session-job-1");
    if (attempt?.sessionArtifact === undefined) throw new Error("PI session artifact missing");
    const bundle = await sessionBundle(store, attempt.sessionArtifact);
    const rawSession = Buffer.from(bundle.sessionJsonlBase64, "base64");
    expect(bundle).toMatchObject({
      jobId: "job-1",
      attemptId: attempt.attemptId,
      generation: 0,
      piSessionId: "pi-session-job-1",
      terminalStatus: "COMPLETED",
      sessionFileRelativePath: "sessions/pi-session-job-1.jsonl"
    });
    expect(bundle).not.toHaveProperty("schemaVersion");
    expect(rawSession.equals(provider.starts[0]?.sessionBytes ?? Buffer.alloc(0))).toBe(true);
    expect(rawSession.toString("utf8")).toContain(store.dataDirectory);

    const candidate = JSON.parse(new TextDecoder().decode(await store.readArtifact(run.candidate))) as {
      operations: Array<{ path: string }>;
    };
    expect(candidate).not.toHaveProperty("schemaVersion");
    expect(candidate.operations.map((operation) => operation.path)).toContain("sum.js");
    expect(candidate.operations.some((operation) => operation.path.startsWith(".smartflow-runtime/"))).toBe(false);
    expect(candidate.operations.some((operation) => operation.path.startsWith(".smartflow/tasks/"))).toBe(false);
    const current = run.gitWorkspace.current;
    expect(current).toMatchObject({
      candidate: run.candidate
    });
    if (current.resultSnapshot === undefined) throw new Error("result snapshot missing");
    const workspaceRoot = resolve(store.dataDirectory, run.workspace.relativePath);
    expect(await readFile(resolve(workspaceRoot, canonicalTasksPath)))
      .toEqual(await store.readArtifact(run.taskSource));
    await expect(readFile(resolve(
      workspaceRoot,
      ".smartflow/tasks/historical-request/tasks.md"
    ))).rejects.toMatchObject({ code: "ENOENT" });
    const baselineSnapshot = JSON.parse(new TextDecoder().decode(
      await store.readArtifact(run.baseline)
    )) as { entries: Array<{ path: string }> };
    const resultSnapshot = JSON.parse(new TextDecoder().decode(
      await store.readArtifact(current.resultSnapshot)
    )) as { entries: Array<{ path: string }> };
    for (const snapshot of [baselineSnapshot, resultSnapshot]) {
      expect(snapshot.entries.some((entry) => entry.path.startsWith(".smartflow/tasks/")))
        .toBe(false);
    }
    for (const binding of runArtifactInventory(run).bindings) {
      if (binding.semantic === "TASK_SOURCE" || binding.semantic === "PI_SESSION") continue;
      const artifactText = new TextDecoder().decode(await store.readArtifact(binding.ref));
      expect(artifactText).not.toContain(harness.projectDir);
      expect(artifactText).not.toContain(store.dataDirectory);
    }
    await expect(readFile(resolve(store.dataDirectory, run.workspace.relativePath, ".smartflow-runtime/session.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish COMPLETED when the PI session artifact cannot be written", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    const writeArtifact = store.writeArtifact.bind(store);
    vi.spyOn(store, "writeArtifact").mockImplementation(async (relativePath, bytes) => {
      if (relativePath.endsWith("/session-artifact.json")) {
        throw new Error("session artifact write failed");
      }
      return writeArtifact(relativePath, bytes);
    });

    await new WorkerRunner(store, new TestPiProvider(configHash, "COMPLETED")).run({
      jobId: "job-1",
      prompt: "implement",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    const run = (await store.readState()).runs["job-1"];
    expect(run?.phase).toBe("PAUSED");
    expect(run?.workerAttempts).toHaveLength(1);
    expect(run?.workerAttempts[0]?.status).toBe("FAILED");
    expect(run?.workerAttempts[0]?.terminalReason).toContain(
      "session artifact write failed"
    );
    expect(run?.workerAttempts[0]?.sessionArtifact).toBeUndefined();
    expect(run?.candidate).toBeUndefined();
  });

  it("restores raw PI JSONL for a new attempt in the same Job and workspace", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    const provider = new TestPiProvider(configHash, "COMPLETED");
    const runner = new WorkerRunner(store, provider);
    await runner.run({
      jobId: "job-1",
      prompt: "initial implementation",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    const firstState = await store.readState();
    const firstRun = firstState.runs["job-1"];
    const firstAttempt = firstRun?.workerAttempts[0];
    const firstCurrent = firstRun?.gitWorkspace?.current;
    if (
      firstRun === undefined ||
      firstRun.workspace === undefined ||
      firstRun.gitWorkspace === undefined ||
      firstAttempt?.status !== "COMPLETED" ||
      firstAttempt.piSessionId === undefined ||
      firstAttempt.sessionArtifact === undefined ||
      firstCurrent?.resultSnapshot === undefined
    ) {
      throw new Error("first PI attempt is incomplete");
    }
    const firstBundle = await sessionBundle(store, firstAttempt.sessionArtifact);
    const firstSessionBytes = Buffer.from(firstBundle.sessionJsonlBase64, "base64");
    const firstWorkspace = firstRun.workspace.relativePath;
    const firstTaskManifest = firstRun.taskManifest;
    const firstTaskSource = firstRun.taskSource;
    const resetAt = new Date().toISOString();
    await store.writeState({
      ...firstState,
      stateVersion: firstState.stateVersion + 1,
      runs: {
        ...firstState.runs,
        "job-1": {
          ...firstRun,
          phase: "PREPARING",
          candidate: undefined,
          review: undefined,
          leaderDecision: undefined,
          pendingAction: undefined,
          hostTurn: undefined,
          publish: undefined,
          pause: undefined,
          lastError: undefined,
          gitWorkspace: {
            ...firstRun.gitWorkspace,
            current: {
              indexPath: firstCurrent.indexPath,
              workspacePath: firstCurrent.workspacePath,
              inputSnapshot: firstCurrent.resultSnapshot
            }
          },
          updatedAt: resetAt
        }
      },
      updatedAt: resetAt
    });

    await runner.run({
      jobId: "job-1",
      prompt: "repair the reported issue",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000,
      resumeSession: {
        expectedPiSessionId: firstAttempt.piSessionId,
        sessionArtifact: firstAttempt.sessionArtifact
      }
    });

    const secondRun = (await store.readState()).runs["job-1"];
    expect(secondRun).toMatchObject({
      phase: "REVIEW_PENDING",
      taskManifest: firstTaskManifest,
      taskSource: firstTaskSource,
      workspace: { relativePath: firstWorkspace }
    });
    expect(secondRun?.workerAttempts).toHaveLength(2);
    expect(secondRun?.workerAttempts.map((attempt) => attempt.generation)).toEqual([0, 1]);
    expect(secondRun?.workerAttempts.map((attempt) => attempt.piSessionId))
      .toEqual(["pi-session-job-1", "pi-session-job-1"]);
    expect(provider.starts).toHaveLength(2);
    expect(provider.starts.map((start) => start.workspaceDir))
      .toEqual([provider.starts[0]?.workspaceDir, provider.starts[0]?.workspaceDir]);
    expect(provider.starts[1]?.resumeSession).toMatchObject({
      expectedPiSessionId: "pi-session-job-1",
      sessionFile: provider.starts[0]?.sessionFile
    });
    expect(provider.starts[1]?.restoredSessionBytes?.equals(firstSessionBytes)).toBe(true);

    const secondAttempt = secondRun?.workerAttempts[1];
    if (secondAttempt?.sessionArtifact === undefined) throw new Error("resumed session artifact missing");
    const secondBundle = await sessionBundle(store, secondAttempt.sessionArtifact);
    const secondSessionBytes = Buffer.from(secondBundle.sessionJsonlBase64, "base64");
    expect(secondBundle).toMatchObject({
      generation: 1,
      piSessionId: "pi-session-job-1",
      sessionFileRelativePath: firstBundle.sessionFileRelativePath
    });
    expect(secondBundle).not.toHaveProperty("schemaVersion");
    expect(secondSessionBytes.equals(provider.starts[1]?.sessionBytes ?? Buffer.alloc(0))).toBe(true);
    expect(secondSessionBytes.subarray(0, firstSessionBytes.length).equals(firstSessionBytes)).toBe(true);
    expect(secondSessionBytes.toString("utf8")).toContain("repair the reported issue");
  });

  it("persists one timed-out Attempt and never creates a Candidate or replacement", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    await new WorkerRunner(store, new TestPiProvider(configHash, "TIMED_OUT")).run({
      jobId: "job-1",
      prompt: "implement",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    const run = (await store.readState()).runs["job-1"];
    expect(run?.phase).toBe("PAUSED");
    expect(run?.workerAttempts).toHaveLength(1);
    expect(run?.workerAttempts[0]?.status).toBe("TIMED_OUT");
    expect(run?.workerAttempts[0]?.sessionArtifact).toBeUndefined();
    expect(run?.pause?.code).toBe("ATTEMPT_DEADLINE_EXCEEDED");
    expect(run?.candidate).toBeUndefined();
  });
});
