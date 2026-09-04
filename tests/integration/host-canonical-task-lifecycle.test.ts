import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "@smartflow/daemon";
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

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Host canonical task lifecycle", () => {
  it("creates independent immutable Jobs for sequential confirmed request files", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const dataDirectory = resolve(harness.dataDir, "canonical-lifecycle");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => Promise.resolve()
    });
    const gateway: HostGateway = {
      call: (toolName, input): Promise<unknown> => {
        const requestId = (input as { requestId?: unknown }).requestId;
        return runtime.handle({
          id: typeof requestId === "string" ? requestId : toolName,
          method: toolName,
          payload: input
        });
      }
    };
    const requests = [
      { id: "canonical-request-a", source: createHostCanonicalTasksSource() },
      {
        id: "canonical-request-b",
        source: createHostCanonicalTasksSource()
          .replaceAll("User authentication", "Payment checkout")
          .replaceAll("auth/login", "payment/checkout")
      }
    ];

    const executions: Array<{ projectId: string; jobId: string }> = [];
    for (const request of requests) {
      const tasksPath = `.smartflow/tasks/${request.id}/tasks.md`;
      const absolutePath = resolve(harness.projectDir, tasksPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, request.source, "utf8");
      const displayedBytes = await readFile(absolutePath);
      const approval = approveTasksSource(tasksPath, displayedBytes);
      const execution = await executeApprovedTasks(
        gateway,
        harness.projectDir,
        approval,
        request.id
      );
      executions.push(execution);
      expect(execution).not.toHaveProperty("revision");
    }

    expect(executions[0]?.projectId).toBe(executions[1]?.projectId);
    expect(executions[0]?.jobId).not.toBe(executions[1]?.jobId);
    expect(await readFile(
      resolve(harness.projectDir, ".smartflow/tasks/canonical-request-a/tasks.md"),
      "utf8"
    )).toBe(requests[0]?.source);

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
      expect(manifest.canonicalTaskPath)
        .toBe(`.smartflow/tasks/${request.id}/tasks.md`);
      expect(manifest.enabledTaskIds).toEqual(["T001", "T002"]);
      expect(manifest).not.toHaveProperty("revision");
      expect(manifest).not.toHaveProperty("revisionId");
    }
  });
});
