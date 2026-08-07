import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { approveTasksSource, type HostGateway } from "./approval.js";
import { executeApprovedWorkflow } from "./workflow.js";

const digest = "a".repeat(64);

class WorkflowGateway implements HostGateway {
  public phase = "PREPARING";
  public revision = 1;
  public stateVersion = 0;
  public reviewerSessionId: string | undefined;
  public decisions: string[] = [];
  private reviewNumber = 0;

  public call(toolName: string, input: unknown): Promise<unknown> {
    const request = input as Record<string, unknown>;
    if (toolName === "smartflow_execute") {
      this.phase = "REVIEW_PENDING";
      this.stateVersion = 1;
      return Promise.resolve(this.mutation());
    }
    if (toolName === "smartflow_status") return Promise.resolve(this.summary());
    if (toolName === "smartflow_claim_action") {
      this.phase = "REVIEWING";
      this.stateVersion += 1;
      return Promise.resolve({
        claimId: `claim-${String(this.reviewNumber + 1)}`,
        action: { ...this.action(), worktreePath: "/tmp/worktree" },
        stateVersion: this.stateVersion,
        expiresAt: "2026-07-20T00:05:00Z"
      });
    }
    if (toolName === "smartflow_submit_review") {
      const result = this.normalizedReview(request.result);
      this.reviewerSessionId = String(request.reviewerSessionId);
      this.phase = "LEADER_DECISION";
      this.stateVersion += 1;
      this.reviewNumber += 1;
      return Promise.resolve({
        ...this.mutation(),
        reviewHash: digest,
        reviewAttemptId: request.reviewAttemptId,
        reviewerSessionId: request.reviewerSessionId,
        result
      });
    }
    if (toolName === "smartflow_submit_leader_decision") {
      const decision = String(request.decision);
      this.decisions.push(decision);
      this.stateVersion += 1;
      if (decision === "repair") {
        this.phase = "PAUSED";
      } else if (decision === "accept") {
        this.phase = "COMPLETED";
      } else {
        this.phase = "PAUSED";
      }
      return Promise.resolve(this.mutation());
    }
    if (toolName === "smartflow_result") {
      return Promise.resolve({
        projectId: "project-1",
        jobId: "job-1",
        phase: this.phase,
        status: this.phase === "COMPLETED" ? "COMMITTED" : "PAUSED",
        artifacts: [],
        nextActions: this.phase === "PAUSED" ? ["approve_new_manifest_revision"] : [],
        ...(this.phase === "PAUSED"
          ? {
              repairDraft: {
                sourceArtifact: {
                  relativePath: "runs/job-1/revision-2/repair.md",
                  sha256: digest,
                  size: 100
                },
                sourceHash: digest,
                suggestedTasksPath: "tasks.md",
                appendText: "repair",
                addedTaskLines: ["- [ ] T900 repair"],
                reasons: [],
                approval: {
                  kind: "LEADER_REPAIR",
                  parentRevision: this.revision,
                  authorizedCriterionIds: ["T001"]
                }
              }
            }
          : {})
      });
    }
    if (toolName === "smartflow_resume") {
      this.stateVersion += 1;
      if (request.resumeAction === "resume_review_decision") {
        this.phase = "LEADER_DECISION";
      } else {
        this.revision += 1;
        this.phase = "REVIEW_PENDING";
      }
      return Promise.resolve(this.mutation());
    }
    return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
  }

  private mutation(): object {
    return {
      projectId: "project-1",
      jobId: "job-1",
      revision: this.revision,
      stateVersion: this.stateVersion,
      phase: this.phase
    };
  }

  private normalizedReview(value: unknown): Record<string, unknown> {
    const review = value as Record<string, unknown>;
    if (!Array.isArray(review.tasks)) return review;
    const incomplete = (review.tasks as Array<Record<string, unknown>>).filter(
      (task) => Number(task.completionPercentage) < 100
    );
    return {
      verdict: incomplete.length === 0 ? "APPROVE" : "REQUEST_CHANGES",
      completionPercentage: review.completionPercentage,
      convergeFindings: incomplete.map((task) => ({
        fingerprint: digest,
        code: "TASK_INCOMPLETE",
        criterionId: task.id,
        path: null,
        severity: "P1",
        blocking: true,
        summary: `Reason: ${String(task.reason)}; Suggestion: ${String(task.suggestion)}`,
        evidence: [`Task ${String(task.id)} is ${String(task.completionPercentage)}% complete`]
      })),
      adversarialFindings: [],
      pathCoverage: { "src/a.ts": "FULL" },
      residualRisks: []
    };
  }

  private action(): object {
    return {
      type: "REVIEW",
      actionId: `review-action-${String(this.reviewNumber + 1)}`,
      revision: this.revision,
      taskSourceHash: digest,
      candidateHash: digest,
      reviewAttemptId: `review-attempt-${String(this.reviewNumber + 1)}`,
      changedPaths: ["src/a.ts"],
      reviewerSession: this.reviewerSessionId === undefined
        ? { mode: "CREATE" }
        : { mode: "RESUME", reviewerSessionId: this.reviewerSessionId },
      piSessionId: "pi-session-1",
      expiresAt: "2026-07-20T00:15:00Z"
    };
  }

  private summary(): object {
    return {
      projectId: "project-1",
      jobId: "job-1",
      phase: this.phase,
      revision: this.revision,
      stateVersion: this.stateVersion,
      progress: { completed: this.phase === "REVIEW_PENDING" ? 1 : 0, total: 1 },
      ...(this.phase === "REVIEW_PENDING" ? { pendingAction: this.action() } : {}),
      ...(this.phase === "PAUSED"
        ? { pause: { code: "REPAIR_TASKS_READY", resumeActions: ["approve_new_manifest_revision"] } }
        : {})
    };
  }
}

describe("executeApprovedWorkflow", () => {
  it("repairs incomplete tasks, resumes the bound Reviewer, then accepts and publishes", async () => {
    const gateway = new WorkflowGateway();
    const reviewerModes: string[] = [];
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-workflow-"));
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {
        review: (context) => {
          reviewerModes.push(context.reviewerSession.mode);
          const incomplete = reviewerModes.length === 1;
          return Promise.resolve({
            reviewerSessionId: "reviewer-1",
            completionPercentage: incomplete ? 50 : 100,
            tasks: incomplete
              ? [{
                  id: "T001",
                  completionPercentage: 50,
                  reason: "Task is incomplete",
                  suggestion: "Complete the missing implementation"
                }]
              : [{ id: "T001", completionPercentage: 100 }]
          });
        }
      }, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow",
        hostTurnId: "host-turn-1",
        expectedStateVersion: 0
      });

      expect(reviewerModes).toEqual(["CREATE", "RESUME"]);
      expect(gateway.decisions).toEqual(["repair", "accept"]);
      expect(result).toMatchObject({ phase: "COMPLETED", status: "COMMITTED" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("pauses after the initial review plus fifteen automatic repair rounds", async () => {
    const gateway = new WorkflowGateway();
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-limit-"));
    let reviewCalls = 0;
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {
        review: () => {
          reviewCalls += 1;
          return Promise.resolve({
            reviewerSessionId: "reviewer-1",
            completionPercentage: 0,
            tasks: [{
              id: "T001",
              completionPercentage: 0,
              reason: "Task is incomplete",
              suggestion: "Complete the missing implementation"
            }]
          });
        }
      }, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow-limit",
        hostTurnId: "host-turn-limit",
        expectedStateVersion: 0
      });

      expect(reviewCalls).toBe(16);
      expect(gateway.decisions).toEqual([
        ...Array.from({ length: 15 }, () => "repair"),
        "pause"
      ]);
      expect(result).toMatchObject({ phase: "PAUSED", status: "PAUSED" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
