import { describe, expect, it } from "vitest";

import {
  durableLeaderDecisionSchema,
  durableReviewDecisionSchema,
  executeInputSchema,
  hostActionSchema,
  mcpToolSchemas,
  piWorkerAttemptSchema,
  publishResultSchema,
  renewActionClaimInputSchema,
  renewActionClaimOutputSchema,
  reviewSubmissionSchema,
  reviewTurnInputSchema,
  reviewTurnOutputSchema,
  runPhaseSchema,
  statusInputSchema,
  submitLeaderDecisionInputSchema,
  submitReviewInputSchema,
  submitReviewOutputSchema
} from "../index.js";

const digest = "a".repeat(64);

describe("smartflow.v5 protocol schemas", () => {
  it("defines exactly the eleven public MCP tools without Worker tool decisions", () => {
    expect(Object.keys(mcpToolSchemas).sort()).toEqual([
      "smartflow_cancel",
      "smartflow_claim_action",
      "smartflow_execute",
      "smartflow_renew_action_claim",
      "smartflow_result",
      "smartflow_resume",
      "smartflow_review_turn",
      "smartflow_status",
      "smartflow_submit_leader_decision",
      "smartflow_submit_review",
      "smartflow_wait"
    ]);
    expect("smartflow_submit_tool_decision" in mcpToolSchemas).toBe(false);
  });

  it("models the single review-turn entry point without leaking worktree paths", () => {
    const identity = {
      projectId: "project-1",
      jobId: "job-1",
      revision: 1,
      stateVersion: 3
    };
    const pausedResult = {
      projectId: "project-1",
      jobId: "job-1",
      phase: "PAUSED" as const,
      status: "PAUSED" as const,
      artifacts: [],
      nextActions: ["cancel"]
    };
    const reviewRequired = {
      kind: "REVIEW_REQUIRED" as const,
      ...identity,
      turnToken: "turn-1",
      worktreePath: "/private/run-worktree",
      reviewAttemptId: "review-attempt-1",
      taskSourceHash: digest,
      candidateHash: "b".repeat(64),
      changedPaths: ["src/a.ts"],
      reviewerSession: { mode: "CREATE" as const },
      piSessionId: "pi-session-1",
      deadlineAt: "2026-08-11T12:30:00+00:00"
    };
    expect(reviewTurnOutputSchema.parse(reviewRequired)).toEqual(reviewRequired);
    expect(reviewTurnOutputSchema.safeParse({
      kind: "NOT_READY",
      ...identity,
      phase: "RUNNING",
      retryAfterMs: 1_000,
      progress: { completed: 0, total: 1 },
      worktreePath: "/private/run-worktree"
    }).success).toBe(false);
    const userInput = {
      kind: "USER_INPUT_REQUIRED" as const,
      ...identity,
      turnToken: "turn-2",
      pause: { code: "REPAIR_NO_PROGRESS", message: "User action required" },
      result: pausedResult,
      inspectionOptions: [],
      options: [{ answer: "cancel" as const, description: "Cancel the run" }]
    };
    expect(reviewTurnOutputSchema.parse(userInput)).toEqual(userInput);
    expect(reviewTurnOutputSchema.safeParse({
      ...userInput,
      worktreePath: "/private/run-worktree"
    }).success).toBe(false);
    const repairDraft = {
      sourceArtifact: { relativePath: "runs/job-1/repair.md", sha256: digest, size: 10 },
      sourceHash: digest,
      suggestedTasksPath: "tasks.md",
      appendText: "repair task",
      addedTaskLines: ["- [ ] T002 repair"],
      reasons: ["scope change"],
      approval: {
        kind: "USER" as const,
        parentRevision: 1,
        authorizedCriterionIds: ["T002"]
      }
    };
    const userApproval = {
      kind: "USER_INPUT_REQUIRED" as const,
      ...identity,
      turnToken: "turn-user",
      pause: { code: "REPAIR_USER_APPROVAL_REQUIRED", message: "Approval required" },
      result: {
        ...pausedResult,
        nextActions: ["approve_new_manifest_revision", "cancel"],
        repairDraft
      },
      repairDraft,
      requiredInput: {
        mode: "CONFIRM" as const,
        action: "approve_new_manifest_revision" as const,
        fields: ["tasksPath", "approvedSourceHash", "approval"] as const,
        answer: {
          action: "approve_new_manifest_revision" as const,
          tasksPath: "tasks.md",
          approvedSourceHash: digest,
          approval: repairDraft.approval
        }
      },
      inspectionOptions: [],
      options: [
        { answer: "approve_new_manifest_revision" as const, description: "Approve revision" },
        { answer: "cancel" as const, description: "Cancel the run" }
      ]
    };
    expect(reviewTurnOutputSchema.parse(userApproval)).toEqual(userApproval);
    const genericApproval = {
      kind: "USER_INPUT_REQUIRED" as const,
      ...identity,
      turnToken: "turn-generic-approval",
      pause: { code: "APPROVED_SOURCE_DRIFT", message: "Approval required" },
      result: {
        ...pausedResult,
        nextActions: ["approve_new_manifest_revision", "cancel"]
      },
      requiredInput: {
        mode: "COLLECT" as const,
        action: "approve_new_manifest_revision" as const,
        fields: ["tasksPath", "approvedSourceHash", "approval"] as const,
        inputForm: {
          tasksPath: null,
          approvedSourceHash: null,
          approval: null
        }
      },
      inspectionOptions: [],
      options: [
        { answer: "approve_new_manifest_revision" as const, description: "Approve revision" },
        { answer: "cancel" as const, description: "Cancel the run" }
      ]
    };
    expect(reviewTurnOutputSchema.parse(genericApproval)).toEqual(genericApproval);
    expect(reviewTurnOutputSchema.safeParse({
      ...genericApproval,
      requiredInput: { ...genericApproval.requiredInput, inputForm: {} }
    }).success).toBe(false);
    expect(reviewTurnOutputSchema.safeParse({
      ...genericApproval,
      options: [{ answer: "inspect_conflict", description: "Inspect" }]
    }).success).toBe(false);
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
          completionPercentage: 100,
          tasks: [{ id: "T001", completionPercentage: 100 }]
        }
      }
    }).success).toBe(true);
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
      answer: "export_bundle"
    }).success).toBe(false);
    expect(reviewTurnInputSchema.safeParse({
      ...baseInput,
      answer: userApproval.requiredInput.answer
    }).success).toBe(true);
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

  it("records Pi Attempt session/containment identity", () => {
    const attempt = {
      attemptId: "attempt-1",
      revision: 1,
      generation: 0,
      providerRuntimeConfigHash: digest,
      status: "RUNNING",
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
  });

  it("binds claim renewal to the current action, claim, and Host turn", () => {
    const renewal = {
      requestId: "renew-request-1",
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 4,
      actionId: "action-1",
      claimId: "claim-1",
      hostTurnId: "host-turn-1"
    };
    expect(renewActionClaimInputSchema.parse(renewal)).toEqual(renewal);
    expect(renewActionClaimInputSchema.safeParse({
      ...renewal,
      hostTurnId: undefined
    }).success).toBe(false);
    expect(renewActionClaimOutputSchema.parse({
      projectId: "project-1",
      jobId: "job-1",
      revision: 1,
      stateVersion: 5,
      phase: "REVIEWING",
      expiresAt: "2026-07-20T00:05:00Z"
    })).toBeDefined();
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
        revision: 1,
        effectHash: "not-a-review-context",
        expiresAt: "2026-07-20T00:00:00Z"
      })
    ).toThrow();
  });

  it("models CREATE and RESUME Review actions bound to task source and Candidate", () => {
    const action = {
      type: "REVIEW",
      actionId: "action-1",
      revision: 1,
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

  it("accepts structured Host review results and rejects removed execution evidence", () => {
    const finding = {
      fingerprint: digest,
      code: "BLOCKER",
      criterionId: "T001",
      path: "src/a.ts",
      severity: "P1",
      blocking: true,
      summary: "blocking review finding",
      evidence: ["review evidence"]
    };
    const review = {
      verdict: "REQUEST_CHANGES",
      completionPercentage: 75,
      convergeFindings: [finding],
      adversarialFindings: [],
      pathCoverage: { "src/a.ts": "FULL" },
      residualRisks: []
    };
    expect(reviewSubmissionSchema.safeParse(review).success).toBe(true);
    expect(reviewSubmissionSchema.safeParse({
      ...review,
      completionPercentage: 101
    }).success).toBe(false);
    expect(reviewSubmissionSchema.safeParse({
      ...review,
      completionPercentage: 75.5
    }).success).toBe(false);
    const reviewWithoutCompletion: Record<string, unknown> = { ...review };
    delete reviewWithoutCompletion.completionPercentage;
    expect(reviewSubmissionSchema.safeParse(reviewWithoutCompletion).success).toBe(false);
    expect(reviewSubmissionSchema.safeParse({
      ...review,
      convergeFindings: [{ ...finding, severity: "P9" }]
    }).success).toBe(false);
    expect(reviewSubmissionSchema.safeParse({
      ...review,
      convergeFindings: [{ ...finding, blocking: "false" }]
    }).success).toBe(false);
    expect(reviewSubmissionSchema.safeParse({
      ...review,
      convergeFindings: [{ ...finding, evidence: [] }]
    }).success).toBe(false);
    const submission = {
      requestId: "request-1",
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 3,
      claimId: "claim-1",
      reviewAttemptId: "review-attempt-1",
      taskSourceHash: digest,
      candidateHash: digest,
      reviewerSessionId: "reviewer-1",
      result: review
    };
    expect(submitReviewInputSchema.safeParse(submission).success).toBe(true);
    expect(submitReviewInputSchema.safeParse({
      ...submission,
      result: {
        completionPercentage: 75,
        tasks: [
          {
            id: "T001",
            completionPercentage: 50,
            reason: "Required behavior is incomplete",
            suggestion: "Implement the missing behavior"
          },
          { id: "T002", completionPercentage: 100 }
        ]
      }
    }).success).toBe(true);
    expect(submitReviewInputSchema.safeParse({
      ...submission,
      result: {
        completionPercentage: 50,
        tasks: [{ id: "T001", completionPercentage: 50 }]
      }
    }).success).toBe(false);
    expect(submitReviewInputSchema.safeParse({
      ...submission,
      provenance: { forged: true }
    }).success).toBe(false);
    expect(submitReviewInputSchema.safeParse({
      ...submission,
      executeCurrentHostReview: true
    }).success).toBe(false);
    expect(submitReviewOutputSchema.parse({
      projectId: "project-1",
      jobId: "job-1",
      revision: 1,
      stateVersion: 4,
      phase: "LEADER_DECISION",
      reviewHash: digest,
      reviewAttemptId: "review-attempt-1",
      reviewerSessionId: "reviewer-1",
      result: review
    })).toBeDefined();
  });

  it("requires execute approval to bind the source hash", () => {
    expect(() =>
      executeInputSchema.parse({
        projectRoot: "/tmp/project",
        tasksPath: "tasks.md",
        requestId: "req-1"
      })
    ).toThrow();
  });

  it("binds repair decisions to explicit unique Reviewer or Leader items", () => {
    const decision = {
      requestId: "leader-request-1",
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 5,
      reviewHash: digest,
      decision: "repair" as const,
      reason: "repair selected review comment"
    };
    expect(submitLeaderDecisionInputSchema.safeParse(decision).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      reason: "   ",
      repairItems: [{ source: "reviewer", findingFingerprint: digest }]
    }).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [{ source: "reviewer", findingFingerprint: digest }]
    }).success).toBe(true);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [
        { source: "reviewer", findingFingerprint: digest },
        { source: "reviewer", findingFingerprint: digest }
      ]
    }).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [{
        source: "leader",
        code: "LEADER_EXPECTATION_MISSED",
        taskId: "T001",
        path: "src/a.ts",
        reason: "The result does not meet the approved task"
      }]
    }).success).toBe(true);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [{
        source: "leader",
        code: "LEADER_EXPECTATION_MISSED",
        taskId: "T001",
        path: "src/a.ts",
        reason: "   "
      }]
    }).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [{
        source: "leader",
        code: "LEADER_EXPECTATION_MISSED",
        taskId: "T001",
        path: "   ",
        reason: "unsafe blank path"
      }]
    }).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      repairItems: [{
        source: "leader",
        code: "LEADER_EXPECTATION_MISSED",
        taskId: "T001",
        path: "../outside.ts",
        reason: "unsafe path"
      }]
    }).success).toBe(false);
    expect(submitLeaderDecisionInputSchema.safeParse({
      ...decision,
      decision: "accept",
      repairItems: [{ source: "reviewer", findingFingerprint: digest }]
    }).success).toBe(false);
  });

  it("requires tasksPath to be relative and free of parent traversal", () => {
    const base = {
      projectRoot: "/tmp/project",
      approvedSourceHash: digest,
      requestId: "req-path"
    };
    for (const tasksPath of [
      "/tmp/project/tasks.md",
      "C:\\project\\tasks.md",
      "\\\\server\\share\\tasks.md",
      "sub/../tasks.md",
      "sub\\..\\tasks.md"
    ]) {
      expect(executeInputSchema.safeParse({ ...base, tasksPath }).success).toBe(false);
    }
    expect(executeInputSchema.safeParse({ ...base, tasksPath: "approved/tasks.md" }).success).toBe(true);
  });

  it("strictly models durable Review, Leader, and Publish evidence", () => {
    const review = {
      schemaVersion: 1,
      revision: 1,
      claimId: "claim-1",
      reviewAttemptId: "review-1",
      taskSourceHash: digest,
      candidateHash: digest,
      reviewerSessionId: "reviewer-1",
      piSessionId: "pi-session-1",
      gate: {
        accepted: true,
        allowedLeaderDecisions: ["accept", "repair", "pause"],
        result: {
          verdict: "APPROVE",
          completionPercentage: 100,
          convergeFindings: [],
          adversarialFindings: [],
          pathCoverage: { "src/a.ts": "FULL" },
          residualRisks: []
        },
        reasons: []
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
        result: { ...review.gate.result, completionPercentage: 101 }
      }
    }).success).toBe(false);
    expect(durableLeaderDecisionSchema.parse({
      schemaVersion: 1,
      revision: 1,
      reviewHash: review.reviewHash,
      decision: "accept",
      repairItems: [],
      reason: "review accepted",
      decidedAt: "2026-07-21T10:00:00+08:00",
      decisionHash: "c".repeat(64)
    })).toBeDefined();
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
