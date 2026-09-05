import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "@smartflow/daemon";
import { createToolHandlers } from "@smartflow/mcp-server";
import { StateStore } from "@smartflow/state-store";
import type { TaskManifest } from "@smartflow/task-manifest";
import {
  approveTasksSource,
  executeApprovedTasks,
  type HostGateway
} from "../helpers/host-workflow/index.js";
import { createHostCanonicalTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];

async function completeRun(store: StateStore, jobId: string): Promise<void> {
  const state = await store.readState();
  const run = state.runs[jobId];
  if (run === undefined) throw new Error("canonical run missing");
  const updatedAt = new Date().toISOString();
  await store.writeState({
    ...state,
    stateVersion: state.stateVersion + 1,
    activeRunsByTaskPath: Object.fromEntries(
      Object.entries(state.activeRunsByTaskPath).filter(
        ([, activeJobId]) => activeJobId !== jobId
      )
    ),
    runs: {
      ...state.runs,
      [jobId]: { ...run, phase: "COMPLETED", updatedAt }
    },
    updatedAt
  });
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Host canonical task lifecycle", () => {
  it("creates independent immutable Jobs for sequential confirmed session sources", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "canonical-lifecycle");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => Promise.resolve()
    });
    const session = {
      sessionId: "canonical-session",
      projectRoot: harness.projectDir,
      tasksPath: ".smartflow/tasks/canonical-session/tasks.md"
    };
    const handlers = createToolHandlers({
      call: (toolName, input): Promise<unknown> => {
        const requestId = (input as { requestId?: unknown }).requestId;
        return runtime.handle({
          id: typeof requestId === "string" ? requestId : toolName,
          method: toolName,
          payload: input
        });
      }
    }, session);
    const gateway: HostGateway = {
      call: (toolName, input): Promise<unknown> => {
        if (toolName !== "smartflow_execute") {
          return Promise.reject(new Error(`Unexpected Host tool: ${toolName}`));
        }
        return handlers.smartflow_execute(input);
      }
    };
    const requests = [
      { source: createHostCanonicalTasksSource() },
      {
        source: createHostCanonicalTasksSource()
          .replaceAll("User authentication", "Payment checkout")
          .replaceAll("auth/login", "payment/checkout")
      }
    ];
    const absolutePath = resolve(harness.projectDir, session.tasksPath);
    await mkdir(dirname(absolutePath), { recursive: true });

    const executions: Array<{ projectId: string; jobId: string }> = [];
    for (const request of requests) {
      await writeFile(absolutePath, request.source, "utf8");
      const displayedBytes = await readFile(absolutePath);
      const approval = approveTasksSource(session.tasksPath, displayedBytes);
      const execution = await executeApprovedTasks(
        gateway,
        harness.projectDir,
        approval
      );
      executions.push(execution);
      await completeRun(
        new StateStore(resolve(dataDirectory, "projects", execution.projectId)),
        execution.jobId
      );
      expect(execution).not.toHaveProperty("revision");
    }

    expect(executions[0]?.projectId).toBe(executions[1]?.projectId);
    expect(executions[0]?.jobId).not.toBe(executions[1]?.jobId);
    expect(await readFile(absolutePath, "utf8")).toBe(requests[1]?.source);

    const projectId = executions[0]?.projectId;
    if (projectId === undefined) throw new Error("canonical project id missing");
    const store = new StateStore(resolve(dataDirectory, "projects", projectId));
    const state = await store.readState();
    expect(Object.keys(state.runs)).toHaveLength(2);

    for (const [index, execution] of executions.entries()) {
      const run = state.runs[execution.jobId];
      const request = requests[index];
      if (run === undefined || request === undefined) throw new Error("canonical run missing");
      expect(new TextDecoder().decode(await store.readArtifact(run.taskSource)))
        .toBe(request.source);
      const manifest = JSON.parse(
        new TextDecoder().decode(await store.readArtifact(run.taskManifest))
      ) as TaskManifest;
      expect(manifest.canonicalTaskPath).toBe(session.tasksPath);
      expect(manifest.enabledTaskIds).toEqual(["T001", "T002"]);
      expect(manifest).not.toHaveProperty("revision");
      expect(manifest).not.toHaveProperty("revisionId");
    }
  });
});
