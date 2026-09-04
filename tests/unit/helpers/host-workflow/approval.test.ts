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

    await expect(executeApprovedTasks(gateway, process.cwd(), undefined))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(gateway.calls).toEqual([]);
  });

  it("binds sequential approvals to exact bytes and sends empty execute inputs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "smartflow-host-approval-"));
    const gateway = new RecordingGateway();
    const tasksPath = ".smartflow/tasks/session-test/tasks.md";
    const absolutePath = resolve(projectRoot, tasksPath);
    const sources = ["# Tasks\n\nrequest A\n", "# Tasks\n\nrequest B\n"];

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      for (const source of sources) {
        await writeFile(absolutePath, source, "utf8");
        const displayedBytes = await readFile(absolutePath);
        const approval = approveTasksSource(tasksPath, displayedBytes);

        await executeApprovedTasks(gateway, projectRoot, approval);

        expect(approval.sourceHash).toBe(
          createHash("sha256").update(displayedBytes).digest("hex")
        );
      }

      expect(await readFile(absolutePath, "utf8")).toBe(sources[1]);
      expect(gateway.calls.map((call) => call.toolName)).toEqual([
        "smartflow_execute",
        "smartflow_execute"
      ]);
      expect(gateway.calls.map((call) => call.input)).toEqual([{}, {}]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
