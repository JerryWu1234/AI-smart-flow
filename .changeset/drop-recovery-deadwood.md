---
"@smartflow/cli": patch
---

Remove recovery dead code: the write-only `workerEpoch` metadata, the ignored `continueCancellation` job argument, the unreachable `PENDING` and `MISMATCH` publish observation statuses, and two repair-continuation fields no consumer reads.
