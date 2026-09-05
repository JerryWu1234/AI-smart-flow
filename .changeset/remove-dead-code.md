---
"@smartflow/cli": patch
---

Remove unused repair-progress draft generation, unread internal return fields,
and the unreferenced ExecuteInput type. Build the CLI only from its executable
entry instead of also emitting an empty workspace entry. Remove stale build
configuration for the deleted flow visualizer and the unused YAML external entry.

The six MCP tools, immutable task artifacts, out-of-scope repair drafts, and
review/publish behavior are unchanged.
