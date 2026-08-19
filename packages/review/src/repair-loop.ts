import type { TaskReview } from "@smartflow/protocol";
import type { ManifestTask, TaskManifest } from "@smartflow/task-manifest";

export interface RepairRound {
  failureIds: string[];
  tasks: TaskReview[];
  relevantPathHashes: Record<string, string>;
}

export interface RepairTaskContext {
  parentManifest: TaskManifest;
  firstTaskNumber?: number;
  noProgressThreshold?: number;
}

export interface RepairAssessment {
  noProgressCount: number;
  pauseRequired: boolean;
  repairTasks: string[];
  authorizedCriterionIds: string[];
}

export interface DerivedRepairApproval {
  kind: "USER" | "LEADER_REPAIR";
  parentRevision: number | null;
  authorizedCriterionIds: string[];
  reasons: string[];
}

interface RepairBinding {
  parentRevision: number;
  criterionId: string;
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

function taskForCriterion(manifest: TaskManifest, criterionId: string): ManifestTask | undefined {
  return manifest.tasks.find((task) => task.id === criterionId);
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
  const parentTask = taskForCriterion(manifest, task.id);
  if (parentTask === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
  const guidance = issue.suggestedFix === undefined
    ? safeInline(issue.message)
    : `${safeInline(issue.message)}；建议：${safeInline(issue.suggestedFix)}`;
  return `- [ ] T${String(taskNumber).padStart(3, "0")} [${parentTask.module}] Repair \`${safeInline(issue.path)}\` — 验收：${guidance}; parentRevision=${String(manifest.revision)}; criterionId=${task.id}`;
}

export function assessRepairProgress(
  previous: RepairRound,
  current: RepairRound,
  existingNoProgressCount: number,
  context: RepairTaskContext
): RepairAssessment {
  const currentProblems = stableProblems(current);
  const previousProblems = stableProblems(previous);
  const problemsReduced = isStrictSubset(currentProblems, previousProblems);
  const pathsChanged = relevantPathsChanged(previous, current);
  const noProgressCount = currentProblems.size === 0 || problemsReduced || pathsChanged
    ? 0
    : existingNoProgressCount + 1;
  const issues = current.tasks.flatMap((task) =>
    task.issues.map((issue) => ({ task, issue }))
  );
  const firstTaskNumber = context.firstTaskNumber ?? 900;
  const repairTasks = issues.map(({ task, issue }, index) =>
    repairTaskLine(context.parentManifest, task, issue, firstTaskNumber + index)
  );
  const authorizedCriterionIds = [...new Set(
    current.tasks.filter((task) => task.issues.length > 0).map((task) => task.id)
  )].sort();
  return {
    noProgressCount,
    pauseRequired: noProgressCount >= (context.noProgressThreshold ?? 15),
    repairTasks,
    authorizedCriterionIds
  };
}

function repairBinding(task: ManifestTask): RepairBinding | undefined {
  const text = task.acceptanceCriteria.join("; ");
  const parentRevision = /(?:^|;)\s*parentRevision=(\d+)(?:;|$)/u.exec(text)?.[1];
  const criterionId = /(?:^|;)\s*criterionId=([^;]+)(?:;|$)/u.exec(text)?.[1]?.trim();
  if (parentRevision === undefined || criterionId === undefined) return undefined;
  return {
    parentRevision: Number.parseInt(parentRevision, 10),
    criterionId
  };
}

function same(valueA: unknown, valueB: unknown): boolean {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

export function deriveRepairApproval(
  previous: TaskManifest,
  proposed: TaskManifest
): DerivedRepairApproval {
  const reasons: string[] = [];
  if (proposed.revision !== previous.revision + 1) reasons.push("REVISION_NOT_NEXT");
  if (proposed.providerRuntimeConfigHash !== previous.providerRuntimeConfigHash) {
    reasons.push("PROVIDER_RUNTIME_CHANGED");
  }
  if (proposed.allowNoChange !== previous.allowNoChange) {
    reasons.push("NO_CHANGE_ALLOWANCE_CHANGED");
  }

  const authorizedCriterionIds = new Set<string>();
  const previousTasks = new Map(previous.tasks.map((task) => [task.id, task] as const));
  const proposedTaskIds = new Set(proposed.tasks.map((task) => task.id));
  for (const task of previous.tasks) {
    if (!proposedTaskIds.has(task.id)) reasons.push(`PARENT_TASK_REMOVED:${task.id}`);
  }
  for (const task of proposed.tasks) {
    const parentVersion = previousTasks.get(task.id);
    if (parentVersion !== undefined) {
      if (!same(task, parentVersion)) reasons.push(`PARENT_TASK_CHANGED:${task.id}`);
      continue;
    }
    const binding = repairBinding(task);
    if (binding === undefined) {
      reasons.push(`REPAIR_BINDING_MISSING:${task.id}`);
      continue;
    }
    authorizedCriterionIds.add(binding.criterionId);
    const parentTask = taskForCriterion(previous, binding.criterionId);
    if (binding.parentRevision !== previous.revision) {
      reasons.push(`PARENT_REVISION_MISMATCH:${task.id}`);
    }
    if (parentTask === undefined) {
      reasons.push(`CRITERION_OUT_OF_SCOPE:${task.id}`);
      continue;
    }
    if (
      task.module !== parentTask.module ||
      !task.filePaths.every((path) => parentTask.filePaths.includes(path))
    ) {
      reasons.push(`TASK_SCOPE_EXPANDED:${task.id}`);
    }
  }
  const kind = reasons.length === 0 && proposed.tasks.length > previous.tasks.length
    ? "LEADER_REPAIR"
    : "USER";
  return {
    kind,
    parentRevision: kind === "LEADER_REPAIR" ? previous.revision : null,
    authorizedCriterionIds: kind === "LEADER_REPAIR" ? [...authorizedCriterionIds].sort() : [],
    reasons
  };
}
