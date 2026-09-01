---
"@smartflow/cli": major
---

Move every Worker setting into a single `WORK_` environment namespace: `WORK_API`, `WORK_BASE_URL`, `WORK_MODEL`, `WORK_API_KEY`, `WORK_CONTEXT_WINDOW`, `WORK_MAX_TOKENS`, `WORK_EFFORT` and `WORK_ATTEMPT_DEADLINE_MS`. These eight names are both the MCP-facing surface and the daemon-to-Worker transport, so no key is translated between hops and there is no separate internal thinking-level variable. `REVIEW_ADAPTER`, `REVIEW_MODEL`, `REVIEW_EFFORT` and `SMARTFLOW_DATA_HOME` are unaffected.

MCP configurations must rename `API`, `BASE_URL`, `MODEL`, `API_KEY` and `EFFORT` to their `WORK_` equivalents, and replace `SMARTFLOW_PI_CONTEXT_WINDOW`, `SMARTFLOW_PI_MAX_TOKENS` and `SMARTFLOW_PI_ATTEMPT_DEADLINE_MS` with `WORK_CONTEXT_WINDOW`, `WORK_MAX_TOKENS` and `WORK_ATTEMPT_DEADLINE_MS`. There are no compatibility aliases and no detection of the former names: a stale configuration fails with `WORK_BASE_URL is required` or the equivalent missing-field error. SmartFlow no longer reads a bare `API_KEY`, so a global shell value can no longer be picked up by accident.

The Worker registration sent over local IPC carries the same eight field names, and a running Daemon accepts only those. Because the Provider fingerprint covers resolved configuration values rather than variable names, an older Daemon still accepts the connection and then rejects the registration. Stop the running Daemon, or point the gateway at a different `--data-dir`, after upgrading.
