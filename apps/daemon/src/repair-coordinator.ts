import { relative, sep } from "node:path";

import {
  assessRepairProgress,
  assessRepairScope,
  renderRepairFeedback,
  renderRepairTaskLines,
  type RepairRound
} from "@smartflow/review";
import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  type TaskReview
} from "@smartflow/protocol";
import { StateStore, type RunRecord } from "@smartflow/state-store";
import {
  sha256Bytes,
  taskManifestSchema,
  type TaskManifest
} from "@smartflow/task-manifest";
import { getCandidateHash, type Candidate } from "@smartflow/workspace";

import { ProjectMutationExecutor } from "./project-mutation-executor.js";

export type RepairPreparationResult =
  | {
      phase: "PREPARING";
      prompt: string;
      resumeSession: {
        sourceAttemptId: string;
        expectedPiSessionId: string;
        sessionArtifact: NonNullable<RunRecord["workerAttempts"][number]["sessionArtifact"]>;
      };
    }
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
          message: "The current Candidate requires a corrective pass",
          suggestedFix: "Implement the approved task acceptance criteria in the named file"
        }]
      }];
    }
    const currentRound: RepairRound = {
      failureIds: failures,
      tasks,
      relevantPathHashes: candidatePathHashes(candidate)
    };
    const scope = assessRepairScope(parentManifest, tasks);
    if (!scope.inScope) {
      const repairModule = parentManifest.tasks[0]?.module;
      if (repairModule === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
      const addedTaskLines = renderRepairTaskLines(
        parentManifest,
        tasks,
        nextTaskNumber(parentManifest)
      );
      const appendText = [
        "",
        "",
        `## Review Follow-up Tasks · ${repairModule}`,
        "",
        ...addedTaskLines,
        ""
      ].join("\n");
      const parentSource = new TextDecoder().decode(
        await this.store.readArtifact(run.taskSource)
      );
      const repairSource = `${parentSource.trimEnd()}${appendText}`;
      const repairSourceBytes = Buffer.from(repairSource, "utf8");
      const draftHash = sha256Bytes(repairSourceBytes);
      const sourceArtifact = await this.store.writeArtifact(
        `runs/${jobId}/repair-drafts/${draftHash}.md`,
        repairSourceBytes
      );
      const projectRelativePath = relative(state.canonicalProjectRoot, run.canonicalTaskPath)
        .split(sep)
        .join("/");
      await this.pause(
        run,
        currentRound,
        run.noProgressCount,
        "REPAIR_USER_APPROVAL_REQUIRED",
        {
          repairDraft: {
            sourceArtifact,
            sourceHash: draftHash,
            baseTaskSourceHash: parentManifest.sourceHash,
            baseTaskManifestHash: run.taskManifest.sha256.replace(/^sha256:/u, ""),
            suggestedTasksPath: projectRelativePath,
            appendText,
            addedTaskLines,
            reasons: scope.reasons
          },
          repairRound: currentRound,
          untrustedSeedCandidate: run.candidate
        }
      );
      return { phase: "PAUSED", code: "REPAIR_USER_APPROVAL_REQUIRED" };
    }

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

    const attempt = run.workerAttempts.at(-1);
    if (
      attempt === undefined ||
      attempt.status !== "COMPLETED" ||
      attempt.piSessionId === undefined ||
      attempt.sessionArtifact === undefined
    ) {
      throw new Error("REPAIR_PI_SESSION_MISSING");
    }
    const prompt = renderRepairFeedback(tasks);
    const mutation = await this.mutations.mutate(
      {
        requestId: `repair:${run.jobId}:a${attempt.attemptId}:g${String(attempt.generation)}:continue:${run.candidate.sha256}`,
        payload: {
          kind: "continue-in-scope-repair",
          round: currentRound,
          noProgressCount: assessed.noProgressCount
        },
        expectedJobId: run.jobId,
        expectedFence: run.fence,
        expectedGeneration: attempt.generation,
        expectedAttemptId: attempt.attemptId,
        expectedPhases: ["FIXING"]
      },
      (current) => {
        const active = current.runs[run.jobId];
        if (active === undefined || active.phase !== "FIXING") {
          throw new Error("REPAIR_RUN_CHANGED");
        }
        const activeAttempt = active.workerAttempts.at(-1);
        const currentWorkspace = active.gitWorkspace?.current;
        if (
          activeAttempt === undefined ||
          activeAttempt.attemptId !== attempt.attemptId ||
          activeAttempt.generation !== attempt.generation ||
          activeAttempt.piSessionId === undefined ||
          activeAttempt.piSessionId !== attempt.piSessionId ||
          activeAttempt.sessionArtifact === undefined ||
          currentWorkspace?.resultSnapshot === undefined ||
          active.gitWorkspace === undefined
        ) {
          throw new Error("REPAIR_CONTEXT_CHANGED");
        }
        const expectedPiSessionId = activeAttempt.piSessionId;
        const sessionArtifact = activeAttempt.sessionArtifact;
        const workspaceSeedSnapshot = currentWorkspace.resultSnapshot;
        const updatedAt = new Date().toISOString();
        const nextRun: RunRecord = {
          ...active,
          phase: "PREPARING",
          noProgressCount: assessed.noProgressCount,
          candidate: undefined,
          pendingAction: undefined,
          hostTurn: undefined,
          review: undefined,
          leaderDecision: undefined,
          publish: undefined,
          pause: undefined,
          lastError: undefined,
          recovery: {
            repairRound: currentRound,
            repairContinuation: {
              kind: "PI_SESSION_REPAIR",
              jobId: active.jobId,
              sourceAttemptId: activeAttempt.attemptId,
              sourceGeneration: activeAttempt.generation,
              expectedPiSessionId,
              sessionArtifact,
              providerRuntimeConfigHash: activeAttempt.providerRuntimeConfigHash,
              taskSourceHash: active.taskSource.sha256.replace(/^sha256:/u, ""),
              taskManifestHash: active.taskManifest.sha256.replace(/^sha256:/u, ""),
              prompt,
              workspaceSeedSnapshot
            }
          },
          gitWorkspace: {
            ...active.gitWorkspace,
            current: {
              indexPath: currentWorkspace.indexPath,
              workspacePath: currentWorkspace.workspacePath,
              inputSnapshot: workspaceSeedSnapshot
            }
          },
          updatedAt
        };
        return {
          nextState: {
            ...current,
            runs: { ...current.runs, [run.jobId]: nextRun }
          },
          response: {
            phase: "PREPARING" as const,
            prompt,
            resumeSession: {
              sourceAttemptId: activeAttempt.attemptId,
              expectedPiSessionId,
              sessionArtifact
            }
          }
        };
      }
    );
    return mutation.response;
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
        requestId: `repair:${run.jobId}:a${attempt?.attemptId ?? "none"}:pause:${code}:${String(noProgressCount)}`,
        payload: { round, noProgressCount, code, details },
        expectedJobId: run.jobId,
        expectedFence: run.fence,
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
                    ? ["inspect_repair_diff", "cancel"]
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
