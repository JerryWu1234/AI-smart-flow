import { describe, expect, it } from "vitest";

import { taskManifestSchema } from "../../../../packages/task-manifest/src/schema.js";
import { compileTaskManifest } from "../../../../packages/task-manifest/src/task-manifest.js";
import { createTasksSource } from "../../../fixtures/task-manifest/test-fixture.js";

const baseOptions = {
  projectId: "project-1",
  jobId: "job-1",
  canonicalTaskPath: "tasks.md",
  providerRuntimeConfig: { endpoint: "https://provider.invalid", model: "test-model" },
  approval: {
    kind: "USER" as const,
    approvedAt: "2026-07-20T10:00:00+08:00",
    authorizedCriterionIds: ["T001:acceptance:1"]
  }
};

describe("TaskManifest compiler", () => {
  it("compiles pure Markdown into deterministic hashes and canonical artifact bytes", () => {
    const first = compileTaskManifest(createTasksSource(), baseOptions);
    const second = compileTaskManifest(createTasksSource(), baseOptions);
    expect(first).toEqual(second);
    expect(first.manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifest).not.toHaveProperty("schemaVersion");
    expect(first.manifest.taskSourceArtifact).toMatchObject({
      relativePath: "runs/job-1/task-source.md",
      sha256: first.manifest.sourceHash
    });
    expect(first.manifest.canonicalTaskPath).toBe("tasks.md");
    expect(first.manifest.providerRuntimeConfigHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifest.enabledTaskIds).toEqual(["T001"]);
    expect(JSON.parse(new TextDecoder().decode(first.artifactBytes))).toEqual(first.manifest);
  });

  it("binds the canonical task path into the Manifest identity", () => {
    const first = compileTaskManifest(createTasksSource(), baseOptions);
    const second = compileTaskManifest(createTasksSource(), {
      ...baseOptions,
      canonicalTaskPath: "other-tasks.md"
    });
    expect(second.manifest.sourceHash).toBe(first.manifest.sourceHash);
    expect(second.manifestHash).not.toBe(first.manifestHash);
  });

  it("changes manifest hash for task, acceptance, and no-change changes", () => {
    const base = compileTaskManifest(createTasksSource(), baseOptions).manifestHash;
    const changedTask = compileTaskManifest(
      createTasksSource({
        tasks:
          "## M01 · Core\n\n- [ ] T001 Edit `packages/core/src/other.ts` — 验收：core review passes"
      }),
      baseOptions
    ).manifestHash;
    const changedAcceptance = compileTaskManifest(
      createTasksSource({
        tasks:
          "## M01 · Core\n\n- [ ] T001 Edit `packages/core/src/index.ts` — 验收：a stronger criterion"
      }),
      baseOptions
    ).manifestHash;
    const allowNoChange = compileTaskManifest(
      createTasksSource().replace(
        "core review passes",
        "core review passes no-change-allowed=true"
      ),
      { ...baseOptions, allowNoChange: true }
    ).manifestHash;
    expect(new Set([base, changedTask, changedAcceptance, allowNoChange]).size).toBe(4);
  });

  it("changes manifest hash for provider runtime changes", () => {
    const base = compileTaskManifest(createTasksSource(), baseOptions);
    const providerRuntimeChanged = compileTaskManifest(createTasksSource(), {
      ...baseOptions,
      providerRuntimeConfig: { endpoint: "https://provider.invalid", model: "other-model" }
    });
    expect(providerRuntimeChanged.manifestHash).not.toBe(base.manifestHash);
  });

  it("rejects removed permission-policy fields", () => {
    const manifest = compileTaskManifest(createTasksSource(), baseOptions).manifest;
    expect(taskManifestSchema.safeParse({
      ...manifest,
      permissionPolicy: { writablePathPrefixes: ["packages/"] }
    }).success).toBe(false);
    expect(taskManifestSchema.safeParse({
      ...manifest,
      permissionPolicyHash: "f".repeat(64)
    }).success).toBe(false);
  });

  it("rejects the removed duplicate identity and hash fields", () => {
    const compiled = compileTaskManifest(createTasksSource(), baseOptions);
    expect(compiled.manifest).not.toHaveProperty("runId");
    expect(compiled.manifest).not.toHaveProperty("tasksSha256");
    expect(compiled.manifest).not.toHaveProperty("tasksHash");
    for (const removed of ["runId", "tasksSha256", "tasksHash"]) {
      expect(taskManifestSchema.safeParse({
        ...compiled.manifest,
        [removed]: removed === "runId" ? "job-1" : compiled.manifest.sourceHash
      }).success).toBe(false);
    }
  });

  it("binds explicit no-change allowance to every enabled task acceptance criterion", () => {
    const enabled = createTasksSource().replace(
      "core review passes",
      "core review passes no-change-allowed=true"
    );
    const compiled = compileTaskManifest(enabled, { ...baseOptions, allowNoChange: true });
    expect(compiled.manifest.allowNoChange).toBe(true);
    expect(() =>
      compileTaskManifest(createTasksSource(), { ...baseOptions, allowNoChange: true })
    ).toThrow(/no-change-allowed=true/u);
  });
});
