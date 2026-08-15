---
"@smartflow/cli": major
---

Remove the `smartflow provider-gate` command and its `runInstalledPiGate` implementation.

The command was an installed-package acceptance harness: it synthesized a task manifest and state store, required a `sum.js` fixture in the target project, and spent a real model attempt to assert one Worker transition. `tests/e2e/installed-package.test.ts` already covers the installed binary through the full `smartflow_execute → smartflow_review_turn* → publish` lifecycle, so the command had no remaining caller in tests, CI, or documentation. Installed readiness checks stay with `smartflow doctor`.
