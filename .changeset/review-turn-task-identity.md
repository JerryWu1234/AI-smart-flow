---
"@jerrywu1234/smartflow": minor
---

Allow the active Host turn owner to cancel a Run directly.

`smartflow_cancel` accepts an optional `hostTurnId`. Cancellation remains owner-bound: a caller that cannot identify the active turn receives `HOST_TURN_ACTIVE`, so an unrelated caller cannot abort someone else's Run. Naming the owning turn lets that Host cancel without first driving another composite turn, and cancellation clears the turn it ends.
