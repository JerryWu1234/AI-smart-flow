---
"@jerrywu1234/smartflow": minor
---

Name the reviewable Task set on `REVIEW_REQUIRED`, and let a turn owner cancel out of turn.

`REVIEW_REQUIRED` now carries `tasksPath` (the approved Task source, Project-relative
inside the disclosed worktree) and `taskIds` (the approved Task IDs to report). The
Daemon already rejected any Review that did not cover exactly those IDs, but never
disclosed them, so a Host had to parse the Task markdown and guess the ID set; a wrong
guess failed the whole submission with `REVIEW_TASK_COVERAGE_INCOMPLETE`. Both values are
read from the current Revision's durable Task Manifest, so a repair Revision reports its
own Task set.

`smartflow_cancel` accepts an optional `hostTurnId`. Cancellation stays owner-bound: a
caller that cannot name the active turn still gets `HOST_TURN_ACTIVE`, so an unrelated
caller cannot abort someone else's Run. Naming the owning turn lets that Host cancel
without first driving a full composite turn, and cancellation now clears the turn it ends.
