import { resumeInputSchema, resumeOutputSchema } from "@smartflow/protocol";
import { createValidatedHandler, type DaemonGateway, type ValidatedHandler } from "../daemon-gateway.js";

export function createResumeHandler(gateway: DaemonGateway): ValidatedHandler {
  return createValidatedHandler(gateway, "smartflow_resume", resumeInputSchema, resumeOutputSchema);
}
