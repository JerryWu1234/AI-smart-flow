import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  approveTasksSource,
  executeApprovedTasks,
  type HostGateway
} from "../../../helpers/host-workflow/approval.js";

class RecordingGateway implements HostGateway {
  public readonly calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];

  public call(toolName: string, input: unknown): Promise<unknown> {
    this.calls.push({ toolName, input: input as Record<string, unknown> });
    return Promise.resolve({
      projectId: "project-1",
      jobId: `job-${String(this.calls.length)}`,
      stateVersion: this.calls.length,
      phase: "PREPARING"
    });
  }
}

describe("Host task approval", () => {
  it("never calls execute without an explicit approval snapshot", async () => {
    const gateway = new RecordingGateway();

    await expect(executeApprovedTasks(gateway, process.cwd(), undefined, "request-missing"))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(gateway.calls).toEqual([]);
  });

  it("binds sequential request directories to their own exact bytes and execute payloads", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-approval-"));
    const gateway = new RecordingGateway();
    const requests = [
      { id: "request-a", source: "# Tasks\n\nrequest A\n" },
      { id: "request-b", source: "# Tasks\n\nrequest B\n" }
    ];

    try {
      for (const request of requests) {
        const tasksPath = `.smartflow/tasks/${request.id}/tasks.md`;
        const absolutePath = resolve(projectRoot, tasksPath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, request.source, "utf8");
        const displayedBytes = await readFile(absolutePath);
        const approval = approveTasksSource(tasksPath, displayedBytes);

        await executeApprovedTasks(gateway, projectRoot, approval, request.id);

        expect(approval.sourceHash).toBe(
          createHash("sha256").update(displayedBytes).digest("hex")
        );
        expect(tasksPath.split("/").at(-2)).toBe(request.id);
      }

      expect(await readFile(
        resolve(projectRoot, ".smartflow/tasks/request-a/tasks.md"),
        "utf8"
      )).toBe(requests[0]?.source);
      expect(gateway.calls).toHaveLength(2);
      expect(gateway.calls.map((call) => call.toolName)).toEqual([
        "smartflow_execute",
        "smartflow_execute"
      ]);
      expect(gateway.calls.map((call) => call.input)).toEqual(requests.map((request) => ({
        projectRoot,
        tasksPath: `.smartflow/tasks/${request.id}/tasks.md`,
        approvedSourceHash: createHash("sha256").update(request.source).digest("hex"),
        requestId: request.id
      })));
      for (const call of gateway.calls) {
        expect(call.input).not.toHaveProperty("revision");
        expect(call.input).not.toHaveProperty("expectedRevision");
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
