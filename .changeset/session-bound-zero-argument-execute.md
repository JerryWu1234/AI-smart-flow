---
"@smartflow/cli": major
---

Make public `smartflow_execute` a strict zero-argument MCP tool. Each stdio MCP session now binds one canonical project root and a generated `.smartflow/tasks/<sessionId>/tasks.md` path, observes that file's metadata version, and generates the internal execute idempotency request ID automatically.

Clients must obtain the session task path from MCP instructions, write and confirm that file, and call `smartflow_execute({})`. The Daemon's internal execute request retains only `projectRoot`, `tasksPath`, and `requestId`; the Daemon reads the task content once and immediately stores immutable source and manifest artifacts.
