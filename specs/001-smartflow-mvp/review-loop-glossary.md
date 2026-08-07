# Review Loop Glossary

| Term | Meaning |
| --- | --- |
| Leader | The Codex session that drives MCP calls, evaluates Review results, starts repair rounds, and accepts publish. |
| Worker | The coding session that implements the approved tasks in the Run worktree. |
| Reviewer | An independent Codex session that opens the Run worktree read-only, compares its synchronized `task.md` with the changed-file list, and reports task completion. |
| Run worktree | The Run-scoped isolated Git worktree shared by the Worker for writes and the Reviewer for read-only inspection. It is not the user's original project worktree. |
| Canonical task source | The original project's `task.md`; it is the sole source of truth for task content. |
| Synchronized task | A byte-for-byte mirror of the canonical task source at the same relative path in the Run worktree, read by both Worker and Reviewer. |
| Task-sync precondition | The canonical task source changes only while no Worker or Reviewer is active; mid-round task changes are outside the workflow contract. |
| Claimed worktree path | The absolute Run-worktree path disclosed only after a trusted Leader claims the current Review Action. It is not exposed through ordinary status, logs, pauses, or Worker input. |
| Bound Reviewer session | The first successfully created Reviewer session for a Run. Every later repair round resumes this same session. |
| Full changed-file list | The complete set of changed files from the Run baseline through the current Candidate, supplied on every review round. |
| Worktree review access | Read-only access for the Reviewer to inspect current files and diffs directly in the Run worktree. |
| Review file-access boundary | Direct filesystem access to the claimed Run worktree; no opaque handle or Artifact/content query proxy exists. |
| Context read | Read-only access to unchanged Run-worktree files when needed to understand a change; it does not expand the review scope beyond `task.md`. |
| Bound-session failure | A lost or unrecoverable bound Reviewer session pauses the workflow and reports the root cause; it is never replaced. |
| Pause notification | A concise user-facing report containing the root cause, completion percentage, and incomplete-task guidance only. |
| Publish failure | A publish conflict or failure that retains the Candidate in a viewable paused state and reports only its root cause. |
| External validation Agent | An independently run test, lint, or validation Agent whose outcome does not gate this review loop's publish decision. |
| Review Action | The durable signal that a Worker result is ready for independent review. |
| Repair feedback | The Reviewer task-level completion, reason, and suggestion passed separately to the Worker for the next coding round. |
| Repair instruction | The subset of Review feedback for incomplete tasks only, applied against the synchronized full `task.md`. |
| Completion percentage | The rounded arithmetic mean of all individual task completion percentages. |
| Round limit | At most 15 repair rounds run automatically. The initial coding-and-review pass is excluded; continuing grants 15 additional repair rounds. |
| No-progress observation | Repeated unchanged completion or feedback does not pause the loop early; the current 15-round allowance still applies. |
| Viewable pause | A stopped run retains its Candidate and Review information for inspection, without publishing or cleanup. |
| Reviewer creation retry | The Leader retries a failed Reviewer-session creation or transient network failure up to three times, then pauses with the root cause. |
| Reviewer format retry | A bound Reviewer has up to three attempts to correct an invalid structured result; then the workflow pauses with the root cause. |
| Publish | Applying an accepted Candidate to the original project after every approved task reaches 100%. |
