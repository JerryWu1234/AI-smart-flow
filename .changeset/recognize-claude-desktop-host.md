---
"@smartflow/cli": minor
---

Recognize Claude Desktop and other Claude MCP Host identities as aliases for the existing canonical `claude-code` Review strategy when no strategy is configured. Explicit Review configuration still wins, unknown Hosts still fall back to `codex`, and Review continues to run through the separate local Claude Code CLI rather than the Desktop GUI.
