import { waitInputSchema, waitOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createWaitHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(gateway, "smartflow_wait", waitInputSchema, waitOutputSchema);
}
