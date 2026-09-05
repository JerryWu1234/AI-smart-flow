---
"@smartflow/cli": patch
---

Remove 15 unreferenced `z.infer` type aliases from the protocol schema modules: `StructuredError` and `IdempotentReceipt` from common, `StatusInput`, `StatusOutput`, `ResumeOutput`, `CancelOutput` and `ResultInput` from the MCP tool schemas, and `ProcessIdentity`, `PiWorkerAttemptStatus`, `PublicPiWorkerAttempt`, `PiWorkerAttempt`, `ReviewIssue`, `DurableReviewGate`, `DurableLeaderDecision` and `PublishPathResult` from run state.

Every underlying Zod schema is retained and still exported, including the ones whose alias was dropped: `statusInputSchema`, `statusOutputSchema`, `resumeOutputSchema`, `cancelOutputSchema`, `resultInputSchema`, `piWorkerAttemptSchema`, `publicPiWorkerAttemptSchema`, `durableLeaderDecisionSchema` and the rest all keep active callers. Only the unused inferred type names are gone, so runtime behavior and validation are unchanged.
