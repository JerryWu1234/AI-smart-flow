import type { TaskReview } from "@smartflow/protocol";
import type { TaskManifest } from "@smartflow/task-manifest";

export interface RepairRound {
  failureIds: string[];
  tasks: TaskReview[];
  relevantPathHashes: Record<string, string>;
}

export interface RepairAssessment {
  noProgressCount: number;
  pauseRequired: boolean;
}

export interface RepairScopeAssessment {
  inScope: boolean;
  reasons: string[];
}

function stableProblems(round: RepairRound): Set<string> {
  return new Set([
    ...round.failureIds.map((id) => `failure:${id}`),
    ...round.tasks.flatMap((task) =>
      task.issues.map((issue) => `issue:${task.id}:${issue.path}`)
    )
  ]);
}

function isStrictSubset(current: Set<string>, previous: Set<string>): boolean {
  return current.size < previous.size && [...current].every((item) => previous.has(item));
}

function relevantPathsChanged(previous: RepairRound, current: RepairRound): boolean {
  const relevant = new Set(
    [...previous.tasks, ...current.tasks].flatMap((task) =>
      task.issues.map((issue) => issue.path)
    )
  );
  return [...relevant].some(
    (path) => previous.relevantPathHashes[path] !== current.relevantPathHashes[path]
  );
}

function safeInline(value: string): string {
  return value
    .replace(/[\r\n`]+/gu, " ")
    .replace(/;/gu, ",")
    .replace(/\s+/gu, " ")
    .trim();
}

function repairTaskLine(
  manifest: TaskManifest,
  task: TaskReview,
  issue: TaskReview["issues"][number],
  taskNumber: number
): string {
  const parentTask = manifest.tasks.find((candidate) => candidate.id === task.id);
  const module = parentTask?.module ?? manifest.tasks[0]?.module;
  if (module === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
  const suggestedFix = issue.suggestedFix;
  const guidance = suggestedFix === null
    ? safeInline(issue.message)
    : `${safeInline(issue.message)}; suggestion:${safeInline(suggestedFix)}`;
  return `- [ ] T${String(taskNumber).padStart(3, "0")} [${module}] Repair \`${safeInline(issue.path)}\` — Acceptance: ${guidance}; criterionId=${task.id}`;
}

export function assessRepairScope(
  manifest: TaskManifest,
  tasks: readonly TaskReview[]
): RepairScopeAssessment {
  const manifestTasks = new Map(manifest.tasks.map((task) => [task.id, task] as const));
  const reasons: string[] = [];
  for (const reviewTask of tasks) {
    const manifestTask = manifestTasks.get(reviewTask.id);
    if (manifestTask === undefined) {
      reasons.push(`REVIEW_TASK_OUT_OF_SCOPE:${reviewTask.id}`);
      continue;
    }
    for (const issue of reviewTask.issues) {
      if (!manifestTask.filePaths.includes(issue.path)) {
        reasons.push(`REVIEW_ISSUE_PATH_OUT_OF_SCOPE:${reviewTask.id}:${issue.path}`);
      }
    }
  }
  return { inScope: reasons.length === 0, reasons };
}

export function renderRepairTaskLines(
  manifest: TaskManifest,
  tasks: readonly TaskReview[],
  firstTaskNumber = 900
): string[] {
  const issues = tasks.flatMap((task) =>
    task.issues.map((issue) => ({ task, issue }))
  );
  return issues.map(({ task, issue }, index) =>
    repairTaskLine(manifest, task, issue, firstTaskNumber + index)
  );
}

export function renderRepairFeedback(tasks: readonly TaskReview[]): string {
  const issues = tasks.flatMap((task) => task.issues.map((issue) => ({ task, issue })));
  if (issues.length === 0) throw new Error("REPAIR_REVIEW_HAS_NO_ISSUES");
  return [
    "Continue working on the same approved task in the current workspace.",
    "",
    "The reviewer found these issues in your latest implementation:",
    "",
    ...issues.flatMap(({ task, issue }, index) => [
      ...(index === 0 ? [] : [""]),
      `Task ${task.id} — ${String(task.completionPercentage)}% complete`,
      `File: ${safeInline(issue.path)}`,
      `Problem: ${safeInline(issue.message)}`,
      ...(issue.suggestedFix === null
        ? []
        : [`Suggested fix: ${safeInline(issue.suggestedFix)}`])
    ]),
    "",
    "Fix all reported issues. Re-check the complete original task.md and stop when the implementation is ready for another review. Do not modify task.md."
  ].join("\n");
}

export function assessRepairProgress(
  previous: RepairRound,
  current: RepairRound,
  existingNoProgressCount: number,
  noProgressThreshold = 15
): RepairAssessment {
  const currentProblems = stableProblems(current);
  const previousProblems = stableProblems(previous);
  const problemsReduced = isStrictSubset(currentProblems, previousProblems);
  const pathsChanged = relevantPathsChanged(previous, current);
  const noProgressCount = currentProblems.size === 0 || problemsReduced || pathsChanged
    ? 0
    : existingNoProgressCount + 1;
  return {
    noProgressCount,
    pauseRequired: noProgressCount >= noProgressThreshold
  };
}
