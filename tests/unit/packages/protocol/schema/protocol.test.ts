import { describe, expect, it } from "vitest";

import {
  daemonExecuteInputSchema,
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  executeInputSchema,
  hostActionSchema,
  piWorkerAttemptSchema,
  publicPiWorkerAttemptSchema,
  publishResultSchema,
  resumeInputSchema,
  reviewResultSchema,
  reviewTurnInputSchema,
  reviewTurnOutputSchema,
  runPhaseSchema,
  statusInputSchema,
  statusOutputSchema
} from "../../../../../packages/protocol/src/index.js";

const digest = "a".repeat(64);

describe("SmartFlow protocol schemas", () => {
  it("projects a compact review turn and keeps Daemon bookkeeping off the wire", () => {
    const pausedResult = {
      projectId: "project-1",
      jobId: "job-1",
      phase: "PAUSED" as const,
      status: "PAUSED" as const,
      artifacts: [],
      nextActions: ["cancel"]
    };

    const notReady = {
      kind: "NOT_READY" as const,
      retryAfterMs: 30_000
    };
    expect(reviewTurnOutputSchema.parse(notReady)).toEqual(notReady);
    expect(reviewTurnOutputSchema.safeParse({
      ...notReady,
      worktreePath: "/private/run-worktree"
    }).success).toBe(false);

    expect(reviewTurnOutputSchema.safeParse({
      kind: "REVIEW_REQUIRED",
      turnToken: "turn-1",
      reviewerSession: { mode: "CREATE" },
      worktreePath: "/private/run-worktree",
      tasksPath: "specs/tasks.md",
      taskIds: ["T001", "T002"],
      changedPaths: ["src/a.ts"],
      deadlineAt: "2026-08-11T12:30:00+00:00"
    }).success).toBe(false);
    // Daemon bookkeeping and Reviewer identity must not appear on the Host-visible wire.
    for (const leak of [
      { projectId: "project-1" },
      { jobId: "job-1" },
      { revision: 1 },
      { stateVersion: 3 },
      { reviewAttemptId: "review-attempt-1" },
      { taskSourceHash: digest },
      { candidateHash: digest },
      { piSessionId: "pi-session-1" },
      { reviewerSession: { mode: "CREATE" } },
      { worktreePath: "/private/run-worktree" }
    ]) {
      expect(reviewTurnOutputSchema.safeParse({ ...notReady, ...leak }).success).toBe(false);
    }

    const userInput = {
      kind: "USER_INPUT_REQUIRED" as const,
      turnToken: "turn-2",
      pause: { code: "REPAIR_NO_PROGRESS", message: "User action required" },
      result: pausedResult,
      options: [{ answer: "cancel" as const, description: "Cancel the run" }]
    };
    expect(reviewTurnOutputSchema.parse(userInput)).toEqual(userInput);
    expect(reviewTurnOutputSchema.safeParse({
      ...userInput,
      worktreePath: "/private/run-worktree"
    }).success).toBe(false);
    // The recorded Review rides the shared result projection, never a second copy.
    const reviewedPause = {
      ...userInput,
      result: {
        ...pausedResult,
        review: {
          tasks: [{
            id: "T001",
            completionPercentage: 40,
            issues: [{ path: "src/a.ts", message: "unmet", suggestedFix: null }]
          }]
        }
      }
    };
    expect(reviewTurnOutputSchema.parse(reviewedPause)).toEqual(reviewedPause);
    expect(reviewTurnOutputSchema.safeParse({
      ...userInput,
      review: { tasks: [{ id: "T001", completionPercentage: 100, issues: [] }] }
    }).success).toBe(false);
    // Unroutable inspect_* pseudo-actions are gone from the wire.
    expect(reviewTurnOutputSchema.safeParse({
      ...userInput,
      inspectionOptions: []
    }).success).toBe(false);
    expect(reviewTurnOutputSchema.safeParse({
      ...userInput,
      options: [{ answer: "inspect_conflict", description: "Inspect" }]
    }).success).toBe(false);

    const publishUserInput = {
      ...userInput,
      turnToken: "turn-publish",
      pause: { code: "PUBLISH_PRECHECK_CONFLICT", message: "Publish conflict" },
      result: {
        ...pausedResult,
        status: "PRECHECK_CONFLICT" as const,
        nextActions: ["retry_publish", "confirm_manual_publish", "cancel"]
      },
      options: [
        { answer: "retry_publish" as const, description: "Retry publish" },
        { answer: "confirm_manual_publish" as const, description: "Confirm target state" },
        { answer: "cancel" as const, description: "Cancel the run" }
      ],
      worktreePath: "/private/run-worktree"
    };
    expect(reviewTurnOutputSchema.parse(publishUserInput)).toEqual(publishUserInput);

    const repairDraft = {
      sourceArtifact: {
        relativePath: `runs/job-1/repair-drafts/${digest}.md`,
        sha256: digest,
        size: 10
      },
      sourceHash: digest,
      baseTaskSourceHash: "b".repeat(64),
      baseTaskManifestHash: "c".repeat(64),
      suggestedTasksPath: "tasks.md",
      appendText: "repair task",
      addedTaskLines: ["- [ ] T002 repair"],
      reasons: ["scope change"]
    };
    const repairPause = {
      kind: "USER_INPUT_REQUIRED" as const,
      turnToken: "turn-user",
      pause: { code: "REPAIR_USER_APPROVAL_REQUIRED", message: "Approval required" },
      result: {
        ...pausedResult,
        nextActions: ["cancel"],
        repairDraft
      },
      options: [
        { answer: "cancel" as const, description: "Cancel this Job before starting a new one" }
      ]
    };
    expect(reviewTurnOutputSchema.parse(repairPause)).toEqual(repairPause);
    // The repair draft is carried once, inside result.
    expect(reviewTurnOutputSchema.safeParse({ ...repairPause, repairDraft }).success).toBe(false);

    const removedManifestApprovalAnswer = {
      action: "approve_new_manifest_revision" as const,
      tasksPath: "tasks.md",
      expectedStateVersion: 0
    };
    expect(reviewTurnOutputSchema.safeParse({
      ...repairPause,
      options: [
        { answer: "approve_new_manifest_revision", description: "Approve replacement" },
        { answer: "cancel", description: "Cancel" }
      ]
    }).success).toBe(false);
    expect(reviewTurnOutputSchema.safeParse({
      ...repairPause,
      requiredInput: {
        mode: "CONFIRM",
        action: "approve_new_manifest_revision",
        answer: removedManifestApprovalAnswer
      }
    }).success).toBe(false);

    const inspectionActions = [
      "inspect_processes",
      "inspect_recovery",
      "inspect_conflict",
      "inspect_repair_diff",
      "inspect_no_progress"
    ] as const;
    const resumeInput = {
      requestId: "resume-request-1",
      projectId: "project-1",
      jobId: "job-1"
    };
    expect(resumeInputSchema.safeParse({
      ...resumeInput,
      resumeAction: "cancel"
    }).success).toBe(true);
    expect(resumeInputSchema.safeParse({
      ...resumeInput,
      expectedStateVersion: 3,
      resumeAction: "cancel"
    }).success).toBe(false);
    expect(resumeInputSchema.safeParse({
      ...resumeInput,
      expectedRevision: 1,
      resumeAction: "cancel"
    }).success).toBe(false);
    for (const resumeAction of [
      "resume",
      "leader_append_repair_tasks",
      ...inspectionActions
    ]) {
      expect(resumeInputSchema.safeParse({
        ...resumeInput,
        resumeAction
      }).success).toBe(false);
    }

    const baseInput = {
      requestId: "review-turn-request-1",
      projectId: "project-1",
      jobId: "job-1",
      hostTurnId: "host-turn-1",
      turnToken: "turn-1"
    };
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      review: {
        reviewerSessionId: "reviewer-1",
        result: {
          tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
        }
      }
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: "approve_new_manifest_revision"
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: {
        action: "approve_new_manifest_revision",
        tasksPath: "tasks.md"
      }
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: "inspect_conflict"
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: "confirm_manual_publish"
    }).success).toBe(true);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: removedManifestApprovalAnswer
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: "cancel",
      reviewUnavailableReason: "reviewer failed"
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      turnToken: undefined,
      reviewUnavailableReason: "reviewer failed"
    }).success).toBe(false);
  });

  it("separates internal Pi session state from the public Attempt schema", () => {
    const attempt = {
      attemptId: "attempt-1",
      generation: 0,
      providerRuntimeConfigHash: digest,
      status: "RUNNING" as const,
      piSessionId: "pi-session-1",
      containmentId: "containment-1",
      processIdentity: { pid: 123, startToken: "123:started" },
      startedAt: "2026-08-04T00:00:00Z"
    };
    expect(piWorkerAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(piWorkerAttemptSchema.safeParse({
      ...attempt,
      status: "TIMED_OUT",
      endedAt: "2026-08-04T00:01:00Z"
    }).success).toBe(true);
    expect(piWorkerAttemptSchema.safeParse({
      ...attempt,
      brokerSession: { status: "ACTIVE" }
    }).success).toBe(false);

    const publicCompletedAttempt = {
      attemptId: attempt.attemptId,
      generation: attempt.generation,
      providerRuntimeConfigHash: attempt.providerRuntimeConfigHash,
      status: "COMPLETED" as const,
      piSessionId: attempt.piSessionId,
      containmentId: attempt.containmentId,
      processIdentity: attempt.processIdentity,
      startedAt: attempt.startedAt,
      endedAt: "2026-08-04T00:01:00Z"
    };
    const sessionArtifact = {
      relativePath: "runs/job-1/attempts/attempt-1/session-artifact.json",
      sha256: "b".repeat(64),
      size: 128
    };
    expect(piWorkerAttemptSchema.safeParse(publicCompletedAttempt).success).toBe(false);
    expect(piWorkerAttemptSchema.safeParse({
      ...publicCompletedAttempt,
      sessionArtifact
    }).success).toBe(true);
    expect(publicPiWorkerAttemptSchema.safeParse(publicCompletedAttempt).success).toBe(true);
    expect(publicPiWorkerAttemptSchema.safeParse({
      ...publicCompletedAttempt,
      sessionArtifact
    }).success).toBe(false);
    expect(statusOutputSchema.safeParse({
      projectId: "project-1",
      jobId: "job-1",
      phase: "RUNNING",
      stateVersion: 1,
      activeAttempt: { ...publicCompletedAttempt, sessionArtifact }
    }).success).toBe(false);
  });

  it("rejects unknown input fields", () => {
    expect(() =>
      statusInputSchema.parse({ projectId: "p1", jobId: "j1", hidden: true })
    ).toThrow();
  });

  it("rejects unknown run states", () => {
    expect(() => runPhaseSchema.parse("SUCCEEDED")).toThrow();
  });

  it("rejects invalid discriminated action variants", () => {
    expect(() =>
      hostActionSchema.parse({
        type: "REVIEW",
        actionId: "a1",
        effectHash: "not-a-review-context",
        expiresAt: "2026-07-20T00:00:00Z"
      })
    ).toThrow();
  });

  it("models CREATE and RESUME Review actions bound to task source and Candidate", () => {
    const action = {
      type: "REVIEW",
      actionId: "action-1",
      taskSourceHash: digest,
      candidateHash: digest,
      reviewAttemptId: "review-attempt-1",
      changedPaths: ["src/a.ts"],
      reviewerSession: { mode: "CREATE" },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T00:00:00Z"
    };
    expect(hostActionSchema.parse(action)).toEqual(action);
    expect(hostActionSchema.parse({
      ...action,
      reviewerSession: { mode: "RESUME", reviewerSessionId: "reviewer-1" }
    })).toBeDefined();
    expect(hostActionSchema.safeParse({
      ...action,
      reviewerSession: { mode: "RESUME" }
    }).success).toBe(false);
    expect(hostActionSchema.safeParse({
      ...action,
      worktreePath: "/private/run-worktree"
    }).success).toBe(false);
  });

  it("accepts nested Task issues and enforces completion consistency", () => {
    const review = {
      tasks: [{
        id: "T001",
        completionPercentage: 75,
        issues: [{
          path: "src/a.ts",
          message: "parseInput fails to reject an empty value",
          suggestedFix: "Add the missing guard in parseInput"
        }]
      }]
    };
    expect(reviewResultSchema.safeParse(review).success).toBe(true);
    expect(reviewResultSchema.safeParse({
      tasks: [{ ...review.tasks[0], completionPercentage: 101 }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{ ...review.tasks[0], completionPercentage: 75.5 }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{ id: "T001", completionPercentage: 100, issues: review.tasks[0]?.issues }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{ id: "T001", completionPercentage: 75, issues: [] }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{
        ...review.tasks[0],
        issues: [{ ...review.tasks[0]?.issues[0], path: "../src/a.ts" }]
      }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{
        ...review.tasks[0],
        issues: [
          review.tasks[0]?.issues[0],
          review.tasks[0]?.issues[0]
        ]
      }]
    }).success).toBe(false);
    expect(reviewResultSchema.safeParse({
      tasks: [{
        ...review.tasks[0],
        issues: [{ ...review.tasks[0]?.issues[0], unexpected: digest }]
      }]
    }).success).toBe(false);
  });

  it("exposes execute as a strict zero-argument public input", () => {
    expect(executeInputSchema.parse({})).toEqual({});
    for (const extra of [
      { projectRoot: "/tmp/project" },
      { tasksPath: "tasks.md" },
      { unexpected: true },
      { requestId: "req-1" },
      { expectedStateVersion: 0 }
    ]) {
      expect(executeInputSchema.safeParse(extra).success).toBe(false);
    }
  });

  it("requires internal execute routing and idempotency fields", () => {
    const request = {
      projectRoot: "/tmp/project",
      tasksPath: "tasks.md",
      requestId: "req-1"
    };
    expect(daemonExecuteInputSchema.parse(request)).toEqual(request);
    expect(daemonExecuteInputSchema.safeParse({
      projectRoot: request.projectRoot,
      tasksPath: request.tasksPath
    }).success).toBe(false);
    expect(daemonExecuteInputSchema.safeParse({
      ...request,
      unexpected: true
    }).success).toBe(false);
  });

  it("requires internal tasksPath to be relative and free of parent traversal", () => {
    const base = {
      projectRoot: "/tmp/project",
      requestId: "req-path"
    };
    for (const tasksPath of [
      "/tmp/project/tasks.md",
      "C:\\project\\tasks.md",
      "\\\\server\\share\\tasks.md",
      "sub/../tasks.md",
      "sub\\..\\tasks.md"
    ]) {
      expect(daemonExecuteInputSchema.safeParse({ ...base, tasksPath }).success).toBe(false);
    }
    expect(daemonExecuteInputSchema.safeParse({
      ...base,
      tasksPath: "approved/tasks.md"
    }).success).toBe(true);
  });

  it("strictly models durable Review, Leader, and Publish evidence", () => {
    const review = {
      claimId: "claim-1",
      reviewAttemptId: "review-1",
      taskSourceHash: digest,
      candidateHash: digest,
      reviewerSessionId: "reviewer-1",
      piSessionId: "pi-session-1",
      gate: {
        accepted: true,
        allowedLeaderDecisions: ["accept", "pause"],
        result: {
          tasks: [{ id: "T001", completionPercentage: 100, issues: [] }]
        }
      },
      reviewHash: "b".repeat(64)
    };
    expect(durableReviewDecisionSchema.parse(review)).toEqual(review);
    expect(durableReviewDecisionSchema.safeParse({
      ...review,
      gate: { ...review.gate, allowedLeaderDecisions: ["repair", "pause"] }
    }).success).toBe(false);
    expect(durableReviewDecisionSchema.safeParse({
      ...review,
      gate: {
        ...review.gate,
        result: {
          tasks: [{
            id: "T001",
            completionPercentage: 50,
            issues: [{ path: "src/a.ts", message: "parseInput is incomplete" }]
          }]
        }
      }
    }).success).toBe(false);
    expect(durableLeaderDecisionSchema.parse({
      reviewHash: review.reviewHash,
      decision: "accept",
      reason: "review accepted",
      decidedAt: "2026-07-21T10:00:00+08:00",
      decisionHash: "c".repeat(64)
    })).toBeDefined();
    expect(durableLeaderDecisionSchema.safeParse({
      reviewHash: review.reviewHash,
      decision: "repair",
      reason: "strict leader artifact",
      decidedAt: "2026-07-21T10:00:00+08:00",
      decisionHash: "c".repeat(64),
      unexpected: true
    }).success).toBe(false);
    expect(publishResultSchema.parse({
      operationId: "publish-1",
      operationsHash: "d".repeat(64),
      status: "COMMITTED",
      paths: [{
        path: "src/a.ts",
        status: "COMMITTED",
        observedHash: "e".repeat(64),
        observedMode: 0o644
      }]
    })).toBeDefined();
    expect(publishResultSchema.safeParse({
      operationId: "publish-1",
      operationsHash: "d".repeat(64),
      status: "COMMITTED",
      paths: [{
        path: "src/a.ts",
        status: "UNRESOLVED",
        observedHash: null,
        observedMode: null
      }]
    }).success).toBe(false);
  });
});
