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
        stateVersion: 1,
        phase: "PREPARING"
      };
      this.receipts.set(request.requestId, response);
      return Promise.resolve(response);
    }
    if (toolName === "smartflow_review_turn") {
      return Promise.resolve({
        kind: "DONE",
        result: {
          projectId: "project-1",
          jobId: "job-1",
          phase: "COMPLETED",
          status: "COMMITTED",
          artifacts: [],
          nextActions: []
        }
      });
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
        stateVersion: 2,
        phase: "CANCELING"
      });
    }
    return Promise.reject(new GatewayError("NOT_IMPLEMENTED", toolName));
  }
}

const executeInput = {
  projectRoot: "/work/project",
  tasksPath: "tasks.md",
  approvedSourceHash: `sha256:${"a".repeat(64)}`,
  requestId: "request-1"
};

describe("SmartFlow MCP handlers", () => {
  it("registers exactly the six public tools and validates approvedSourceHash", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    expect(Object.keys(handlers).sort()).toEqual([
      "smartflow_cancel",
      "smartflow_execute",
      "smartflow_result",
      "smartflow_resume",
      "smartflow_review_turn",
      "smartflow_status"
    ]);
    expect("smartflow_submit_tool_decision" in handlers).toBe(false);
    const first = await handlers.smartflow_execute(executeInput);
    const replay = await handlers.smartflow_execute(executeInput);
    expect(replay).toEqual(first);
    await expect(
      handlers.smartflow_execute({ ...executeInput, approvedSourceHash: "not-a-hash" })
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("forwards the composite review turn", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    await expect(handlers.smartflow_review_turn({
      requestId: "review-turn-request-1",
      projectId: "project-1",
      jobId: "job-1",
      hostTurnId: "host-turn-1"
    })).resolves.toMatchObject({
      kind: "DONE",
      result: { phase: "COMPLETED", status: "COMMITTED" }
    });
  });

  it("accepts daemon-owned concurrency and rejects removed public CAS fields", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway());
    await expect(
      handlers.smartflow_execute({ ...executeInput, expectedStateVersion: 0 })
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      handlers.smartflow_cancel({
        requestId: "request-2",
        projectId: "project-1",
        jobId: "job-1",
        reason: "stop"
      })
    ).resolves.toMatchObject({ phase: "CANCELING" });
    await expect(
      handlers.smartflow_cancel({
        requestId: "request-2-state-cas",
        projectId: "project-1",
        jobId: "job-1",
        expectedStateVersion: 1,
        reason: "stop"
      })
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      handlers.smartflow_cancel({
        requestId: "request-2-revision-cas",
        projectId: "project-1",
        jobId: "job-1",
        expectedRevision: 1,
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
        reason: "stop"
      })
    ).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });
  });
});
