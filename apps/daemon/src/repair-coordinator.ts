import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import {
  assessRepairProgress,
  deriveRepairApproval,
  type RepairRound
} from "@smartflow/review";
import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  type TaskReview
} from "@smartflow/protocol";
import { StateStore, type RunRecord } from "@smartflow/state-store";
import {
  compileTaskManifest,
  taskManifestSchema,
  type TaskManifest
} from "@smartflow/task-manifest";
import { getCandidateHash, type Candidate } from "@smartflow/workspace";

import { createApprovedRevision } from "./approved-revision.js";
import { ProjectMutationExecutor } from "./project-mutation-executor.js";

export type RepairPreparationResult =
  | { phase: "PREPARING"; revision: number }
  | {
      phase: "PAUSED";
      code: "REPAIR_NO_PROGRESS" | "REPAIR_USER_APPROVAL_REQUIRED";
    };

function nextTaskNumber(manifest: TaskManifest): number {
  return manifest.tasks.reduce((maximum, task) => {
    const value = Number.parseInt(task.id.replace(/^T/u, ""), 10);
    return Number.isSafeInteger(value) ? Math.max(maximum, value) : maximum;
  }, 0) + 1;
}

function candidatePathHashes(candidate: Candidate): Record<string, string> {
  return Object.fromEntries(candidate.operations.map((operation) => [
    operation.path,
    "newEntry" in operation ? operation.newEntry.sha256 : "DELETED"
  ]));
}

function parsePreviousRound(run: RunRecord): RepairRound | undefined {
  const value = run.recovery?.repairRound;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const round = value as Record<string, unknown>;
  if (
    !Array.isArray(round.failureIds) ||
    !Array.isArray(round.tasks) ||
    typeof round.relevantPathHashes !== "object" ||
    round.relevantPathHashes === null
  ) return undefined;
  return value as unknown as RepairRound;
}

export class RepairCoordinator {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly providerRuntimeConfig: Readonly<Record<string, unknown>>,
    private readonly noProgressThreshold = 15
  ) {
    this.mutations = new ProjectMutationExecutor(store);
  }

  public async prepare(jobId: string): Promise<RepairPreparationResult> {
    const state = await this.store.readState();
    const run = state.runs[jobId];
    if (
      run === undefined ||
      state.activeRunsByTaskPath[run.canonicalTaskPath] !== jobId ||
      run.phase !== "FIXING"
    ) {
      throw new Error("REPAIR_RUN_NOT_READY");
    }
    const parentManifest = taskManifestSchema.parse(JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.taskManifest))
    ));
    if (run.candidate === undefined) throw new Error("REPAIR_CANDIDATE_MISSING");
    const candidate = JSON.parse(
      new TextDecoder().decode(await this.store.readArtifact(run.candidate))
    ) as Candidate;
    const failures: string[] = [];
    let tasks: TaskReview[] = [];
    const hasReviewDecision = run.review !== undefined;
    if (run.review !== undefined) {
      if (run.leaderDecision === undefined) throw new Error("REPAIR_LEADER_DECISION_MISSING");
      const reviewDecision = durableReviewDecisionSchema.parse(JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.review))
      ));
      const leaderDecision = durableLeaderDecisionSchema.parse(JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.leaderDecision))
      ));
      if (
        leaderDecision.decision !== "repair" ||
        leaderDecision.reviewHash !== reviewDecision.reviewHash ||
        !reviewDecision.gate.allowedLeaderDecisions.includes("repair")
      ) throw new Error("REPAIR_LEADER_DECISION_INVALID");
      tasks = reviewDecision.gate.result.tasks;
      if (!tasks.some((task) => task.issues.length > 0)) {
        throw new Error("REPAIR_REVIEW_HAS_NO_ISSUES");
      }
    }
    if (!hasReviewDecision && tasks.length === 0 && run.lastError?.code === "WORKER_CANDIDATE_EMPTY") {
      const parent = parentManifest.tasks[0];
      const path = parent?.filePaths[0];
      if (parent === undefined || path === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
      failures.push("candidate:EMPTY:WORKER_CANDIDATE_EMPTY");
      tasks = [{
        id: parent.id,
        completionPercentage: 0,
        issues: [{
          path,
          message: "Worker completed without producing a changed Candidate",
          suggestedFix: `Change the task implementation so Candidate ${getCandidateHash(candidate)} contains the required file update`
        }]
      }];
    }
    if (!hasReviewDecision && tasks.length === 0) {
      const parent = parentManifest.tasks[0];
      const path = parent?.filePaths[0];
      if (parent === undefined || path === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
      tasks = [{
        id: parent.id,
        completionPercentage: 0,
        issues: [{
          path,
          message: "The current Candidate requires a corrective revision",
          suggestedFix: "Implement the approved task acceptance criteria in the named file"
        }]
      }];
    }
    const currentRound: RepairRound = {
      failureIds: failures,
      tasks,
      relevantPathHashes: candidatePathHashes(candidate)
    };
    const previousRound = parsePreviousRound(run);
    const assessed = assessRepairProgress(
      previousRound ?? currentRound,
      currentRound,
      previousRound === undefined ? -1 : run.noProgressCount,
      {
        parentManifest,
        firstTaskNumber: nextTaskNumber(parentManifest),
        noProgressThreshold: this.noProgressThreshold
      }
    );
    if (assessed.pauseRequired) {
      await this.pause(run, currentRound, assessed.noProgressCount, "REPAIR_NO_PROGRESS");
      return { phase: "PAUSED", code: "REPAIR_NO_PROGRESS" };
    }

    const approvedSourcePath = run.approvedTasks?.path;
    if (typeof approvedSourcePath !== "string") throw new Error("REPAIR_APPROVED_SOURCE_MISSING");
    const repairModule = parentManifest.tasks[0]?.module;
    if (repairModule === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
    const parentSource = await readFile(approvedSourcePath, "utf8");
    const appendText = [
      "",
      "",
      `## Review Repair Tasks · ${repairModule} · Revision ${String(run.revision + 1)}`,
      "",
      ...assessed.repairTasks,
      ""
    ].join("\n");
    const repairSource = `${parentSource.trimEnd()}${appendText}`;
    const provisional = compileTaskManifest(repairSource, {
      projectId: state.projectId,
      jobId,
      revision: run.revision + 1,
      canonicalTaskPath: parentManifest.canonicalTaskPath,
      providerRuntimeConfig: this.providerRuntimeConfig,
      allowNoChange: parentManifest.allowNoChange,
      approval: {
        kind: "LEADER_REPAIR",
        approvedAt: new Date().toISOString(),
        parentRevision: run.revision,
        authorizedCriterionIds: assessed.authorizedCriterionIds
      }
    });
    const derived = deriveRepairApproval(parentManifest, provisional.manifest);
    if (derived.kind === "LEADER_REPAIR") {
      const attempt = run.workerAttempts.at(-1);
      const approval = {
        kind: "LEADER_REPAIR" as const,
        parentRevision: derived.parentRevision,
        authorizedCriterionIds: derived.authorizedCriterionIds
      };
      const mutation = await this.mutations.mutate(
        {
          requestId: `repair:${run.jobId}:r${String(run.revision)}:apply:${provisional.manifest.sourceHash}`,
          payload: {
            kind: "apply-approved-repair",
            sourceHash: provisional.manifest.sourceHash,
            approval,
            round: currentRound,
            noProgressCount: assessed.noProgressCount
          },
          expectedJobId: run.jobId,
          expectedFence: run.fence,
          expectedRevision: run.revision,
          ...(attempt === undefined ? {} : { expectedGeneration: attempt.generation }),
          ...(attempt === undefined ? {} : { expectedAttemptId: attempt.attemptId }),
          expectedPhases: ["FIXING"]
        },
        async (current) => {
          const active = current.runs[run.jobId];
          if (active === undefined || active.phase !== "FIXING") {
            throw new Error("REPAIR_RUN_CHANGED");
          }
          const repairRun: RunRecord = {
            ...active,
            noProgressCount: assessed.noProgressCount,
            recovery: {
              ...active.recovery,
              repairRound: currentRound,
              parentRevision: active.revision,
              untrustedSeedCandidate: active.candidate
            }
          };
          const nextRun = await createApprovedRevision({
            store: this.store,
            state: current,
            run: repairRun,
            sourceBytes: Buffer.from(repairSource, "utf8"),
            sourcePath: active.canonicalTaskPath,
            expectedSourceHash: provisional.manifest.sourceHash,
            approval,
            providerRuntimeConfig: this.providerRuntimeConfig,
            fail: (code, message): never => {
              throw new Error(`${code}:${message}`);
            }
          });
          return {
            nextState: {
              ...current,
              runs: { ...current.runs, [run.jobId]: nextRun }
            },
            response: { phase: "PREPARING" as const, revision: nextRun.revision }
          };
        }
      );
      return mutation.response;
    }

    const sourceArtifact = await this.store.writeArtifact(
      `runs/${jobId}/revision-${String(run.revision + 1)}/repair-drafts/${provisional.manifest.sourceHash}.md`,
      Buffer.from(repairSource, "utf8")
    );
    const projectRelativePath = relative(state.canonicalProjectRoot, run.canonicalTaskPath)
      .split(sep)
      .join("/");
    await this.pause(
      run,
      currentRound,
      assessed.noProgressCount,
      "REPAIR_USER_APPROVAL_REQUIRED",
      {
        repairDraft: {
          sourceArtifact,
          sourceHash: provisional.manifest.sourceHash,
          suggestedTasksPath: projectRelativePath,
          appendText,
          addedTaskLines: assessed.repairTasks,
          reasons: derived.reasons,
          approval: {
            kind: derived.kind,
            parentRevision: derived.parentRevision,
            authorizedCriterionIds: derived.authorizedCriterionIds
          }
        },
        repairRound: currentRound,
        parentRevision: run.revision,
        untrustedSeedCandidate: run.candidate
      }
    );
    return { phase: "PAUSED", code: "REPAIR_USER_APPROVAL_REQUIRED" };
  }

  private async pause(
    run: RunRecord,
    round: RepairRound,
    noProgressCount: number,
    code: "REPAIR_NO_PROGRESS" | "REPAIR_USER_APPROVAL_REQUIRED",
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const attempt = run.workerAttempts.at(-1);
    await this.mutations.mutate(
      {
        requestId: `repair:${run.jobId}:r${String(run.revision)}:pause:${code}:${String(noProgressCount)}`,
        payload: { round, noProgressCount, code, details },
        expectedJobId: run.jobId,
        expectedFence: run.fence,
        expectedRevision: run.revision,
        ...(attempt === undefined
          ? {}
          : { expectedGeneration: attempt.generation }),
        ...(attempt === undefined ? {} : { expectedAttemptId: attempt.attemptId }),
        expectedPhases: ["FIXING"]
      },
      (state) => {
        const active = state.runs[run.jobId];
        if (active === undefined || active.phase !== "FIXING") throw new Error("REPAIR_RUN_CHANGED");
        const updatedAt = new Date().toISOString();
        return {
          nextState: {
            ...state,
            runs: {
              ...state.runs,
              [run.jobId]: {
                ...active,
                phase: "PAUSED",
                noProgressCount,
                pause: {
                  code,
                  resumeActions: code === "REPAIR_USER_APPROVAL_REQUIRED"
                    ? ["inspect_repair_diff", "approve_new_manifest_revision", "cancel"]
                    : ["inspect_no_progress", "cancel"]
                },
                recovery: { ...active.recovery, repairRound: round, ...details },
                updatedAt
              }
            }
          },
          response: { phase: "PAUSED", code, noProgressCount }
        };
      }
    );
  }
}
