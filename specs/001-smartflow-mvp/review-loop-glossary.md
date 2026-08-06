# Review Loop Glossary

| Term | Meaning |
| --- | --- |
| Leader | The Codex session that drives MCP calls, evaluates Review results, starts repair rounds, and accepts publish. |
| Worker | The coding session that implements the approved tasks in an isolated workspace. |
| Reviewer | An independent Codex session that compares the immutable `task.md` with the changed-file list and reports task completion. |
| Bound Reviewer session | The first successfully created Reviewer session for a Run. Every later repair round resumes this same session. |
| Full changed-file list | The complete set of changed files from the Run baseline through the current Candidate, supplied on every review round. |
| Candidate query access | Read-only access for the Reviewer to inspect the immutable Candidate's current files or diffs. |
| Context read | Read-only access to unchanged project files when needed to understand a change; it does not expand the review scope beyond `task.md`. |
| Bound-session failure | A lost or unrecoverable bound Reviewer session pauses the workflow and reports the root cause; it is never replaced. |
| Pause notification | A concise user-facing report containing the root cause, completion percentage, and incomplete-task guidance only. |
| Publish failure | A publish conflict or failure that retains the Candidate in a viewable paused state and reports only its root cause. |
| External validation Agent | An independently run test, lint, or validation Agent whose outcome does not gate this review loop's publish decision. |
| Review Action | The durable signal that a Worker result is ready for independent review. |
| Repair feedback | The Reviewer task-level completion, reason, and suggestion passed separately to the Worker for the next coding round. |
| Repair instruction | The subset of Review feedback for incomplete tasks only, sent alongside the unchanged full `task.md`. |
| Completion percentage | The rounded arithmetic mean of all individual task completion percentages. |
| Round limit | At most 15 repair rounds run automatically. The initial coding-and-review pass is excluded; continuing grants 15 additional repair rounds. |
| No-progress observation | Repeated unchanged completion or feedback does not pause the loop early; the current 15-round allowance still applies. |
| Viewable pause | A stopped run retains its Candidate and Review information for inspection, without publishing or cleanup. |
| Reviewer creation retry | The Leader retries a failed Reviewer-session creation or transient network failure up to three times, then pauses with the root cause. |
| Reviewer format retry | A bound Reviewer has up to three attempts to correct an invalid structured result; then the workflow pauses with the root cause. |
| Publish | Applying an accepted Candidate to the original project after every approved task reaches 100%. |
