import { resultInputSchema, resultOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createResultHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(gateway, "smartflow_result", resultInputSchema, resultOutputSchema);
}
