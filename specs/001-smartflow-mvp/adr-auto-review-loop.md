# ADR: Host-Orchestrated Automatic Review Loop

## Status

Accepted and implemented in the Host-owned workflow.

## Decision

`smartflow_execute` starts a Run. The Codex Leader then owns the complete
orchestration loop:

1. Wait for the Worker to finish its current coding round.
2. When a Review Action is available, create or resume the independent
   Reviewer session and provide the immutable `task.md` plus the changed-file
   list.
3. Submit the structured Reviewer result.
4. If any task is below 100%, automatically start the next repair round with
   the Reviewer feedback; do not wait for user confirmation.
5. If every task is 100%, automatically accept the Review and publish.
6. Stop the automatic loop after 15 repair rounds. The user then
   reviews the unchanged `task.md` and decides whether to continue. Each
   continue decision grants 15 additional automatic rounds.
   If the user declines, retain the Candidate and Review information in a
   viewable paused state; do not publish or clean it up.
7. For transient network failures or failure to create the independent
   Reviewer session, retry creation up to three times. If all three attempts
   fail, pause and report the root cause to the user.

The Daemon remains responsible for state transitions and publishing. It must
not create the Reviewer session itself.

A retry may create a new Reviewer session only when creation never succeeded.
Once a Reviewer session is durably bound, later review attempts must use that
same session.

Every repair round in the same Run resumes the Reviewer session created for
the first review. No replacement Reviewer session is created for that Run.
Each review receives the full changed-file list from the Run baseline through
the current Candidate. The bound session's own history may aid understanding,
but never reduces the review input.
The Reviewer receives read-only access to query the immutable Candidate's
current file contents and diffs as needed. The Leader supplies paths and this
query access rather than embedding file contents or internal Git hashes in the
prompt.
The Reviewer may also read unchanged project files when needed for context,
while keeping its completion judgment limited to the frozen `task.md`.

If the bound Reviewer session is lost, cannot be resumed, or remains
unavailable, pause the workflow and report the root cause. Do not create a
replacement Reviewer session.

Pause notifications show only the root cause, current overall completion
percentage, and the incomplete tasks' reasons and suggestions. They do not
expose stacks, internal paths, or verbose logs.

If automatic publishing conflicts or otherwise fails after a 100% Review,
retain the Candidate in a viewable paused state and report only the publish
failure's root cause to the user.

The initial Worker coding-and-review pass does not count toward the 15-round
limit. Only later repair rounds triggered by an incomplete Reviewer result are
counted.
No-progress observations do not end the loop early. Continue repair rounds
until the 15-round allowance is exhausted or the Reviewer reports 100%.

If the bound Reviewer returns an invalid result format, the Leader asks that
same session to correct the result and retries submission up to three times.
After the third invalid result, the workflow pauses and reports the root cause
to the user.

The Reviewer does not run tests, lint, builds, or other commands. Separate
Agents own those validation activities; this loop only reviews task completion
and drives narrowly scoped repairs.
Those independent validation Agents do not gate or otherwise affect this
loop's automatic publish decision.

## Reviewer Result

The Reviewer reports only task completion and repair guidance:

```json
{
  "reviewerSessionId": "reviewer-session-id",
  "completionPercentage": 75,
  "tasks": [
    {
      "id": "T001",
      "completionPercentage": 50,
      "reason": "目标 JSON 内容不符合验收条件",
      "suggestion": "按 task.md 中规定的字段和值重写文件内容"
    },
    {
      "id": "T002",
      "completionPercentage": 100
    }
  ]
}
```

`completionPercentage` is the rounded arithmetic mean of every task's
completion percentage. A fully complete task omits `reason` and `suggestion`.

## Task Immutability

The original approved `task.md` stays unchanged across repair rounds. The
Reviewer result is supplied separately as the repair instruction, so the
acceptance standard remains stable and feedback cannot expand the task scope.
Every repair Worker receives that complete immutable `task.md`, but its repair
instruction contains only incomplete task IDs, completion percentages, reasons,
and suggestions. The Leader retains the complete Reviewer result for viewing
without forwarding completed-task details to the Worker.

## Consequences

- A raw `smartflow_execute` call alone is not an end-to-end workflow; the
  Codex Leader must run the Host loop.
- Reviewer findings are focused on the approved task and changed files, which
  constrains repairs to the original scope.
- Files unrelated to `task.md` do not affect the Reviewer result. They may be
  user changes and must neither block publishing nor trigger deletion.
- The existing verbose Review MCP payload must be adapted before this compact
  result can be submitted directly.
