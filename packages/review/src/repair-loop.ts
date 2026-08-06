import type { ManifestTask, TaskManifest } from "@smartflow/task-manifest";

import type { Finding } from "./finding.js";

export interface RepairRound {
  failureIds: string[];
  findings: Finding[];
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
  findingFingerprint: string;
}

function stableProblems(round: RepairRound): Set<string> {
  return new Set([
    ...round.failureIds.map((id) => `failure:${id}`),
    ...round.findings
      .filter((finding) => finding.blocking)
      .map((finding) => `finding:${finding.fingerprint}`)
  ]);
}

function isStrictSubset(current: Set<string>, previous: Set<string>): boolean {
  return current.size < previous.size && [...current].every((item) => previous.has(item));
}

function relevantPathsChanged(previous: RepairRound, current: RepairRound): boolean {
  const relevant = new Set(
    [...previous.findings, ...current.findings]
      .filter((finding) => finding.blocking)
      .map((finding) => finding.path)
      .filter((path): path is string => path !== null)
  );
  return [...relevant].some(
    (path) => previous.relevantPathHashes[path] !== current.relevantPathHashes[path]
  );
}

function criterionTaskId(criterionId: string): string | undefined {
  return /^(T\d{3,})/u.exec(criterionId)?.[1];
}

function taskForCriterion(manifest: TaskManifest, criterionId: string): ManifestTask | undefined {
  const taskId = criterionTaskId(criterionId);
  return manifest.tasks.find((task) => task.id === taskId);
}

function safeInline(value: string): string {
  return value.replace(/[\r\n`]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function repairTaskLine(
  manifest: TaskManifest,
  finding: Finding,
  taskNumber: number
): string {
  const criterionId = finding.criterionId ?? "UNMAPPED_CRITERION";
  const parentTask = taskForCriterion(manifest, criterionId) ?? manifest.tasks[0];
  if (parentTask === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
  const path = finding.path ?? parentTask.filePaths[0];
  if (path === undefined) throw new Error("REPAIR_TARGET_PATH_MISSING");
  const tags = `[${parentTask.module}]`;
  return `- [ ] T${String(taskNumber).padStart(3, "0")} ${tags} Repair \`${safeInline(path)}\` for ${safeInline(finding.code)} — 验收：${safeInline(finding.summary)}; parentRevision=${String(manifest.revision)}; criterionId=${safeInline(criterionId)}; findingFingerprint=${finding.fingerprint}`;
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
  const noBlockingProblems = previousProblems.size === 0 && currentProblems.size === 0;
  const noProgressCount = noBlockingProblems || (problemsReduced && pathsChanged)
    ? 0
    : existingNoProgressCount + 1;
  const uniqueFindings = new Map(
    current.findings
      .filter((finding) => finding.blocking)
      .map((finding) => [finding.fingerprint, finding] as const)
  );
  const firstTaskNumber = context.firstTaskNumber ?? 900;
  const repairTasks = [...uniqueFindings.values()].map((finding, index) =>
    repairTaskLine(context.parentManifest, finding, firstTaskNumber + index)
  );
  const authorizedCriterionIds = [...new Set(
    [...uniqueFindings.values()]
      .map((finding) => finding.criterionId)
      .filter((criterion): criterion is string => criterion !== null)
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
  const findingFingerprint = /(?:^|;)\s*findingFingerprint=([a-f0-9]{64})(?:;|$)/u.exec(text)?.[1];
  if (parentRevision === undefined || criterionId === undefined || findingFingerprint === undefined) {
    return undefined;
  }
  return {
    parentRevision: Number.parseInt(parentRevision, 10),
    criterionId,
    findingFingerprint
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

export function repairApprovalKind(
  previous: TaskManifest,
  proposed: TaskManifest
): "USER" | "LEADER_REPAIR" {
  return deriveRepairApproval(previous, proposed).kind;
}
