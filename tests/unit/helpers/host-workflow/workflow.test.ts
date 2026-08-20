import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { approveTasksSource, type HostGateway } from "../../../helpers/host-workflow/approval.js";
import { executeApprovedWorkflow } from "../../../helpers/host-workflow/workflow.js";

const digest = "a".repeat(64);

function completedResult(): object {
  return {
    projectId: "project-1",
    jobId: "job-1",
    phase: "COMPLETED",
    status: "COMMITTED",
    artifacts: [],
    nextActions: []
  };
}

class PollingGateway implements HostGateway {
  public readonly toolNames: string[] = [];
  public readonly reviewTurnInputs: Array<Record<string, unknown>> = [];
  private polls = 0;

  public call(toolName: string, input: unknown): Promise<unknown> {
    this.toolNames.push(toolName);
    if (toolName === "smartflow_execute") {
      return Promise.resolve({
        projectId: "project-1",
        jobId: "job-1",
        revision: 1,
        stateVersion: 1,
        phase: "REVIEW_PENDING"
      });
    }
    if (toolName !== "smartflow_review_turn") {
      return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
    }
    const request = input as Record<string, unknown>;
    this.reviewTurnInputs.push(request);
    this.polls += 1;
    return Promise.resolve(this.polls === 1
      ? { kind: "NOT_READY", retryAfterMs: 1 }
      : { kind: "DONE", result: completedResult() });
  }
}

describe("executeApprovedWorkflow", () => {
  it("polls daemon-owned Review without submitting reviewer data", async () => {
    const gateway = new PollingGateway();
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-workflow-"));
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {}, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow",
        hostTurnId: "host-turn-1",
        expectedStateVersion: 0
      });

      expect(result).toEqual(completedResult());
      expect(gateway.reviewTurnInputs).toHaveLength(2);
      for (const input of gateway.reviewTurnInputs) {
        expect(input).not.toHaveProperty("review");
        expect(input).not.toHaveProperty("reviewUnavailableReason");
      }
      expect(new Set(gateway.toolNames)).toEqual(new Set([
        "smartflow_execute",
        "smartflow_review_turn"
      ]));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("continues after the automatic repair limit using only the listed answer", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-limit-"));
    const answers: unknown[] = [];
    const review = {
      tasks: [{
        id: "T001",
        completionPercentage: 0,
        issues: [{
          path: "src/a.ts",
          message: "executeTask is missing the required implementation",
          suggestedFix: null
        }]
      }]
    };
    const gateway: HostGateway = {
      call: (toolName, input) => {
        const request = input as Record<string, unknown>;
        if (toolName === "smartflow_execute") {
          return Promise.resolve({
            projectId: "project-1",
            jobId: "job-1",
            revision: 16,
            stateVersion: 16,
            phase: "PAUSED"
          });
        }
        if (toolName !== "smartflow_review_turn") {
          return Promise.reject(new Error(`Unexpected tool: ${toolName}`));
        }
        if (request.answer !== undefined) {
          answers.push(request.answer);
          return Promise.resolve({ kind: "DONE", result: completedResult() });
        }
        return Promise.resolve({
          kind: "USER_INPUT_REQUIRED",
          turnToken: "turn-limit",
          pause: {
            code: "AUTOMATIC_REPAIR_LIMIT",
            message: "The automatic repair limit was reached."
          },
          result: {
            projectId: "project-1",
            jobId: "job-1",
            phase: "PAUSED",
            status: "PAUSED",
            artifacts: [],
            nextActions: ["resume_review_decision", "cancel"],
            review
          },
          options: [
            { answer: "resume_review_decision", description: "Continue repairs" },
            { answer: "cancel", description: "Cancel" }
          ]
        });
      }
    };
    try {
      await writeFile(join(projectRoot, "tasks.md"), "# Tasks", "utf8");
      const result = await executeApprovedWorkflow(gateway, {
        continueAfterRepairLimit: (context) => {
          expect(context).toEqual({ repairRounds: 15, result: review });
          return Promise.resolve(true);
        }
      }, {
        projectRoot,
        approval: approveTasksSource("tasks.md", "# Tasks"),
        requestId: "execute-workflow-limit",
        hostTurnId: "host-turn-limit",
        expectedStateVersion: 0
      });

      expect(result).toEqual(completedResult());
      expect(answers).toEqual(["resume_review_decision"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("routes a structured USER approval through the generic callback and same tool", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-user-input-"));
    const toolNames: string[] = [];
    const answers: unknown[] = [];
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
          return Promise.resolve({ kind: "DONE", result: completedResult() });
        }
        return Promise.resolve({
          kind: "USER_INPUT_REQUIRED",
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
          options: [
            { answer: "approve_new_manifest_revision", description: "Approve revision" },
            { answer: "cancel", description: "Cancel" }
          ],
          requiredInput: {
            mode: "CONFIRM",
            action: "approve_new_manifest_revision",
            answer: answerTemplate
          }
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

      expect(result).toEqual(completedResult());
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
