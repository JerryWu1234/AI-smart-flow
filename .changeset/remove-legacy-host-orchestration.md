---
"@smartflow/cli": major
---

Remove `HostActionLoop` and the five manual Review orchestration MCP tools: `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision`.

The public MCP surface now has exactly six tools. `smartflow_execute` and `smartflow_review_turn` form the sole Review orchestration flow; `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` independently provide Run inspection, recovery, cancellation, and result management.
