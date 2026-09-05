---
"@smartflow/cli": patch
---

Remove unused mutation-owner identifiers, duplicate idempotency receipt metadata and unused recovery bookkeeping.

Remove SQLite layout version tracking and checks; use the current table definitions directly. No migration is provided. Local development data can be reset with `pnpm clean:daemon-data` when table definitions change.
