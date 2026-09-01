---
"@smartflow/cli": minor
---

Add a distinct `claude-code-desktop` Review strategy and adapter factory for Desktop-host configuration. The compatibility adapter delegates Review execution to the separately installed local Claude Code CLI because Claude Desktop does not expose a headless reviewer transport; it does not attach to or control the Desktop GUI or its embedded sessions.
