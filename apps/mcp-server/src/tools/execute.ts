import { executeInputSchema, executeOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createExecuteHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_execute",
    executeInputSchema,
    executeOutputSchema
  );
}
