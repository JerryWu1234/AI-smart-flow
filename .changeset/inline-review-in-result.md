---
"@jerrywu1234/smartflow": minor
---

Expose the recorded Review through the shared run result projection.

Per-Task `completionPercentage` and `issues` were only reachable on a
`USER_INPUT_REQUIRED` turn. Everywhere else the Host got an `ArtifactRef` with a
daemon-relative path and no tool to read it, so once a Review was submitted its findings
left the wire entirely: `DONE` carried no Review, and `smartflow_result` could not return
one.

`ResultOutput` now carries an optional `review` holding the latest durable `ReviewResult`.
Because that projection is shared, the same Review reaches the Host through
`smartflow_result` at any time, through `DONE`, and through
`USER_INPUT_REQUIRED.result`. The former top-level `USER_INPUT_REQUIRED.review` is removed
so the pause carries exactly one copy, matching how `repairDraft` is already carried.

The field is absent until a Review is recorded, and a damaged Review artifact degrades to
an absent field instead of failing the projection. Durable state, Review artifacts, and
decision mechanics are unchanged.
