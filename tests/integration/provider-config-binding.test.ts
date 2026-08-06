import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRuntime } from "@smartflow/daemon";
import {
  frozenPiRuntimeConfig,
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "@smartflow/provider-pi";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

function runtimeConfig(modelId: string): PiRuntimeConfiguration {
  return {
    api: "openai-completions",
    baseUrl: "https://models.example.test/v1",
    modelId,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevel: "high",
    attemptDeadlineMs: 60_000,
    resourcePolicy: "workspace-project-resources"
  };
}

describe("Provider configuration binding", () => {
  it("binds concurrent Project Runs to their MCP connection configurations", async () => {
    const firstHarness = await createRuntimeHarness();
    const secondHarness = await createRuntimeHarness();
    harnesses.push(firstHarness, secondHarness);
    const tasksSource = createTasksSource();
    await Promise.all([
      writeFile(resolve(firstHarness.projectDir, "tasks.md"), tasksSource, "utf8"),
      writeFile(resolve(secondHarness.projectDir, "tasks.md"), tasksSource, "utf8")
    ]);

    const firstConfig = runtimeConfig("model-a");
    const secondConfig = runtimeConfig("model-b");
    const firstHash = piRuntimeConfigHash(firstConfig);
    const secondHash = piRuntimeConfigHash(secondConfig);
    const firstFrozenConfig = frozenPiRuntimeConfig(firstConfig);
    const configurations = new Map([
      [firstHash, firstFrozenConfig],
      [secondHash, frozenPiRuntimeConfig(secondConfig)]
    ]);
    const dataDirectory = resolve(firstHarness.dataDir, "daemon");
    const runtime = new ProjectRuntime({
      dataDirectory,
      runPipeline: (): Promise<void> => Promise.resolve(),
      providerRuntimeConfig: firstFrozenConfig,
      resolveProviderRuntimeConfig: (
        hash
      ): Readonly<Record<string, unknown>> | undefined => configurations.get(hash)
    });
    const approvedSourceHash = createHash("sha256").update(tasksSource).digest("hex");

    const execute = async (
      harness: RuntimeHarness,
      providerRuntimeConfigHash: string,
      requestId: string
    ): Promise<{ projectId: string; jobId: string }> => runtime.handle({
      id: requestId,
      method: "smartflow_execute",
      providerRuntimeConfigHash,
      payload: {
        projectRoot: harness.projectDir,
        tasksPath: "tasks.md",
        approvedSourceHash,
        requestId,
        expectedStateVersion: 0
      }
    }) as Promise<{ projectId: string; jobId: string }>;

    const [firstRun, secondRun] = await Promise.all([
      execute(firstHarness, firstHash, "execute-first"),
      execute(secondHarness, secondHash, "execute-second")
    ]);
    const manifestHash = async (run: { projectId: string; jobId: string }): Promise<string> => {
      const path = resolve(
        dataDirectory,
        "projects",
        run.projectId,
        "runs",
        run.jobId,
        "revision-1",
        "task-manifest.json"
      );
      const manifest = JSON.parse(await readFile(path, "utf8")) as {
        providerRuntimeConfigHash: string;
      };
      return manifest.providerRuntimeConfigHash;
    };

    await expect(manifestHash(firstRun)).resolves.toBe(firstHash);
    await expect(manifestHash(secondRun)).resolves.toBe(secondHash);
  });
});
