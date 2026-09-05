---
"@smartflow/cli": patch
---

Remove unused mutation-owner identifiers, duplicate idempotency receipt metadata and unused recovery bookkeeping. Upgrade SQLite layout 5 to 6 transactionally while preserving tasks, replay responses and active lease ownership.
