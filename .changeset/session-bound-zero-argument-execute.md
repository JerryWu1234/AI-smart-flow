---
"@smartflow/cli": major
---

Make public `smartflow_execute` a strict zero-argument MCP tool. Each stdio MCP session now binds one canonical project root and a generated `.smartflow/tasks/<sessionId>/tasks.md` path, then reads and hashes that file and generates the internal execute idempotency request ID automatically.

Clients must obtain the session task path from MCP instructions, write and confirm that file, and call `smartflow_execute({})`. The Daemon's internal execute request retains `projectRoot`, `tasksPath`, `approvedSourceHash`, and `requestId` so existing source-drift, immutable artifact, and replay protections remain intact.
