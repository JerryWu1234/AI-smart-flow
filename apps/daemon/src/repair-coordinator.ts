import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import {
  assessRepairProgress,
  deriveRepairApproval,
  normalizeFinding,
  type Finding,
  type RepairRound
} from "@smartflow/review";
import { durableLeaderDecisionSchema, type RepairItem } from "@smartflow/protocol";
import { StateStore, type RunRecord } from "@smartflow/state-store";
import {
  compileTaskManifest,
  taskManifestSchema,
  type TaskManifest
} from "@smartflow/task-manifest";
import type { Candidate } from "@smartflow/workspace";

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

function reviewFindings(value: unknown): Finding[] {
  const gate = (value as { gate?: { result?: {
    convergeFindings?: unknown;
    adversarialFindings?: unknown;
  } } }).gate;
  const convergeSource = gate?.result?.convergeFindings;
  const adversarialSource = gate?.result?.adversarialFindings;
  const convergeFindings: unknown[] = Array.isArray(convergeSource)
    ? convergeSource.map<unknown>((entry: unknown) => entry)
    : [];
  const adversarialFindings: unknown[] = Array.isArray(adversarialSource)
    ? adversarialSource.map<unknown>((entry: unknown) => entry)
    : [];
  const entries = [
    ...convergeFindings,
    ...adversarialFindings
  ];
  return entries
    .map((entry) => normalizeFinding(entry as Parameters<typeof normalizeFinding>[0]));
}

function leaderRepairFinding(
  item: Extract<RepairItem, { source: "leader" }>,
  manifest: TaskManifest,
  decisionReason: string
): Finding {
  const task = manifest.tasks.find((candidate) => candidate.id === item.taskId);
  if (task === undefined) throw new Error("LEADER_REPAIR_TASK_UNKNOWN");
  const path = item.path ?? task.filePaths[0];
  if (path === undefined) throw new Error("REPAIR_TARGET_PATH_MISSING");
  return normalizeFinding({
    code: item.code,
    criterionId: item.taskId,
    path,
    severity: "P1",
    blocking: true,
    summary: item.reason,
    evidence: [`Leader decision: ${decisionReason}`]
  });
}

function parsePreviousRound(run: RunRecord): RepairRound | undefined {
  const value = run.recovery?.repairRound;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const round = value as Record<string, unknown>;
  if (
    !Array.isArray(round.failureIds) ||
    !Array.isArray(round.findings) ||
    typeof round.relevantPathHashes !== "object" ||
    round.relevantPathHashes === null
  ) return undefined;
  return value as unknown as RepairRound;
}

export class RepairCoordinator {
  private readonly mutations: ProjectMutationExecutor;

  public constructor(
    private readonly store: StateStore,
    private readonly providerRuntimeConfig: Readonly<Record<string, unknown>>
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
    let findings: Finding[] = [];
    const hasReviewDecision = run.review !== undefined;
    if (run.review !== undefined) {
      if (run.leaderDecision === undefined) throw new Error("REPAIR_LEADER_DECISION_MISSING");
      const reviewDecision = JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.review))
      ) as { reviewHash?: unknown };
      const leaderDecision = durableLeaderDecisionSchema.parse(JSON.parse(
        new TextDecoder().decode(await this.store.readArtifact(run.leaderDecision))
      ));
      if (
        leaderDecision.decision !== "repair" ||
        leaderDecision.reviewHash !== reviewDecision.reviewHash
      ) throw new Error("REPAIR_LEADER_DECISION_INVALID");
      const selectedFingerprints = new Set(
        leaderDecision.repairItems.flatMap((item) =>
          item.source === "reviewer" ? [item.findingFingerprint] : []
        )
      );
      const currentReviewFindings = reviewFindings(reviewDecision);
      if ([...selectedFingerprints].some(
        (fingerprint) => !currentReviewFindings.some((finding) => finding.fingerprint === fingerprint)
      )) throw new Error("REPAIR_FINDING_SELECTION_INVALID");
      findings = [
        ...currentReviewFindings.filter(
          (finding) => selectedFingerprints.has(finding.fingerprint)
        ).map((finding) => ({ ...finding, blocking: true })),
        ...leaderDecision.repairItems.flatMap((item) =>
          item.source === "leader"
            ? [leaderRepairFinding(item, parentManifest, leaderDecision.reason)]
            : []
        )
      ];
    }
    if (!hasReviewDecision && findings.length === 0 && run.lastError?.code === "WORKER_CANDIDATE_EMPTY") {
      const parent = parentManifest.tasks[0];
      if (parent === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
      failures.push("candidate:EMPTY:WORKER_CANDIDATE_EMPTY");
      findings = [normalizeFinding({
        code: "WORKER_CANDIDATE_EMPTY",
        criterionId: parent.id,
        path: parent.filePaths[0] ?? null,
        severity: "P1",
        blocking: true,
        summary: "Worker completed without a changed Candidate",
        evidence: [
          `candidate=${candidate.hash} allowNoChange=${String(parentManifest.allowNoChange)}`
        ]
      })];
    }
    if (!hasReviewDecision && findings.length === 0) {
      const parent = parentManifest.tasks[0];
      if (parent === undefined) throw new Error("REPAIR_PARENT_TASK_MISSING");
      findings = [normalizeFinding({
        code: "LEADER_REPAIR_REQUEST",
        criterionId: parent.id,
        path: parent.filePaths[0] ?? null,
        severity: "P1",
        blocking: true,
        summary: "Leader requested a corrective revision",
        evidence: ["durable Leader decision requested repair"]
      })];
    }
    const currentRound: RepairRound = {
      failureIds: failures,
      findings,
      relevantPathHashes: candidatePathHashes(candidate)
    };
    const previousRound = parsePreviousRound(run);
    const assessed = assessRepairProgress(
      previousRound ?? currentRound,
      currentRound,
      previousRound === undefined ? -1 : run.noProgressCount,
      { parentManifest, firstTaskNumber: nextTaskNumber(parentManifest) }
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
