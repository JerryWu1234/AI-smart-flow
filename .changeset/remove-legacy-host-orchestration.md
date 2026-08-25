---
"@smartflow/cli": major
---

Remove `HostActionLoop` and the obsolete manual Review-orchestration MCP surface.

The public MCP surface now has exactly six tools. `smartflow_execute` and `smartflow_review_turn` form the sole Review orchestration flow; `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` independently provide Run inspection, recovery, cancellation, and result management.
