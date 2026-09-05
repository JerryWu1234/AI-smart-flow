---
"@smartflow/cli": patch
---

Drop the unread `usage` and `ignoredLineCount` fields from the Codex CLI event state. Neither was consumed by the adapter; malformed and unknown JSONL lines are still skipped without aborting the run, and `turn.completed` still marks the turn complete regardless of its payload.
