---
"@smartflow/cli": patch
---

Remove three populated-but-unread fields and one unreachable check: `ProjectMutationContext.run`, `ParsedTask.line`, and the duplicate Task ID branch in `validateTaskSelection` that parsing already rejects.
