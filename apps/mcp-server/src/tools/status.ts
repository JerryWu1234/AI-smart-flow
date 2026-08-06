import { statusInputSchema, statusOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createStatusHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(gateway, "smartflow_status", statusInputSchema, statusOutputSchema);
}
