import {
  renewActionClaimInputSchema,
  renewActionClaimOutputSchema
} from "@smartflow/protocol";

import {
  createValidatedHandler,
  type DaemonGateway,
  type ValidatedHandler
} from "../daemon-gateway.js";

export function createRenewActionClaimHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_renew_action_claim",
    renewActionClaimInputSchema,
    renewActionClaimOutputSchema
  );
}
