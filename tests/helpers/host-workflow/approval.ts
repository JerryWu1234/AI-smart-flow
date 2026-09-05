import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ExecuteOutput } from "@smartflow/protocol";

export interface HostGateway {
  call(toolName: string, input: unknown): Promise<unknown>;
}

export interface ApprovedTasksSnapshot {
  tasksPath: string;
  sourceHash: string;
  approvedAt: string;
}

class ApprovalError extends Error {
  public readonly code:
    | "APPROVAL_REQUIRED"
    | "APPROVED_SOURCE_DRIFT"
    | "TASKS_PATH_INVALID"
    | "TASKS_READ_UNSTABLE";

  public constructor(code: ApprovalError["code"], message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

function sourceHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureInside(parent: string, child: string): void {
  const path = relative(parent, child);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new ApprovalError("TASKS_PATH_INVALID", "tasksPath must resolve inside the project");
  }
}

export function approveTasksSource(tasksPath: string, source: string | Uint8Array): ApprovedTasksSnapshot {
  if (isAbsolute(tasksPath) || tasksPath.split(/[\\/]/u).includes("..")) {
    throw new ApprovalError("TASKS_PATH_INVALID", "tasksPath must be a safe relative path");
  }
  const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : source;
  return { tasksPath, sourceHash: sourceHash(bytes), approvedAt: new Date().toISOString() };
}

async function readStableApprovedTasks(
  projectRoot: string,
  approval: ApprovedTasksSnapshot
): Promise<Uint8Array> {
  if (isAbsolute(approval.tasksPath) || approval.tasksPath.split(/[\\/]/u).includes("..")) {
    throw new ApprovalError("TASKS_PATH_INVALID", "tasksPath must be a safe relative path");
  }
  const canonicalProject = await realpath(projectRoot);
  const target = resolve(canonicalProject, approval.tasksPath);
  const canonicalTarget = await realpath(target);
  ensureInside(canonicalProject, canonicalTarget);
  const before = await lstat(canonicalTarget);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ApprovalError("TASKS_PATH_INVALID", "tasksPath must be a regular file");
  }
  const handle = await open(canonicalTarget, "r");
  let bytes: Uint8Array;
  let after;
  try {
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new ApprovalError("TASKS_READ_UNSTABLE", "tasks.md changed during its approved read");
  }
  if (sourceHash(bytes) !== approval.sourceHash) {
    throw new ApprovalError(
      "APPROVED_SOURCE_DRIFT",
      "tasks.md no longer matches the user-approved source hash"
    );
  }
  return bytes;
}

export async function executeApprovedTasks(
  gateway: HostGateway,
  projectRoot: string,
  approval: ApprovedTasksSnapshot | undefined
): Promise<ExecuteOutput> {
  if (approval === undefined) {
    throw new ApprovalError("APPROVAL_REQUIRED", "Explicit approval is required before execution");
  }
  await readStableApprovedTasks(projectRoot, approval);
  const response = await gateway.call("smartflow_execute", {});
  return response as ExecuteOutput;
}
