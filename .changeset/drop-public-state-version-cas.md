---
"@jerrywu1234/smartflow": major
---

Remove `expectedStateVersion` from the public MCP execute, resume, and cancel inputs. The Daemon now owns state-version concurrency checks internally, while callers use `requestId` for idempotent retries and operation-specific guards for validity.

Clients must stop sending `expectedStateVersion` because the strict input schemas reject unknown fields.
