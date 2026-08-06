import { cancelInputSchema, cancelOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createCancelHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(gateway, "smartflow_cancel", cancelInputSchema, cancelOutputSchema);
}
