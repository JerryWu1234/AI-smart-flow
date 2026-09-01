---
"@smartflow/cli": patch
---

Remove the write-only `MetricsRegistry`. The Daemon recorded its start duration there but nothing ever read it back; the same duration is already in the `daemon.ready` and `daemon.start_failed` log records.
