import { describe, expect, it } from "vitest";

import { TaskManifestError } from "../../../../packages/task-manifest/src/errors.js";
import { createTasksSource } from "../../../fixtures/task-manifest/test-fixture.js";
import {
  parseTasksDocument,
  selectEnabledTasks
} from "../../../../packages/task-manifest/src/tasks-parser.js";

function expectErrorCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected parser to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskManifestError);
    expect((error as TaskManifestError).code).toBe(code);
  }
}

describe("tasks.md parser", () => {
  it("parses pure Markdown modules, checkboxes, paths, and acceptance criteria", () => {
    const parsed = parseTasksDocument(createTasksSource());
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed).not.toHaveProperty("metadata");
    expect(parsed.tasks[0]).toMatchObject({
      id: "T001",
      module: "M01",
      completed: false,
      parallel: true,
      filePaths: ["packages/core/src/index.ts"],
      acceptanceCriteria: ["core review passes"]
    });
    expect(selectEnabledTasks(parsed).map((task) => task.id)).toEqual(["T001"]);
  });

  it("selects every incomplete task without a YAML module allowlist", () => {
    const source = createTasksSource().replace("- [X] T002", "- [ ] T002");
    expect(selectEnabledTasks(parseTasksDocument(source)).map((task) => task.id)).toEqual([
      "T001",
      "T002"
    ]);
  });

  it("rejects legacy task metadata instead of silently ignoring it", () => {
    const source = [
      "```yaml",
      "taskManifestMetadata:",
      "  model: legacy",
      "```",
      "",
      createTasksSource()
    ].join("\n");
    expectErrorCode(() => parseTasksDocument(source), "TASKS_METADATA_UNSUPPORTED");
  });

  it("rejects missing and duplicate task IDs", () => {
    const missing = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] Edit `packages/a.ts` — 验收：pass"
    });
    expectErrorCode(() => parseTasksDocument(missing), "TASK_ID_MISSING");

    const duplicate = createTasksSource({
      tasks:
        "## M01 · Core\n\n- [ ] T001 Edit `packages/a.ts` — 验收：pass\n- [ ] T001 Edit `packages/b.ts` — 验收：pass"
    });
    expectErrorCode(() => parseTasksDocument(duplicate), "TASK_ID_DUPLICATE");
  });

  it("uses each task's module tag under legacy convergence and repair headings", () => {
    const source = createTasksSource({
      tasks: [
        "## Phase 14: Convergence",
        "",
        "- [ ] T101 [M01] Edit `packages/a.ts` — 验收：pass",
        "",
        "## Phase 15: Convergence",
        "",
        "- [ ] T102 [M12] Edit `packages/b.ts` — 验收：pass",
        "",
        "## Review Repair Tasks",
        "",
        "- [ ] T900 [M01] Edit `packages/a.ts` — 验收：repair"
      ].join("\n")
    });
    expect(parseTasksDocument(source).tasks.map(({ id, module }) => ({ id, module }))).toEqual([
      { id: "T101", module: "M01" },
      { id: "T102", module: "M12" },
      { id: "T900", module: "M01" }
    ]);
  });

  it("keeps explicit module ownership strict", () => {
    const mismatch = createTasksSource({
      tasks: "## M01 · Core\n\n- [ ] T001 [M12] Edit `packages/a.ts` — 验收：pass"
    });
    expectErrorCode(() => parseTasksDocument(mismatch), "TASK_MODULE_MISMATCH");

    const ambiguous = createTasksSource({
      tasks: "## Phase 14: Convergence\n\n- [ ] T101 [M01] [M12] Edit `packages/a.ts` — 验收：pass"
    });
    expectErrorCode(() => parseTasksDocument(ambiguous), "TASK_TAG_INVALID");
  });
});
