import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { approveTasksSource, type HostGateway } from "../../../helpers/host-workflow/approval.js";
import { executeApprovedWorkflow } from "../../../helpers/host-workflow/workflow.js";

const digest = "a".repeat(64);

class WorkflowGateway implements HostGateway {
  public phase = "PREPARING";
  public revision = 1;
  public stateVersion = 0;
  public reviewerSessionId: string | undefined;
  public decisions: string[] = [];
  public toolNames: string[] = [];
  private reviewNumber = 0;
  private repairRounds = 0;

  public call(toolName: string, input: unknown): Promise<unknown> {
    this.toolNames.push(toolName);
    const request = input as Record<string, unknown>;
    if (toolName === "smartflow_execute") {
      this.phase = "REVIEW_PENDING";
      this.stateVersion = 1;
      return Promise.resolve(this.mutation());
    }
    if (toolName === "smartflow_review_turn") {
      const review = request.review as Record<string, unknown> | undefined;
      if (review === undefined) return Promise.resolve(this.reviewRequired());
      const result = review.result as { tasks?: Array<{ completionPercentage?: unknown }> };
      this.reviewerSessionId = String(review.reviewerSessionId);
      this.reviewNumber += 1;
      this.stateVersion += 1;
      const incomplete = result.tasks?.some(
        (task) => Number(task.completionPercentage) < 100
      ) ?? true;
      if (!incomplete) {
        this.decisions.push("accept");
        this.phase = "COMPLETED";
        return Promise.resolve({ kind: "DONE", result: this.result() });
      }
      if (this.repairRounds === 15) {
        this.decisions.push("pause");
        this.phase = "PAUSED";
        return Promise.resolve({
          kind: "USER_INPUT_REQUIRED",
          projectId: "project-1",
          jobId: "job-1",
          revision: this.revision,
          stateVersion: this.stateVersion,
          turnToken: `turn-${String(this.reviewNumber)}`,
          pause: {
            code: "AUTOMATIC_REPAIR_LIMIT",
            message: "The automatic repair limit of fifteen rounds was reached."
          },
          result: this.result(),
          review: result,
          inspectionOptions: [],
          options: [
            { answer: "resume_review_decision", description: "Continue repairs" },
            { answer: "cancel", description: "Cancel" }
          ]
        });
      }
      this.decisions.push("repair");
      this.repairRounds += 1;
      this.revision += 1;
      this.phase = "REVIEW_PENDING";
      return Promise.resolve(this.reviewRequired());
    }
    return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
  }

  private reviewRequired(): object {
    return {
      kind: "REVIEW_REQUIRED",
      projectId: "project-1",
      jobId: "job-1",
      revision: this.revision,
      stateVersion: this.stateVersion,
      turnToken: `turn-${String(this.reviewNumber + 1)}`,
      worktreePath: "/tmp/worktree",
      reviewAttemptId: `review-attempt-${String(this.reviewNumber + 1)}`,
      taskSourceHash: digest,
      candidateHash: digest,
      changedPaths: ["src/a.ts", "src/b.ts"],
      reviewerSession: this.reviewerSessionId === undefined
        ? { mode: "CREATE" }
        : { mode: "RESUME", reviewerSessionId: this.reviewerSessionId },
      piSessionId: "pi-session-1",
      deadlineAt: "2026-07-20T00:30:00Z"
    };
  }

  private result(): object {
    return {
      projectId: "project-1",
      jobId: "job-1",
      phase: this.phase,
      status: this.phase === "COMPLETED" ? "COMMITTED" : "PAUSED",
      artifacts: [],
      nextActions: this.phase === "PAUSED" ? ["resume_review_decision"] : [],
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
    };
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
}

describe("executeApprovedWorkflow", () => {
  it("repairs incomplete tasks, resumes the bound Reviewer, then accepts and publishes", async () => {
    const gateway = new WorkflowGateway();
    const reviewerContexts: Array<{
      reviewerSession: { mode: string; reviewerSessionId?: string };
      changedPaths: string[];
    }> = [];
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-workflow-"));
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {
        review: (context) => {
          reviewerContexts.push({
            reviewerSession: { ...context.reviewerSession },
            changedPaths: [...context.changedPaths]
          });
          const incomplete = reviewerContexts.length === 1;
          return Promise.resolve({
            reviewerSessionId: "reviewer-1",
            result: {
              tasks: incomplete
                ? [{
                    id: "T001",
                    completionPercentage: 50,
                    issues: [{
                      path: "src/a.ts",
                      message: "executeTask is missing the required implementation",
                      suggestedFix: "Complete executeTask"
                    }]
                  }]
                : [{ id: "T001", completionPercentage: 100, issues: [] }]
            }
          });
        }
      }, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow",
        hostTurnId: "host-turn-1",
        expectedStateVersion: 0
      });

      expect(reviewerContexts).toEqual([
        {
          reviewerSession: { mode: "CREATE" },
          changedPaths: ["src/a.ts", "src/b.ts"]
        },
        {
          reviewerSession: { mode: "RESUME", reviewerSessionId: "reviewer-1" },
          changedPaths: ["src/a.ts", "src/b.ts"]
        }
      ]);
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
            result: {
              tasks: [{
                id: "T001",
                completionPercentage: 0,
                issues: [{
                  path: "src/a.ts",
                  message: "executeTask is missing the required implementation",
                  suggestedFix: "Complete executeTask"
                }]
              }]
            }
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
      expect(result).toMatchObject({
        phase: "PAUSED",
        status: "PAUSED",
        nextActions: ["resume_review_decision"],
        repairDraft: { approval: { kind: "LEADER_REPAIR" } }
      });
      expect(new Set(gateway.toolNames)).toEqual(new Set([
        "smartflow_execute",
        "smartflow_review_turn"
      ]));
      expect(gateway.toolNames).not.toContain("smartflow_result");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("routes a structured USER approval through the generic callback and same tool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-user-input-"));
    const toolNames: string[] = [];
    const answers: unknown[] = [];
    const completedResult = {
      projectId: "project-1",
      jobId: "job-1",
      phase: "COMPLETED",
      status: "COMMITTED",
      artifacts: [],
      nextActions: []
    };
    const answerTemplate = {
      action: "approve_new_manifest_revision" as const,
      tasksPath: "tasks.md",
      approvedSourceHash: digest,
      approval: {
        kind: "USER" as const,
        parentRevision: 1,
        authorizedCriterionIds: ["T002"]
      }
    };
    const gateway: HostGateway = {
      call: (toolName, value) => {
        toolNames.push(toolName);
        const request = value as Record<string, unknown>;
        if (toolName === "smartflow_execute") {
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            revision: 1,
            stateVersion: 1,
            phase: "PAUSED"
          });
        }
        if (toolName !== "smartflow_review_turn") {
          return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
        }
        if (request.answer !== undefined) {
          answers.push(request.answer);
          return Promise.resolve({ kind: "DONE", result: completedResult });
        }
        return Promise.resolve({
          kind: "USER_INPUT_REQUIRED",
          projectId: "project-1",
          jobId: "job-1",
          revision: 1,
          stateVersion: 1,
          turnToken: "turn-user",
          pause: {
            code: "REPAIR_USER_APPROVAL_REQUIRED",
            message: "Approve the revised task manifest"
          },
          result: {
            projectId: "project-1",
            jobId: "job-1",
            phase: "PAUSED",
            status: "PAUSED",
            artifacts: [],
            nextActions: ["approve_new_manifest_revision", "cancel"]
          },
          repairDraft: {
            sourceArtifact: {
              relativePath: "runs/job-1/repair.md",
              sha256: digest,
              size: 10
            },
            sourceHash: digest,
            suggestedTasksPath: "tasks.md",
            appendText: "repair",
            addedTaskLines: ["- [ ] T002 repair"],
            reasons: ["scope change"],
            approval: answerTemplate.approval
          },
          requiredInput: {
            mode: "CONFIRM",
            action: "approve_new_manifest_revision",
            fields: ["tasksPath", "approvedSourceHash", "approval"],
            answer: answerTemplate
          },
          inspectionOptions: [],
          options: [
            { answer: "approve_new_manifest_revision", description: "Approve revision" },
            { answer: "cancel", description: "Cancel" }
          ]
        });
      }
    };
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {
        answerUserInput: (context) => {
          expect(context.requiredInput).toMatchObject({
            mode: "CONFIRM",
            answer: answerTemplate
          });
          return Promise.resolve(answerTemplate);
        }
      }, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow-user-input",
        hostTurnId: "host-turn-user-input",
        expectedStateVersion: 0
      });

      expect(result).toEqual(completedResult);
      expect(answers).toEqual([answerTemplate]);
      expect(toolNames).toEqual([
        "smartflow_execute",
        "smartflow_review_turn",
        "smartflow_review_turn"
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
