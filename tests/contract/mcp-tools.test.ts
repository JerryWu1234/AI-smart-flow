import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createToolHandlers, type DaemonGateway } from "@smartflow/mcp-server";
import { daemonExecuteInputSchema, type DaemonExecuteInput } from "@smartflow/protocol";

class GatewayError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class FakeDaemonGateway implements DaemonGateway {
  public readonly executeRequests: DaemonExecuteInput[] = [];
  private readonly receipts = new Map<string, unknown>();

  public constructor(private readonly malformedFirstExecute = false) {}

  public call(toolName: string, input: unknown): Promise<unknown> {
    if (toolName === "smartflow_execute") {
      const request = daemonExecuteInputSchema.parse(input);
      this.executeRequests.push(request);
      if (this.malformedFirstExecute && this.executeRequests.length === 1) {
        return Promise.resolve({ malformed: true });
      }
      const existing = this.receipts.get(request.requestId);
      if (existing !== undefined) return Promise.resolve(existing);
      const response = {
        projectId: "project-1",
        jobId: `job-${String(this.executeRequests.length)}`,
        stateVersion: this.executeRequests.length,
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

const nonExecutingSession = {
  sessionId: "session-test",
  projectRoot: process.cwd(),
  tasksPath: ".smartflow/tasks/session-test/tasks.md"
};

describe("SmartFlow MCP handlers", () => {
  it("binds zero-argument execute to the session task source", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-mcp-tools-"));
    const tasksPath = ".smartflow/tasks/session-test/tasks.md";
    const absoluteTasksPath = join(projectRoot, tasksPath);
    const firstSource = "# Tasks\n\nfirst batch\n";
    const secondSource = "# Tasks\n\nsecond batch\n";
    await mkdir(dirname(absoluteTasksPath), { recursive: true });
    await writeFile(absoluteTasksPath, firstSource, "utf8");
    const gateway = new FakeDaemonGateway();
    const handlers = createToolHandlers(gateway, {
      sessionId: "session-test",
      projectRoot,
      tasksPath
    });

    try {
      expect(Object.keys(handlers).sort()).toEqual([
        "smartflow_cancel",
        "smartflow_execute",
        "smartflow_result",
        "smartflow_resume",
        "smartflow_review_turn",
        "smartflow_status"
      ]);
      expect("smartflow_submit_tool_decision" in handlers).toBe(false);

      const first = await handlers.smartflow_execute({});
      await expect(handlers.smartflow_execute({})).resolves.toEqual(first);
      expect(gateway.executeRequests).toHaveLength(1);
      const firstRequest = gateway.executeRequests[0];
      expect(firstRequest).toMatchObject({
        projectRoot,
        tasksPath,
        approvedSourceHash: createHash("sha256").update(firstSource).digest("hex")
      });
      expect(firstRequest?.requestId).toMatch(/^execute:session-test:/u);

      await writeFile(absoluteTasksPath, secondSource, "utf8");
      await handlers.smartflow_execute({});
      expect(gateway.executeRequests).toHaveLength(2);
      expect(gateway.executeRequests[1]?.approvedSourceHash).toBe(
        createHash("sha256").update(secondSource).digest("hex")
      );
      expect(gateway.executeRequests[1]?.requestId).not.toBe(firstRequest?.requestId);

      await expect(
        handlers.smartflow_execute({ projectRoot })
      ).rejects.toMatchObject({ name: "ZodError" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("retries unchanged bytes with the same identity after an invalid response", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-mcp-retry-"));
    const tasksPath = "tasks.md";
    await writeFile(join(projectRoot, tasksPath), "# Tasks\n\nretry batch\n", "utf8");
    const gateway = new FakeDaemonGateway(true);
    const handlers = createToolHandlers(gateway, {
      sessionId: "session-retry",
      projectRoot,
      tasksPath
    });

    try {
      await expect(handlers.smartflow_execute({})).rejects.toMatchObject({ name: "ZodError" });
      await expect(handlers.smartflow_execute({})).resolves.toMatchObject({ phase: "PREPARING" });
      expect(gateway.executeRequests).toHaveLength(2);
      expect(gateway.executeRequests[1]?.requestId)
        .toBe(gateway.executeRequests[0]?.requestId);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("forwards the composite review turn", async () => {
    const handlers = createToolHandlers(new FakeDaemonGateway(), nonExecutingSession);
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
    const handlers = createToolHandlers(new FakeDaemonGateway(), nonExecutingSession);
    await expect(
      handlers.smartflow_execute({ expectedStateVersion: 0 })
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
    const handlers = createToolHandlers(new FakeDaemonGateway(), nonExecutingSession);
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
