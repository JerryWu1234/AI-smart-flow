import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "@smartflow/daemon";
import { StateStore } from "@smartflow/state-store";
import { resolveReviewStrategy } from "../../apps/daemon/src/config/config.js";
import { createTasksSource } from "../fixtures/task-manifest/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("OpenCode Review strategy binding", () => {
  it("persists an exact OpenCode Host selection with the new Job", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const tasksSource = createTasksSource();
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const dataDirectory = resolve(harness.dataDir, "daemon");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => Promise.resolve(),
      resolveReviewAdapterId: (
        clientName
      ): ReturnType<typeof resolveReviewStrategy> => resolveReviewStrategy(undefined, clientName)
    });
    const requestId = "execute-opencode-host";
    const execution = await runtime.handle({
      id: requestId,
      method: "smartflow_execute",
      clientName: "opencode",
      payload: {
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: createHash("sha256").update(tasksSource).digest("hex"),
        requestId,
        expectedStateVersion: 0
      }
    }) as { projectId: string; jobId: string };

    const store = new StateStore(resolve(
      dataDirectory,
      "projects",
      execution.projectId
    ));
    expect((await store.readState()).runs[execution.jobId]?.reviewAdapterId)
      .toBe("opencode");
  });
});
