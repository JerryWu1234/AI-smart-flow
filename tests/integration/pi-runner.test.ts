import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerRunner } from "@smartflow/daemon";
import type {
  CancelReceipt,
  ProviderProbeResult,
  WorkerEvent,
  WorkerProvider,
  WorkerStartInput
} from "@smartflow/provider-core";
import { StateStore, runArtifactInventory, type ProjectState } from "@smartflow/state-store";
import { compileTaskManifest } from "@smartflow/task-manifest";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];
const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);

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

class TestPiProvider implements WorkerProvider {
  public readonly id = "pi" as const;

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
    yield {
      type: "STARTED",
      attemptId: input.attemptId,
      piSessionId: `pi-session-${input.attemptId}`,
      containmentId: `sandbox-${input.attemptId}`,
      pid: 2_147_483_647,
      processStartToken: "test-process-start"
    };
    await mkdir(resolve(input.workspaceDir, ".smartflow-runtime"), { recursive: true });
    await writeFile(resolve(input.workspaceDir, ".smartflow-runtime/session.json"), "runtime", "utf8");
    if (this.terminal === "COMPLETED") {
      await writeFile(
        resolve(input.workspaceDir, "sum.js"),
        "export const sum = (left, right) => left + right + 1;\n",
        "utf8"
      );
      yield {
        type: "COMPLETED",
        attemptId: input.attemptId,
        piSessionId: `pi-session-${input.attemptId}`
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
  const tasksPath = resolve(harness.projectDir, "tasks.md");
  await writeFile(tasksPath, source, "utf8");
  const compiled = compileTaskManifest(source, {
    projectId: "project-1",
    jobId: "job-1",
    revision: 1,
    canonicalTaskPath: "tasks.md",
    providerRuntimeConfig: { adapter: "pi", configuration: { model: "test" } },
    approval: {
      kind: "USER",
      approvedAt: timestamp,
      parentRevision: null,
      authorizedCriterionIds: []
    }
  });
  const taskManifest = await store.writeArtifact("runs/job-1/task-manifest.json", compiled.artifactBytes);
  const taskSource = await store.writeArtifact("runs/job-1/revision-1/task-source.md", Buffer.from(source, "utf8"));
  const state: ProjectState = {
    schemaVersion: 5,
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
        revision: 1,
        taskManifest,
        taskSource,
        approvedTasks: { path: "tasks.md", sourceHash: compiled.manifest.sourceHash },
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
        SMARTFLOW_PI_API: "openai-completions",
        SMARTFLOW_PI_BASE_URL: "https://models.example.test/v1",
        SMARTFLOW_PI_MODEL: "model-test",
        SMARTFLOW_PI_CONTEXT_WINDOW: "1000000",
        SMARTFLOW_PI_MAX_TOKENS: "384000",
        SMARTFLOW_PI_THINKING: "high",
        SMARTFLOW_PI_ATTEMPT_DEADLINE_MS: "1800000",
        SMARTFLOW_PI_API_KEY: credentialCanary
      }
    });

    expect(result.stdout).toContain("smartflow-mcp");
    expect(result.stdout).toContain("model-test");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(credentialCanary);
    await expect(readFile(modelFileCanary, "utf8")).resolves.toBe("must-not-be-read");
    await expect(readFile(resolve(root, "agent", "models.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures a Candidate only after the Pi containment exits and excludes runtime files", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    const result = await new WorkerRunner(store, new TestPiProvider(configHash, "COMPLETED")).run({
      jobId: "job-1",
      revision: 1,
      prompt: "implement",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    expect(result.phase).toBe("REVIEW_PENDING");
    const run = (await store.readState()).runs["job-1"];
    if (run?.candidate === undefined || run.workspace === undefined) {
      throw new Error("completed Pi run evidence missing");
    }
    expect(run.workerAttempts).toHaveLength(1);
    expect(run.workerAttempts[0]?.status).toBe("COMPLETED");
    expect(run.workerAttempts[0]?.piSessionId).toMatch(/^pi-session-/u);
    const candidate = JSON.parse(new TextDecoder().decode(await store.readArtifact(run.candidate))) as {
      operations: Array<{ path: string }>;
    };
    expect(candidate.operations.map((operation) => operation.path)).toContain("sum.js");
    expect(candidate.operations.some((operation) => operation.path.startsWith(".smartflow-runtime/"))).toBe(false);
    for (const binding of runArtifactInventory(run).bindings) {
      if (binding.semantic === "TASK_SOURCE") continue;
      const artifactText = new TextDecoder().decode(await store.readArtifact(binding.ref));
      expect(artifactText).not.toContain(harness.projectDir);
      expect(artifactText).not.toContain(store.dataDirectory);
    }
    await expect(readFile(resolve(store.dataDirectory, run.workspace.relativePath, ".smartflow-runtime/session.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists one timed-out Attempt and never creates a Candidate or replacement", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const { store, configHash } = await initializedStore(harness);
    const result = await new WorkerRunner(store, new TestPiProvider(configHash, "TIMED_OUT")).run({
      jobId: "job-1",
      revision: 1,
      prompt: "implement",
      providerRuntimeConfigHash: configHash,
      attemptDeadlineMs: 10_000
    });

    expect(result.phase).toBe("PAUSED");
    const run = (await store.readState()).runs["job-1"];
    expect(run?.workerAttempts).toHaveLength(1);
    expect(run?.workerAttempts[0]?.status).toBe("TIMED_OUT");
    expect(run?.pause?.code).toBe("ATTEMPT_DEADLINE_EXCEEDED");
    expect(run?.candidate).toBeUndefined();
  });
});
