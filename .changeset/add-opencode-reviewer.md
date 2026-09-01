---
"@smartflow/cli": minor
---

Add the `opencode` daemon Review strategy, selected explicitly with `REVIEW_ADAPTER=opencode` or by an exact OpenCode MCP Host identity when `REVIEW_ADAPTER` is omitted. The adapter starts a separate local `opencode run` process and session while reusing the Daemon's OpenCode installation, provider authentication, and durable session store.

OpenCode Review requires an explicit provider-qualified `REVIEW_MODEL`; `REVIEW_EFFORT` is forwarded as `--variant`. Each process runs from a private Git root with isolated OpenCode configuration and receives the candidate as an exact read-only external directory. Project and user plugins, MCP servers, shell, write, task, web, skill, and interactive tools are unavailable; only read, glob, and grep are exposed. Results are consumed from NDJSON, session identity is enforced across create/resume calls, and final output must be strict JSON before the existing Review schema and task-coverage checks run.

When OpenCode is selected explicitly, SmartFlow verifies that the `opencode` executable is on `PATH` before the MCP gateway or Daemon becomes ready. Authentication, provider, process, event, and output failures use the existing Review attempt and deadline policy. SmartFlow does not install or authenticate OpenCode, attach to the MCP Host conversation, provide custom executable configuration, recover in-flight sessions or orphan processes after a Daemon crash, or guarantee full process-tree cleanup on Windows.
