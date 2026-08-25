---
"@smartflow/cli": major
---

Move Review execution into the Daemon and make the Host-facing review turn a polling-only protocol.

The Daemon now launches and resumes the configured Codex Reviewer, persists its result, drives repair or publish, and recovers interrupted daemon-owned Review turns. Hosts only call `smartflow_execute` and poll `smartflow_review_turn`; the former `REVIEW_REQUIRED` response, review submission input, and `reviewUnavailableReason` output have been removed. Completed Review data is available from `DONE.result.review` and `smartflow_result`.

The local IPC handshake now uses the current wire shape directly without a separate version marker. `ReviewIssue.suggestedFix` is now required and nullable (`string | null`), with the Review JSON Schema generated directly from the shared protocol schema.