import { describe, expect, it } from "vitest";

import { createToolHandlers, type DaemonGateway } from "@smartflow/mcp-server";

class GatewayError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class FakeDaemonGateway implements DaemonGateway {
  private readonly receipts = new Map<string, unknown>();

  public call(toolName: string, input: unknown): Promise<unknown> {
    if (toolName === "smartflow_execute") {
      const request = input as { requestId: string };
      const existing = this.receipts.get(request.requestId);
      if (existing !== undefined) return Promise.resolve(existing);
      const response = {
        projectId: "project-1",
        jobId: "job-1",
        revision: 1,
        stateVersion: 1,
        phase: "PREPARING"
      };
      this.receipts.set(request.requestId, response);
      return Promise.resolve(response);
    }
    if (toolName === "smartflow_cancel") {
      const request = input as { projectId: string; jobId: string };
      if (request.projectId !== "project-1") {
        return Promise.reject(
          new GatewayError("PROJECT_MISMATCH", "request belongs to another project")
        );
      }
      return Promise.resolve({
        projectId: request.projectId,
        jobId: request.jobId,
        revision: 1,
        stateVersion: 2,
        phase: "CANCELING"
      });
    }
    if (toolName === "smartflow_renew_action_claim") {
      const request = input as { projectId: string; jobId: string };
      return Promise.resolve({
        projectId: request.projectId,
        jobId: request.jobId,
        revision: 1,
        stateVersion: 4,
        phase: "REVIEWING",
        expiresAt: "2026-07-20T00:05:00Z"
      });
    }
    if (toolName === "smartflow_submit_review") {
      const request = input as {
        projectId: string;
        jobId: string;
        reviewAttemptId: string;
        reviewerSessionId: string;
        result: unknown;
      };
      return Promise.resolve({
        projectId: request.projectId,
        jobId: request.jobId,
        revision: 1,
        stateVersion: 4,
        phase: "LEADER_DECISION",
        reviewHash: "b".repeat(64),
        reviewAttemptId: request.reviewAttemptId,
        reviewerSessionId: request.reviewerSessionId,
        result: request.result
      });
    }
    return Promise.reject(new GatewayError("NOT_IMPLEMENTED", toolName));
  }
}

const executeInput = {
  projectRoot: "/work/project",
  tasksPath: "tasks.md",
  approvedSourceHash: `sha256:${"a".repeat(64)}`,
  requestId: "request-1",
  expectedStateVersion: 0
};

describe("smartflow.v5 MCP handlers", () => {
  it("registers all ten tools without Worker tool decisions and validates approvedSourceHash", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    expect(Object.keys(handlers)).toHaveLength(10);
    expect("smartflow_submit_tool_decision" in handlers).toBe(false);
    const first = await handlers.smartflow_execute(executeInput);
    const replay = await handlers.smartflow_execute(executeInput);
    expect(replay).toEqual(first);
    await expect(
      handlers.smartflow_execute({ ...executeInput, approvedSourceHash: "not-a-hash" })
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("forwards a claim renewal bound to the active Host turn", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    await expect(handlers.smartflow_renew_action_claim({
      requestId: "renew-request-1",
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 3,
      actionId: "action-1",
      claimId: "claim-1",
      hostTurnId: "host-turn-1"
    })).resolves.toMatchObject({
      stateVersion: 4,
      phase: "REVIEWING"
    });
  });

  it("requires mutation CAS fields before forwarding", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    await expect(
      handlers.smartflow_cancel({
        requestId: "request-2",
        projectId: "project-1",
        jobId: "job-1",
        expectedStateVersion: 1,
        reason: "stop"
      })
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("preserves stable daemon errors without translating their code", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    await expect(
      handlers.smartflow_cancel({
        requestId: "request-3",
        projectId: "other-project",
        jobId: "job-1",
        expectedRevision: 1,
        expectedStateVersion: 1,
        reason: "stop"
      })
    ).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });
  });

  it("forwards a Host review and returns its complete result to the Leader", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    const result = {
      verdict: "APPROVE",
      completionPercentage: 100,
      convergeFindings: [],
      adversarialFindings: [],
      pathCoverage: { "src/a.ts": "FULL" },
      residualRisks: []
    };
    await expect(handlers.smartflow_submit_review({
      requestId: "review-request-1",
      projectId: "project-1",
      jobId: "job-1",
      expectedRevision: 1,
      expectedStateVersion: 3,
      claimId: "claim-1",
      reviewAttemptId: "review-attempt-1",
      reviewBundleHash: "a".repeat(64),
      reviewerSessionId: "reviewer-1",
      result
    })).resolves.toMatchObject({
      phase: "LEADER_DECISION",
      reviewAttemptId: "review-attempt-1",
      reviewerSessionId: "reviewer-1",
      result
    });
  });
});
