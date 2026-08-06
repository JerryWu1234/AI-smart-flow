import type { ParsedTask } from "./tasks-parser.js";
import type { TaskManifestErrorCode } from "./errors.js";

export interface ValidationIssue {
  code: TaskManifestErrorCode;
  message: string;
  taskId?: string;
}

export function validateTaskSelection(
  enabledTasks: readonly ParsedTask[],
  allowNoChange: boolean
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (enabledTasks.length === 0) {
    issues.push({ code: "TASKS_EMPTY", message: "At least one enabled, incomplete task is required" });
  }
  const taskIds = new Set<string>();
  for (const task of enabledTasks) {
    if (taskIds.has(task.id)) {
      issues.push({ code: "TASK_ID_DUPLICATE", message: `Duplicate Task ID: ${task.id}`, taskId: task.id });
    }
    taskIds.add(task.id);
    if (task.filePaths.length === 0) {
      issues.push({
        code: "TARGET_PATH_MISSING",
        message: `Task ${task.id} has no explicit target path`,
        taskId: task.id
      });
    }
    if (
      allowNoChange &&
      !task.acceptanceCriteria.some((criterion) => /(?:^|\s)no-change-allowed=true(?:\s|$)/iu.test(criterion))
    ) {
      issues.push({
        code: "NO_CHANGE_ALLOWANCE_UNBOUND",
        message: `Task ${task.id} must bind allowNoChange to an explicit no-change-allowed=true acceptance criterion`,
        taskId: task.id
      });
    }
  }
  return issues;
}
