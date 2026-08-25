---
"@smartflow/cli": major
---

Make daemon Review adapter selection strategy-driven, rename the supported `review.strategy` value from `daemon-codex` to `codex`, and remove the unused top-level configuration `version` field.

Existing SmartFlow configuration files must update `review.strategy` to `codex` and remove `version`.
