---
"@smartflow/cli": minor
---

Add the `claude-code` daemon Review strategy, selected explicitly or by a matching Claude Code MCP Host identity when no strategy is configured. The adapter runs the local `claude -p` CLI with resumable sessions, draft-07 structured output, and read-only `Read`, `Glob`, and `Grep` tools while disabling project customizations, MCP tools, Chrome, shell access, and write tools.

Claude Code startup, authentication, execution, schema, and result failures use the existing Review retry and deadline budget before SmartFlow pauses the Job. The default and unrecognized-Host fallback remains `codex`; no Claude version preflight or new runtime dependency is added.
