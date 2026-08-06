import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "@smartflow/daemon";
import { StructuredLogger } from "@smartflow/observability";
import { PiEventNormalizer } from "@smartflow/provider-pi";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("runtime absolute-path non-disclosure", () => {
  it("redacts Pi text and blocked terminal messages before they become Worker events", () => {
    const root = "/Users/canary/private-project";
    const credential = "pi-api-key-canary";
    const normalizer = new PiEventNormalizer("attempt-1", [root, homedir()], [credential]);
    expect(normalizer.normalize({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: `failed under ${root}/src/private.ts with ${credential}`
      }
    })).toMatchObject({ text: "failed under <internal-path>/src/private.ts with <redacted>" });
    expect(normalizer.blockedTerminal(
      `SMARTFLOW_BLOCKED: INPUT_UNAVAILABLE: inspect ${root}/tasks.md with ${credential}`
    )).toMatchObject({ message: "inspect <internal-path>/tasks.md with <redacted>" });
  });

  it("redacts absolute paths from structured logs", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger("test", (line) => lines.push(line));
    const record = logger.log({
      level: "error",
      event: "canary",
      error: "failed at /Users/canary/private-project/src/index.ts"
    });
    expect(JSON.stringify(record)).not.toContain("/Users/canary/private-project");
    expect(lines[0]).toContain("[REDACTED_PATH]");
  });

  it("does not expose project or Data Directory paths through status errors", async () => {
    const harness = await createRuntimeHarness();
    harnesses.push(harness);
    const tasksSource = createTasksSource();
    await writeFile(resolve(harness.projectDir, "tasks.md"), tasksSource, "utf8");
    const runtime = new ProjectRuntime({
      dataDirectory: harness.dataDir,
      runPipeline: (): Promise<void> => Promise.reject(new Error(
        `failure in ${harness.projectDir}/sum.js with state ${harness.dataDir}/state.json`
      ))
    });
    const executed = await runtime.handle({
      id: "execute-path-canary",
      method: "smartflow_execute",
      payload: {
        requestId: "execute-path-canary",
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash: createHash("sha256").update(tasksSource).digest("hex")
      }
    }) as { projectId: string; jobId: string };

    let status: unknown;
    for (let index = 0; index < 100; index += 1) {
      status = await runtime.handle({
        id: `status-path-canary-${String(index)}`,
        method: "smartflow_status",
        payload: { projectId: executed.projectId, jobId: executed.jobId }
      });
      if ((status as { phase?: unknown }).phase === "PAUSED") break;
      await new Promise<void>((settle) => setTimeout(settle, 10));
    }
    const serialized = JSON.stringify(status);
    expect(serialized).toContain("<internal-path>");
    expect(serialized).not.toContain(harness.projectDir);
    expect(serialized).not.toContain(harness.dataDir);
    await new Promise<void>((settle) => setTimeout(settle, 100));
  });
});
