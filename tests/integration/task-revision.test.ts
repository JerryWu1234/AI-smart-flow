import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  advanceRevision,
  checkApprovedSource,
  compileTaskManifest,
  createRevisionState
} from "@smartflow/task-manifest";
import {
  frozenPiRuntimeConfig,
  piRuntimeConfigHash,
  type PiRuntimeConfiguration
} from "@smartflow/provider-pi";
import { createTasksSource } from "../../packages/task-manifest/src/test-fixture.js";
import { createRuntimeHarness, type RuntimeHarness } from "../helpers/runtime-harness.js";

const activeHarnesses: RuntimeHarness[] = [];

afterEach(async () => {
  await Promise.all(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
});

const compileOptions = {
  projectId: "project-1",
  jobId: "job-1",
  revision: 1,
  canonicalTaskPath: "/project/tasks.md",
  providerRuntimeConfig: { model: "test-model" },
  approval: {
    kind: "USER" as const,
    approvedAt: "2026-07-20T10:00:00+08:00",
    parentRevision: null,
    authorizedCriterionIds: []
  }
};

const piConfiguration: PiRuntimeConfiguration = {
  api: "openai-completions",
  baseUrl: "https://models.example.test/v1",
  modelId: "test-model",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  thinkingLevel: "high",
  attemptDeadlineMs: 60_000,
  resourcePolicy: "workspace-project-resources"
};

describe("task revision guard", () => {
  it("compiles the exact frozen Pi runtime hash consumed by WorkerRunner", () => {
    const compiled = compileTaskManifest(createTasksSource(), {
      ...compileOptions,
      providerRuntimeConfig: frozenPiRuntimeConfig(piConfiguration)
    });
    expect(compiled.manifest.providerRuntimeConfigHash).toBe(piRuntimeConfigHash(piConfiguration));
  });

  it("pauses on approved source drift and clears Candidate, Review, and Publish evidence", () => {
    const compiled = compileTaskManifest(createTasksSource(), compileOptions);
    const initial = createRevisionState({
      revision: 1,
      sourceHash: compiled.manifest.sourceHash,
      tasksHash: compiled.manifest.tasksHash,
      taskManifestHash: compiled.manifestHash
    });
    expect(checkApprovedSource(initial.sourceHash, createTasksSource())).toEqual({ matches: true });
    expect(checkApprovedSource(initial.sourceHash, `${createTasksSource()}\nchanged`)).toMatchObject({
      matches: false,
      pause: { code: "APPROVED_SOURCE_DRIFT" }
    });
    const next = advanceRevision(initial, {
      sourceHash: "a".repeat(64),
      tasksHash: "b".repeat(64),
      taskManifestHash: "c".repeat(64)
    });
    expect(next).toMatchObject({
      revision: 2,
      candidate: null,
      reviewDecision: null,
      publishResult: null
    });
  });

  it("compiles and guards a run after the project .specify directory is deleted", async () => {
    const harness = await createRuntimeHarness();
    activeHarnesses.push(harness);
    const tasksPath = resolve(harness.projectDir, "tasks.md");
    const specifyPath = resolve(harness.projectDir, ".specify");
    await mkdir(specifyPath, { recursive: true });
    await writeFile(resolve(specifyPath, "authoring-only.txt"), "not runtime input", "utf8");
    await writeFile(tasksPath, createTasksSource(), "utf8");
    const before = compileTaskManifest(await readFile(tasksPath), compileOptions);
    await rm(specifyPath, { recursive: true });
    const after = compileTaskManifest(await readFile(tasksPath), compileOptions);
    expect(after).toEqual(before);
    expect(checkApprovedSource(after.manifest.sourceHash, await readFile(tasksPath))).toEqual({
      matches: true
    });
  });

});
