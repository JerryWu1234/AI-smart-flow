import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  daemonExecuteInputSchema,
  executeInputSchema,
  executeOutputSchema,
  type ExecuteOutput
} from "@smartflow/protocol";

import type { DaemonGateway, ValidatedHandler } from "../daemon-gateway.js";

export interface SmartFlowMcpSession {
  sessionId: string;
  projectRoot: string;
  tasksPath: string;
}

interface PendingExecute {
  sourceHash: string;
  requestId: string;
  inFlight?: Promise<ExecuteOutput>;
  receipt?: ExecuteOutput;
}

export function createExecuteHandler(
  gateway: DaemonGateway,
  session: SmartFlowMcpSession
): ValidatedHandler {
  let pending: PendingExecute | undefined;

  return async (input: unknown): Promise<ExecuteOutput> => {
    executeInputSchema.parse(input);
    const sourceBytes = await readFile(resolve(session.projectRoot, session.tasksPath));
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

    let current = pending;
    if (current === undefined || current.sourceHash !== sourceHash) {
      current = {
        sourceHash,
        requestId: `execute:${session.sessionId}:${randomUUID()}`
      };
      pending = current;
    }
    if (current.receipt !== undefined) return current.receipt;
    if (current.inFlight !== undefined) return current.inFlight;

    const request = daemonExecuteInputSchema.parse({
      projectRoot: session.projectRoot,
      tasksPath: session.tasksPath,
      approvedSourceHash: sourceHash,
      requestId: current.requestId
    });
    const inFlight = gateway.call("smartflow_execute", request)
      .then((response) => executeOutputSchema.parse(response))
      .then(
        (receipt) => {
          if (pending === current) {
            current.receipt = receipt;
            delete current.inFlight;
          }
          return receipt;
        },
        (error: unknown) => {
          if (pending === current) delete current.inFlight;
          throw error;
        }
      );
    current.inFlight = inFlight;
    return inFlight;
  };
}
