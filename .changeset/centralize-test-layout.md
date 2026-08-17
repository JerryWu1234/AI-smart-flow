---
"@smartflow/cli": major
---

Remove the public `./host-skill` package export and its bundled artifact. Host applications now drive the six public MCP tools directly; repository-only Host workflow simulation remains under `tests/helpers/host-workflow`.
