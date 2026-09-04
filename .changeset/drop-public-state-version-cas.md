---
"@jerrywu1234/smartflow": major
---

Remove `expectedStateVersion` from the public MCP resume and cancel inputs, and make public `smartflow_execute` a strict zero-argument, session-bound call. The MCP adapter now owns the canonical project root and task path, tracks the session file version, and generates the execute idempotency request ID before calling the Daemon's internal three-field execute interface. The Daemon reads and snapshots task content once when it creates the Job. Resume and cancel callers still use their own `requestId` values for idempotent retries and operation-specific guards.

Clients must call `smartflow_execute` with `{}`; strict public input schemas reject all fields.
