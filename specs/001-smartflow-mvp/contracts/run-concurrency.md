# Run Concurrency, Host Turn, and Pi Session Contract

## Identity and start

1. `smartflow_execute` resolves approved Task Markdown to a canonical absolute path.
2. In one Project-wide CAS mutation, Daemon verifies the path is absent from `activeRunsByTaskPath`, writes TaskSourceArtifact, creates the Run, and binds `path → jobId`.
3. A duplicate path returns `TASK_ALREADY_ACTIVE` and the existing jobId without starting Pi or creating Git state.
4. The binding is released only after terminal reconciliation.

Relative, absolute, and symlink aliases that identify the same file resolve to the same key. Case handling follows platform filesystem identity.

## Frozen task contents

- Pi Worker and Reviewer use the synchronized canonical task file in the isolated Run workspace; RepairCoordinator feedback remains separately bound to the Revision.
- Editing, moving, or deleting source Markdown after start does not change the active Run.
- Starting a future Run freezes the then-current bytes and receives a new source Hash.

## Concurrent Runs and state mutation

- Different canonical task paths may execute and Review concurrently in the same Project.
- Each Run has independent jobId, fence, generation, Task Artifact, Pi Attempts/sessions, containment identity, Git object store, Revision workspace, Action, Review history, `hostTurn`, automatic repair counter, and cancellation state.
- Concurrent `smartflow_review_turn` operations for one Run meet at the Project-wide CAS boundary; only one mutation commits and a stale contender returns a fresh no-path continuation.
- Project `state.sqlite` remains one atomic recovery fact shared by all Runs. Every mutation validates `expectedStateVersion` and changes only the target Run plus shared indexes.
- Deterministic child request IDs derive from `turnToken`; a lost response is reconstructed from durable state without duplicating Review begin, finalization, repair, resume, or Publish effects.
- There is no code-path reservation or automatic merge. Two Runs may produce overlapping Candidates; Publish resolves overlap.
- Pi for one Run cannot read another Run workspace or session/runtime area.

## Durable Host-turn ownership

- An active composite turn is owned by stable `hostTurnId + turnToken + revision`.
- One CAS mutation validates current Review context and writes `REVIEWING + AWAITING_REVIEW + reviewAttemptId + deadlineAt`; only this stage may yield `REVIEW_REQUIRED` with `worktreePath`.
- `AWAITING_USER_INPUT` durably records a pause that only the owning Host may answer through `smartflow_review_turn` with the active `turnToken`; public `smartflow_resume` cannot answer or bypass this checkpoint.
- A different Host ID is rejected. A stale token causes no mutation and receives current no-path `NOT_READY`.
- The only Review timer is the durable 30-minute deadline. No short claim lease or renew loop exists.

## Pi Attempt/session behavior

- Host reconnect while the Daemon and child are alive continues the same job/Attempt/Pi session.
- If child or Daemon crashes, recovery first reconciles old containment, then creates a new Attempt/Pi session on the same Revision/workspace.
- If an Attempt reaches its frozen deadline, Daemon terminates and reconciles the containment, persists `TIMED_OUT`, and waits for allowed recovery before creating another Attempt.
- Automatic approved-scope repair creates a new Revision workspace from the previous Result Tree and a new Attempt/Pi session.
- New feature requests create a new Task/Run as classified by Host/Leader from user intent.
- A session ID from one job or Revision cannot be submitted as another Attempt's identity.

## Review-turn recovery authority

1. On Daemon startup, `ProjectRuntime` advances its runtime epoch under CAS.
2. If a Run has durable `hostTurn`, `HostTurnCoordinator.recoverRun()` is the sole authority for restoring the Review turn and checking its single 30-minute deadline.
3. `ProjectRuntime` then rereads fresh state. While `hostTurn` remains, it MUST NOT schedule ordinary pipeline/publish/cancel recovery for that Run.
4. `AWAITING_REVIEW` recovery preserves the same owner, token, Review attempt, Reviewer session binding, and deadline. An expired deadline is durably converted to a typed user-input pause; recovery never recreates an Action or starts a lease-renewal loop.
5. `AWAITING_USER_INPUT` requires no background action and remains available only to the owning Host.
6. `state.sqlite`, not in-memory queues/timers, Host requests, or Pi/Reviewer session files, is the recovery truth.

## Publish serialization

1. A mechanically accepted Run obtains the Project Publish lease before preflight.
2. Preflight snapshots the current original project and checks only cumulative Candidate paths against immutable Run Baseline.
3. Strict atomic batch CAS commits all paths or none. Local preflight batch guarantees zero writes for detected conflicts but may return PARTIAL/UNKNOWN after writes begin.
4. The lease is released only after Publish is durably reconciled.

Overlapping Candidate paths make the later Run return `PRECHECK_CONFLICT` with zero writes. Non-overlapping Candidates may publish sequentially.

## Recovery and cleanup

- Recovery rebuilds `activeRunsByTaskPath` from validated Run records and rejects duplicate active bindings as integrity failure.
- Cancellation and terminal transitions affect only the target job and terminate only its containment tree.
- Terminal `DONE` is emitted only for `COMPLETED`, `CANCELED`, or `FAILED`; pauses/conflicts remain typed user-input states.
- After terminal reconciliation, remove the task-path binding and temporary Git/Pi runtime state while retaining audit Artifact references.
