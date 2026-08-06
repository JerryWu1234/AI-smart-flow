import { describe, expect, it } from "vitest";

import {
  compileTaskManifest,
  type CompileTaskManifestOptions
} from "./task-manifest.js";
import { TaskManifestError } from "./errors.js";
import { createTasksSource } from "./test-fixture.js";

const options = {
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

function compileErrorCode(
  source: string,
  overrides: Partial<CompileTaskManifestOptions> = {}
): string {
  try {
    compileTaskManifest(source, { ...options, ...overrides });
    throw new Error("expected compiler to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskManifestError);
    return (error as TaskManifestError).code;
  }
}

describe("TaskManifest validator", () => {
  it("returns stable codes for empty tasks and missing target paths", () => {
    const completed = createTasksSource({
      tasks:
        "## M01 · Core\n\n- [X] T001 Edit `packages/core/src/index.ts` — 验收：pass"
    });
    expect(compileErrorCode(completed)).toBe("TASKS_EMPTY");
    const noPath = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 Improve the implementation — 验收：pass"
    });
    expect(compileErrorCode(noPath)).toBe("TARGET_PATH_MISSING");
  });
});
