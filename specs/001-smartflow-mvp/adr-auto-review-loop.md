# ADR: Host-Orchestrated Automatic Review Loop (Historical)

## Status

Superseded on 2026-08-11 by [ADR: Daemon-Owned Mechanical Review Turn](adr-daemon-owned-review-turn.md). The historical ownership rationale below is retained, but its Review payload, data, and decision terminology is normalized to the current contract. It MUST NOT be used as the current ownership contract.

## Historical Decision

`smartflow_execute` starts a Run. Under this superseded design, the Codex
Leader owned the complete orchestration loop:

1. Wait for the Worker to finish its current coding round.
2. When a Review Action is available, create or resume the independent
   Reviewer session in the Run worktree and provide the changed-file list.
   The Reviewer reads the worktree's synchronized `task.md` directly.
3. Submit the Reviewer session ID and the single ReviewResult as
   `review.result`.
4. If the valid ReviewResult is incomplete and fewer than 15 repair rounds
   have run, start the next repair round from every Issue in every incomplete
   Task; do not wait for user confirmation and do not select or add scope.
5. If every Task is 100%, apply `ACCEPT` and publish.
6. If an incomplete ReviewResult arrives after 15 repair rounds, apply
   `PAUSE_REPAIR_LIMIT`. The user then reviews the unchanged `task.md` and
   decides whether to continue. Each continue decision grants 15 additional
   automatic rounds. If the user declines, retain the Candidate and Review
   information in a viewable paused state; do not publish or clean it up.
7. For transient network failures or failure to create the independent
   Reviewer session, retry creation up to three times. If all three attempts
   fail, pause and report the root cause to the user. This is an operational
   pause, not a Review decision.

The Daemon remained responsible for state transitions and publishing. It did
not create the Reviewer session itself. The current ADR moves the deterministic
steps above into the Daemon without changing the ReviewResult contract.

A retry may create a new Reviewer session only when creation never succeeded.
Once a Reviewer session is durably bound, later review attempts must use that
same session.

Every repair round in the same Run resumes the Reviewer session created for
the first review. No replacement Reviewer session is created for that Run.
Each review receives the full changed-file list from the Run baseline through
the current Candidate. The bound session's own history may aid understanding,
but never reduces the review input.
The Worker writes into one Run-scoped isolated Git worktree. The independent
Reviewer opens that same worktree read-only and inspects current files and
diffs there. There is no separate review-content Artifact or content proxy.
The original project's canonical `task.md` is the source of truth. Whenever
that source file changes, SmartFlow mirrors its complete bytes to the same
canonical path in the Run worktree. Worker and Reviewer both read that mirrored
worktree file. The Leader still supplies the full cumulative changed-file list
on every review round. That list is an inspection input, not a ReviewResult
property or an additional acceptance predicate.
The Reviewer may also read unchanged files from the Run worktree when needed
for context, while keeping its completion judgment limited to the frozen
`task.md`.

The original project worktree remains untouched until a valid ReviewResult has
every Task at 100% and the mechanical plan is `ACCEPT`. Publish applies the
accepted Run-worktree Candidate to the original project with the existing
conflict checks.

Existing workflow phase sequencing remains responsible for ensuring the
Worker has finished before Review starts. This design adds no worktree freeze,
permission-mode transition, additional lock, or stale-worktree mechanism.
Reviewer read-only behavior is a role constraint, not a new filesystem state.

After the Leader successfully claims a Review Action, SmartFlow returns the
absolute Run-worktree path to that trusted Leader. The Leader opens or resumes
the bound Reviewer session with that path as its working directory. This path
is limited to the claimed Review flow: it is not returned by ordinary status,
written to logs or pause messages, or supplied to the Worker as review input.
SmartFlow does not add an opaque worktree handle or an Artifact/content query
proxy for Reviewer file access.

If the bound Reviewer session is lost, cannot be resumed, or remains
unavailable, pause the workflow and report the root cause. Do not create a
replacement Reviewer session.

Pause notifications show only the root cause and each incomplete Task's Issue
`path`, `message`, and optional `suggestedFix`. They do not aggregate Task
scores or expose stacks, internal paths, or verbose logs.

If automatic publishing conflicts or otherwise fails after `ACCEPT`, retain
the Candidate in a viewable paused state and report only the publish failure's
root cause to the user.

The initial Worker coding-and-review pass does not count toward the 15-round
limit. Only later repair rounds triggered by an incomplete ReviewResult are
counted. Each valid incomplete round stores `run.recovery.repairRound` with
`failureIds`, full `tasks`, and Candidate-operation `relevantPathHashes` (using
`DELETED` for deletions). No-progress identity uses only failure IDs and
`(TaskReview.id, Issue.path)` plus the relevant hashes; a strict problem-scope
reduction or relevant hash change is progress. Changes only to `message` or
`suggestedFix` do not count. The first comparison initializes
`noProgressCount` to zero; the default no-progress pause threshold is 15.
No-progress is an operational repair pause, not another Review decision.

If a submitted Review payload violates the strict model or current binding,
reject it before writing any artifact or state. The Run and active checkpoint
remain unchanged, and no mechanical decision is produced. The same bound
Reviewer session may correct and resubmit within the active deadline; invalid
submissions do not create a retry-count pause.

The Reviewer does not run tests, lint, builds, or other commands. Separate
Agents own those validation activities; this loop only reviews task completion
and drives narrowly scoped repairs. Those independent validation Agents do not
gate or otherwise affect this loop's automatic publish decision.

## Reviewer Result

The submission envelope carries Reviewer-session metadata separately. Its
`review.result` value is the only Review data model:

```text
ReviewResult = { tasks: TaskReview[] }
TaskReview = { id, completionPercentage, issues }
Issue = { path, message, suggestedFix? }
```

For example, this is the relevant `smartflow_review_turn` input fragment:

```json
{
  "review": {
    "reviewerSessionId": "reviewer-session-id",
    "result": {
      "tasks": [
        {
          "id": "T001",
          "completionPercentage": 50,
          "issues": [
            {
              "path": "src/config/load-config.ts",
              "message": "loadConfig() returns undefined when the mode key is absent, causing startup to fail before defaults are applied",
              "suggestedFix": "Apply the documented default mode before returning the parsed configuration"
            }
          ]
        },
        {
          "id": "T002",
          "completionPercentage": 100,
          "issues": []
        }
      ]
    }
  }
}
```

Task IDs are unique and exactly cover `manifest.enabledTaskIds`. A Task is 100%
if and only if its `issues` array is empty; every incomplete Task has at least
one Issue. Within one Task, `(path, message)` is unique. For Issue paths, the
strict schema trims and requires a non-empty value, rejects a leading `/`, any
backslash, and any empty/`.`/`..` slash-delimited segment; it does not separately
classify drive-qualified forms, inspect the filesystem, or judge natural-language
specificity. `message` and a present `suggestedFix` must be non-empty. Separately,
the Reviewer prompt requires the message to identify the concrete function or behavior,
trigger, and impact. ReviewResult, TaskReview, and Issue accept no additional
data fields.

The durable Review and Leader artifacts both use `schemaVersion: 2`. The Review
artifact contains its Revision, claim/attempt IDs, Reviewer and Pi session IDs,
`candidateHash`, `taskSourceHash`, `gate`, and `reviewHash`; the hash covers the
canonical body without the hash field. The Leader artifact contains only its
Revision, `reviewHash`, decision, reason, decision time, and `decisionHash`, so
Candidate/task-source binding is transitive and no repair list is duplicated.
Artifact v1 is incompatible: strict v2 parsing rejects it, and recovery pauses
or blocks the affected Run with `ARTIFACT_SEMANTIC_VALIDATION_FAILED`. Operators
may choose a fresh Data Directory for a new deployment, but the runtime has no
versioned directory format or marker/probe.

## Task Synchronization

The original project's canonical `task.md` is the sole task source. SmartFlow
detects any change to that file and synchronizes the complete current bytes to
the matching canonical task path inside the Run worktree. Worker and Reviewer
both read this same mirrored worktree file; the Review flow does not use a
separate task-content payload or task Artifact path.

The workflow assumes the canonical task source does not change while a Worker
or Reviewer is active. Mid-round task changes, cancellation, stale-result
handling, and automatic restart are outside this historical ownership design.

Repair guidance remains the full set of Issues in the exact ReviewResult. The
complete ReviewResult is retained for viewing, and every Issue belonging to an
incomplete Task is forwarded deterministically; neither the historical Leader
nor the current Daemon may choose a subset or append new repair scope.

## Consequences

- Under the historical ownership model, a raw `smartflow_execute` call alone
  was not an end-to-end workflow; the Codex Leader had to run the Host loop.
- Reviewer Issues stay attached to approved Task IDs and project-relative
  files, which constrains repairs to the original scope.
- Worker and Reviewer inspect the same filesystem state; no ArtifactRef path
  resolution is required to review file contents.
- Claimed Review Actions expose the Run-worktree path directly to the trusted
  Leader instead of introducing a second file-access protocol.
- The Run worktree remains isolated from the original project until publish.
- Files unrelated to `task.md` do not affect the Reviewer result. They may be
  user changes and must neither block publishing nor trigger deletion.
- The compact ReviewResult is submitted directly in `review.result`; durable
  evidence and the mechanical Leader decision remain separate artifacts.
