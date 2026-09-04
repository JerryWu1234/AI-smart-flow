import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
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
  sourceVersion: string;
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
    const source = await stat(
      resolve(session.projectRoot, session.tasksPath),
      { bigint: true }
    );
    const sourceVersion = [
      source.dev,
      source.ino,
      source.size,
      source.mtimeNs,
      source.ctimeNs
    ].join(":");

    let current = pending;
    if (current === undefined || current.sourceVersion !== sourceVersion) {
      current = {
        sourceVersion,
        requestId: `execute:${session.sessionId}:${randomUUID()}`
      };
      pending = current;
    }
    if (current.receipt !== undefined) return current.receipt;
    if (current.inFlight !== undefined) return current.inFlight;

    const request = daemonExecuteInputSchema.parse({
      projectRoot: session.projectRoot,
      tasksPath: session.tasksPath,
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
