# Run Concurrency and Pi Session Contract

## Identity and start

1. `smartflow_execute` resolves approved Task Markdown to a canonical absolute path.
2. In one atomic state mutation, Daemon verifies the path is absent from `activeRunsByTaskPath`, writes TaskSourceArtifact, creates the Run and binds `path → jobId`.
3. A duplicate path returns `TASK_ALREADY_ACTIVE` and the existing jobId without starting Pi or creating Git state.
4. The binding is released only after terminal reconciliation.

Relative, absolute and symlink aliases that identify the same file resolve to the same key. Case handling follows platform filesystem identity.

## Frozen task contents

- Pi Worker, RepairCoordinator and Reviewer receive only immutable Task Artifacts referenced by the Run.
- Editing, moving or deleting source Markdown after start does not change the active Run.
- Starting a future Run freezes the then-current bytes and receives a new source Hash.

## Concurrent Runs

- Different canonical task paths may execute and Review concurrently in the same Project.
- Each Run has independent jobId, fence, generation, Task Artifact, Pi Attempts/sessions, containment identity, Git object store, Revision workspace, Action, Review history and cancellation state.
- Project `state.json` remains one atomic recovery fact. Mutations take the Project lock and update only the target Run plus shared indexes.
- There is no code-path reservation or automatic merge. Two Runs may produce overlapping Candidates.
- Pi for one Run cannot read another Run workspace or session/runtime area.

## Pi Attempt/session behavior

- Host reconnect while the Daemon and child are alive continues the same job/Attempt/Pi session.
- If child or Daemon crashes, recovery first reconciles old containment, then creates a new Attempt/Pi session on the same Revision/workspace.
- If an Attempt reaches its frozen deadline, Daemon terminates and reconciles the containment, persists `TIMED_OUT`, and waits for Leader-controlled recovery before creating another Attempt.
- Approved repair creates a new Revision workspace from the previous Result Tree and a new Attempt/Pi session.
- New feature requests create a new Task/Run as classified by Leader.
- A session ID from one job or Revision cannot be submitted as another Attempt's identity.

## Publish serialization

1. An accepted Run obtains the Project Publish lease before preflight.
2. Preflight snapshots the current original project and checks only cumulative Candidate paths against immutable Run Baseline.
3. Strict atomic batch CAS commits all paths or none. Local preflight batch guarantees zero writes for detected conflicts but may return PARTIAL/UNKNOWN after writes begin.
4. The lease is released only after publish is durably reconciled.

Overlapping Candidate paths make the later Run return `PRECHECK_CONFLICT` with zero writes. Non-overlapping Candidates may publish sequentially.

## Recovery and cleanup

- Recovery rebuilds `activeRunsByTaskPath` from validated Run records and rejects duplicate active bindings as integrity failure.
- Cancellation and terminal transitions affect only the target job and terminate only its containment tree.
- `state.json`, not Pi session files, is the recovery truth.
- After terminal reconciliation, remove the task-path binding and temporary Git/Pi runtime state while retaining audit Artifact references.
