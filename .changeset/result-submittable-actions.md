---
"@jerrywu1234/smartflow": patch
---

Advertise only submittable actions in the public run result.

`ResultOutput.nextActions` and `ResultOutput.error.nextActions` projected the durable
action lists verbatim, so they still offered read-only markers such as `inspect_recovery`
and `prepare_repair` that no public tool accepts. A caller following them got a schema
rejection from `smartflow_resume`, and inside `USER_INPUT_REQUIRED` those lists disagreed
with the submittable `options` beside them.

Both fields are now filtered to actions `smartflow_resume` accepts. The single projection
in `ProjectRuntime.result()` is shared by `smartflow_result`, `USER_INPUT_REQUIRED.result`,
and `DONE.result`, so all three agree. Durable state, pause codes, and the evidence in
`result.artifacts` are unchanged.
