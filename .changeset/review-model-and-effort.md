---
"@jerrywu1234/smartflow": minor
---

Make the Review model and reasoning effort configurable, and fix the repair-round Review invocation.

`review.model` and the new `review.effort` are optional overrides forwarded to the Review Agent on every round, including resumed repair rounds. When omitted, SmartFlow does not pass model or reasoning-effort arguments, so the selected Review Agent uses its own defaults. Neither value is validated against an allow list; any non-empty string is accepted, and an unsupported value surfaces as a Review failure with the Agent's own diagnostic rather than a configuration error.

This also fixes a Review defect: the Codex adapter forwarded `--sandbox` and `--cd` when resuming a session, and `codex exec resume` rejects both. Every repair round therefore failed before Codex started. The sandbox is now requested through `-c sandbox_mode` on both invocations, the worktree comes from the spawned process working directory, and `--cd` stays on session creation only. The Codex test fixture now validates its argv against the flags the real CLI accepts so an unsupported flag fails in tests too.
