import { afterEach, describe, expect, it, vi } from "vitest";

import { HostActionLoop } from "./action-loop.js";
import type { HostGateway } from "./approval.js";
import {
  validateHostReviewOutput,
  type HostReviewCallbackOutput,
  type HostReviewContext,
  type HostReviewOutput
} from "./reviewer.js";

const digest = "a".repeat(64);

afterEach(() => {
  vi.useRealTimers();
});

describe("HostActionLoop Review lease", () => {
  it("renews while one slow Reviewer runs and submits with the latest stateVersion", async () => {
    vi.useFakeTimers();
    let stateVersion = 1;
    const renewals: Array<Record<string, unknown>> = [];
    const submissions: Array<Record<string, unknown>> = [];
    let finishReview: ((output: HostReviewOutput) => void) | undefined;
    const reviewResult = new Promise<HostReviewOutput>((resolve) => {
      finishReview = resolve;
    });
    const action = {
      type: "REVIEW" as const,
      actionId: "review-action-1",
      revision: 1,
      taskSourceHash: digest,
      candidateHash: digest,
      reviewAttemptId: "review-attempt-1",
      changedPaths: ["src/a.ts", "src/b.ts"],
      reviewerSession: { mode: "CREATE" as const },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T00:15:00Z"
    };
    const gateway: HostGateway = {
      call: (toolName, input): Promise<unknown> => {
        const request = input as Record<string, unknown>;
        if (toolName === "smartflow_status") {
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            phase: "REVIEW_PENDING",
            revision: 1,
            stateVersion,
            progress: { completed: 1, total: 1 },
            pendingAction: action
          });
        }
        if (toolName === "smartflow_claim_action") {
          expect(request.expectedStateVersion).toBe(stateVersion);
          stateVersion += 1;
          return Promise.resolve({
            claimId: "claim-1",
            action: { ...action, worktreePath: "/tmp/worktree" },
            stateVersion,
            expiresAt: "2026-07-20T00:05:00Z"
          });
        }
        if (toolName === "smartflow_renew_action_claim") {
          expect(request.expectedStateVersion).toBe(stateVersion);
          renewals.push(request);
          stateVersion += 1;
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            revision: 1,
            stateVersion,
            phase: "REVIEWING",
            expiresAt: "2026-07-20T00:10:00Z"
          });
        }
        if (toolName === "smartflow_submit_review") {
          expect(request.expectedStateVersion).toBe(stateVersion);
          submissions.push(request);
          stateVersion += 1;
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            revision: 1,
            stateVersion,
            phase: "LEADER_DECISION"
          });
        }
        return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
      }
    };
    const review = vi.fn((): Promise<HostReviewOutput> => reviewResult);
    const loop = new HostActionLoop(gateway, { review });

    const polling = loop.pollOnce({
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 1,
      hostTurnId: "host-turn-1",
      requestId: "request-1"
    });
    await vi.advanceTimersByTimeAsync(120_000);
    finishReview?.({
      reviewerSessionId: "reviewer-1",
      result: {
        verdict: "APPROVE",
        completionPercentage: 100,
        convergeFindings: [],
        adversarialFindings: [],
        pathCoverage: { "src/a.ts": "FULL" },
        residualRisks: []
      }
    });
    await polling;

    expect(review.mock.calls).toEqual([[
      {
        reviewAttemptId: "review-attempt-1",
        worktreePath: "/tmp/worktree",
        taskSourceHash: digest,
        candidateHash: digest,
        changedPaths: ["src/a.ts", "src/b.ts"],
        reviewerSession: { mode: "CREATE" },
        piSessionId: "pi-session-1"
      }
    ]]);
    expect(renewals).toHaveLength(2);
    expect(renewals.map((request) => request.expectedStateVersion)).toEqual([2, 3]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.expectedStateVersion).toBe(4);
  });

  it("reuses a created Reviewer session when correcting an invalid compact result", async () => {
    let stateVersion = 1;
    const contexts: Array<{ mode: string; reviewerSessionId?: string }> = [];
    const action = {
      type: "REVIEW" as const,
      actionId: "review-action-retry",
      revision: 1,
      taskSourceHash: digest,
      candidateHash: digest,
      reviewAttemptId: "review-attempt-retry",
      changedPaths: ["src/a.ts"],
      reviewerSession: { mode: "CREATE" as const },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T00:15:00Z"
    };
    const gateway: HostGateway = {
      call(toolName, input): Promise<unknown> {
        const request = input as Record<string, unknown>;
        if (toolName === "smartflow_status") {
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            phase: "REVIEW_PENDING",
            revision: 1,
            stateVersion,
            progress: { completed: 1, total: 1 },
            pendingAction: action
          });
        }
        if (toolName === "smartflow_claim_action") {
          stateVersion += 1;
          return Promise.resolve({
            claimId: "claim-retry",
            action: { ...action, worktreePath: "/tmp/worktree" },
            stateVersion,
            expiresAt: "2026-07-20T00:05:00Z"
          });
        }
        if (toolName === "smartflow_submit_review") {
          expect(request.expectedStateVersion).toBe(stateVersion);
          expect(request.reviewerSessionId).toBe("reviewer-retry");
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            revision: 1,
            stateVersion: stateVersion + 1,
            phase: "LEADER_DECISION"
          });
        }
        return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
      }
    };
    let attempt = 0;
    await new HostActionLoop(gateway, {
      review: (context): Promise<HostReviewCallbackOutput> => {
        contexts.push({ ...context.reviewerSession });
        attempt += 1;
        return Promise.resolve({
          reviewerSessionId: "reviewer-retry",
          completionPercentage: attempt < 3 ? 99 : 100,
          tasks: [{ id: "T001", completionPercentage: 100 }]
        });
      }
    }).pollOnce({
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 1,
      hostTurnId: "host-turn-retry",
      requestId: "request-retry"
    });

    expect(contexts).toEqual([
      { mode: "CREATE" },
      { mode: "RESUME", reviewerSessionId: "reviewer-retry" },
      { mode: "RESUME", reviewerSessionId: "reviewer-retry" }
    ]);
  });
});

describe("compact Reviewer completion result", () => {
  const context: HostReviewContext = {
    reviewAttemptId: "review-attempt-1",
    worktreePath: "/tmp/worktree",
    taskSourceHash: digest,
    candidateHash: digest,
    changedPaths: ["src/a.ts", "src/b.ts"],
    reviewerSession: { mode: "CREATE" as const },
    piSessionId: "pi-session-1"
  };

  it("passes the compact task result through without path coverage", () => {
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
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
    });

    expect(output.result).toEqual({
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
    });
  });

  it("rejects an overall percentage that is not the rounded task average", () => {
    expect(() => validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      completionPercentage: 74,
      tasks: [
        {
          id: "T001",
          completionPercentage: 50,
          reason: "Required behavior is incomplete",
          suggestion: "Implement the missing behavior"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    })).toThrow(/HOST_REVIEW_INVALID_OUTPUT/u);
  });

  it("preserves a rounded average of 100 when one task is not complete", () => {
    const output = validateHostReviewOutput(context, {
      reviewerSessionId: "reviewer-1",
      completionPercentage: 100,
      tasks: [
        {
          id: "T001",
          completionPercentage: 99,
          reason: "One acceptance detail remains",
          suggestion: "Implement the remaining detail"
        },
        { id: "T002", completionPercentage: 100 }
      ]
    });

    expect(output.result).toMatchObject({ completionPercentage: 100 });
    expect("tasks" in output.result && output.result.tasks[0]?.completionPercentage).toBe(99);
  });
});
