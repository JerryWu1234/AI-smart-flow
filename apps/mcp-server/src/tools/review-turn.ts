import { reviewTurnInputSchema, reviewTurnOutputSchema } from "@smartflow/protocol";

import {
  createValidatedHandler,
  type DaemonGateway,
  type ValidatedHandler
} from "../daemon-gateway.js";

export function createReviewTurnHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(
    gateway,
    "smartflow_review_turn",
    reviewTurnInputSchema,
    reviewTurnOutputSchema
  );
}
