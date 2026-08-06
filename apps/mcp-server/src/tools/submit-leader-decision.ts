import { submitLeaderDecisionInputSchema, submitLeaderDecisionOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createSubmitLeaderDecisionHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_submit_leader_decision",
    submitLeaderDecisionInputSchema,
    submitLeaderDecisionOutputSchema
  );
}
