import { submitReviewInputSchema, submitReviewOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createSubmitReviewHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_submit_review",
    submitReviewInputSchema,
    submitReviewOutputSchema
  );
}
