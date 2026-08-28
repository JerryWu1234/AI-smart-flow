import { describe, expect, it } from "vitest";

import { compileTaskManifest } from "@smartflow/task-manifest";
import { createHostCanonicalTasksSource } from "../../../fixtures/task-manifest/test-fixture.js";

describe("Host canonical SmartFlow tasks", () => {
  it("compiles the documented canonical format at a request-isolated path", () => {
    const canonicalTaskPath = ".smartflow/tasks/request-1/tasks.md";
    const compiled = compileTaskManifest(createHostCanonicalTasksSource(), {
      projectId: "project-1",
      jobId: "job-1",
      canonicalTaskPath,
      providerRuntimeConfig: { endpoint: "https://provider.invalid", model: "test-model" },
      approval: {
        kind: "USER",
        approvedAt: "2026-08-25T00:00:00.000Z",
        authorizedCriterionIds: []
      }
    });

    expect(compiled.manifest.canonicalTaskPath).toBe(canonicalTaskPath);
    expect(compiled.manifest.enabledTaskIds).toEqual(["T001", "T002"]);
    expect(new Set(compiled.manifest.tasks.map((task) => task.id)).size).toBe(2);
    expect(compiled.manifest.tasks).toEqual([
      expect.objectContaining({
        id: "T001",
        module: "M01",
        parallel: false,
        filePaths: ["src/auth/login.ts"],
        acceptanceCriteria: [
          "valid users can log in and invalid passwords return an explicit error"
        ]
      }),
      expect.objectContaining({
        id: "T002",
        module: "M01",
        parallel: true,
        filePaths: ["src/auth/login.test.ts"],
        acceptanceCriteria: ["success and failure cases pass"]
      })
    ]);
    expect(compiled.manifest).not.toHaveProperty("revision");
    expect(compiled.manifest).not.toHaveProperty("revisionId");
  });
});
