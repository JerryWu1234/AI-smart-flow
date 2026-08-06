import { claimActionInputSchema, claimActionOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createClaimActionHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_claim_action",
    claimActionInputSchema,
    claimActionOutputSchema
  );
}
