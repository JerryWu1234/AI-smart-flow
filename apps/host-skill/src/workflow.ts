import type { ResultOutput } from "@smartflow/protocol";

import { HostActionLoop, type HostActionCallbacks } from "./action-loop.js";
import {
  executeApprovedTasks,
  type ApprovedTasksSnapshot,
  type HostGateway
} from "./approval.js";

export interface ExecuteApprovedWorkflowInput {
  projectRoot: string;
  approval: ApprovedTasksSnapshot;
  requestId: string;
  hostTurnId: string;
  expectedStateVersion?: number;
}

export async function executeApprovedWorkflow(
  gateway: HostGateway,
  callbacks: HostActionCallbacks,
  input: ExecuteApprovedWorkflowInput
): Promise<ResultOutput> {
  const execute = await executeApprovedTasks(
    gateway,
    input.projectRoot,
    input.approval,
    input.requestId,
    input.expectedStateVersion
  );
  return new HostActionLoop(gateway, callbacks).runToCompletion({
    projectId: execute.projectId,
    jobId: execute.jobId,
    hostTurnId: input.hostTurnId,
    requestId: `${input.requestId}:host-loop`
  });
}
