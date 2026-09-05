---
"@smartflow/cli": patch
---

Remove unused mutation-owner identifiers, duplicate idempotency receipt metadata and unused recovery bookkeeping.

Use SQLite layout 6 only, with no migration or compatibility reads. Clear local development data with `pnpm clean:daemon-data` before using the new layout.
