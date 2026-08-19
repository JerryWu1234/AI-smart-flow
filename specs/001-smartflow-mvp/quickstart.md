# SmartFlow 4.1 Acceptance Walkthrough

This walkthrough validates the Pi migration, removal of Broker/OpenCode, daemon-owned mechanical orchestration, the composite Review turn, and retained isolated Git Workspace/Publish behavior.

## 1. Freeze task and Pi configuration

1. Provision a new, empty SmartFlow Data Directory for Review v2. Do not reuse a directory containing v1 Review/Leader artifacts; confirm v1 payloads and artifacts fail closed rather than migrate, fall back, or mix with v2.
2. Start the MCP server with exactly one configured model: `SMARTFLOW_PI_API`, `SMARTFLOW_PI_BASE_URL`, `SMARTFLOW_PI_MODEL`, and `SMARTFLOW_PI_API_KEY`.
3. Omit optional values and confirm context `1000000`, max output `384000`, thinking `high`, and rolling Attempt deadline `300000ms`; confirm deadline overrides below `60000ms` are rejected and repeat with legal overrides.
4. Start a Run from `tasks-a.md`; record canonical path, Task Artifact, `tasksSha256`, and `providerRuntimeConfigHash` while confirming the API Key is absent.
5. Confirm the canonical task file is mirrored to the Run workspace before Worker execution and the Reviewer reads that copy.
6. Change effective Pi runtime config; confirm the active Revision pauses/fails instead of changing model/API.
7. Start through a path alias; expect `TASK_ALREADY_ACTIVE` and no new Attempt/workspace.
8. Repeat parsing with each API: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.

## 2. Start sandboxed Pi

1. Confirm `ExecutionSandboxAdapter` launches the Pi SDK child and records Attempt, Pi session, and containment identity.
2. Confirm the child loads only the bundled SmartFlow model Extension and registers one MCP-configured model through Pi's official runtime API.
3. Confirm JSONL RPC ready/prompt/events/terminal flow plus the independent 30-second heartbeat that renews the configured deadline (five minutes by default).
4. Confirm the child uses the frozen Task, receives no SmartFlow MCP/Host-global Skill, and never asks the user directly.
5. Place `models.json` canaries in the host Pi directory and workspace; confirm neither is read and none is created.

## 3. Exercise Pi official tools

1. Ask Pi to read, search, add, modify, and delete project files, including `tasks.md` or `.specify` content inside the isolated workspace.
2. Run Shell commands that create child processes, execute project test/lint/build, and access a network fixture.
3. Confirm operations succeed without Broker receipts, effects, or tool-decision Actions.
4. Confirm Result Snapshot/Candidate contain project changes, not `.smartflow-runtime/` files.

## 4. Prove filesystem isolation

1. Attempt direct, absolute-path, symlink, and subprocess access to the original project root; expect denial.
2. Repeat for SmartFlow state, another Run workspace, and host-user sensitive data; expect denial.
3. Confirm required Node/system/Pi SDK bootstrap files are read-only and do not expose user data.
4. Confirm Publish has not run and original project Worktree/index/refs are unchanged.
5. Put absolute-path canaries in SDK errors, stacks, Shell output, and status; confirm external payloads/logs/Artifacts expose only logical IDs or relative paths.
6. Use the API Key as a canary; confirm it is absent from argv, runtime hash, TaskManifest, state, session, Artifacts, diagnostics, and errors.

## 5. Validate Pi session and Run recovery

1. Disconnect/reconnect Host while Pi child lives; confirm job, Attempt, and Pi session are unchanged.
2. Crash Pi child; confirm old Attempt is reconciled and one new Attempt/session starts on the same Revision/workspace.
3. Restart Daemon outside an active Review turn; confirm recovery uses `state.sqlite`, not an assumed live Pi session.
4. Complete a repair Revision; confirm a new Pi session starts from previous Result Tree.
5. Submit an independent feature; confirm Host classifies it as a new Task/Run/session.
6. Cancel a Run; confirm the full Pi process tree exits before CANCELED is durable.
7. Suppress Pi heartbeats for one configured window (five minutes by default); confirm zero surviving processes, exactly one `TIMED_OUT`, Run `PAUSED`, and no replacement before allowed recovery.

## 6. Validate the sole public Review workflow

1. Call `smartflow_execute` once with approved Task hash and record `projectId/jobId`.
2. Thereafter call only `smartflow_review_turn` for Review orchestration. Use one stable `hostTurnId` and a new idempotency `requestId` per call.
3. On `NOT_READY`, confirm no `worktreePath` exists, wait `retryAfterMs`, and poll again.
4. On first `REVIEW_REQUIRED`, record `reviewAttemptId`, `taskSourceHash`, `candidateHash`, complete `changedPaths`, and the bound manifest's `enabledTaskIds`; confirm `reviewerSession.mode === "CREATE"`.
5. Create an independent Reviewer, read the synchronized Task/current files, and submit exactly `ReviewResult={tasks: TaskReview[]}` with the same `turnToken`. Confirm Task IDs are unique and exactly equal `manifest.enabledTaskIds`.
6. For every Task, confirm `completionPercentage` is an integer in 0–100 and equals 100 iff `issues=[]`; every incomplete Task has at least one issue. Confirm each Issue contains only project-relative `path`, concrete `message`, and optional `suggestedFix`, and is unique within its Task by `path + message`.
7. On later repair Review, confirm `mode === "RESUME"` with the original Reviewer session and a new Pi session.
8. Inspect state writes to prove the Daemon used one atomic Review-begin mutation and one Review-plus-decision finalization; no claim/renew or independent Leader-decision bridge exists.
9. Confirm the registered public MCP surface is exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`.
10. Confirm the old `smartflow_wait`, claim/renew, submit-review, and submit-leader symbols, schemas, handlers, registrations, and aliases do not exist.
11. Confirm no production Host SDK, workspace package, subpath export, bundled artifact, or `HostActionLoop` remains; native Hosts drive the MCP tools directly, while repository-only simulation lives under `tests/helpers/host-workflow`.

## 7. Validate independent Run management APIs

1. Exercise `smartflow_status` independently and confirm it reports Run progress without exposing the Review worktree path.
2. Exercise public `smartflow_resume` only as an independent paused-Run recovery API when no active `hostTurn` owns the answer; it must not accept a ReviewTurn answer or bypass owner/token checks.
3. Exercise public `smartflow_cancel` as a standalone Run operation outside an active ReviewTurn answer and confirm cancellation does not submit Review or make a Leader decision.
4. Exercise `smartflow_result` independently for the Run's canonical result; confirm the Host Review workflow does not use it as a pause fallback.
5. Verify these four APIs in management-specific contract scenarios, not as Review continuations or an alternate Review orchestration sequence.

## 8. Validate Host-turn checkpoint, restart, and path safety

1. Begin from `REVIEW_PENDING`; confirm exactly one state commit produces `REVIEWING + AWAITING_REVIEW`, with no `CLAIMING`, claim ID, lease, or renew timer.
2. Simulate a lost begin response by repeating the same turn; confirm the same `turnToken`, Review attempt, Reviewer mode, path, and deadline return without another state mutation.
3. Restart during `AWAITING_REVIEW`; confirm the same `turnToken`, Review attempt, Reviewer mode, and 30-minute deadline return.
4. Advance 60 seconds and confirm state does not change merely to maintain a short lease.
5. Force the 30-minute deadline and confirm a durable Host-review-unavailable pause without stale path disclosure.
6. Submit old Review/failure/answer continuations and confirm each causes no side effect and returns no-path `NOT_READY`.
7. Against the current token, submit malformed Review v2 and missing, duplicate, extra, unknown, or disabled Task coverage. Confirm rejection occurs before Review/Leader artifact or state write and leaves `stateVersion`, phase, active `hostTurn`/token, `autoRepairRounds`, and all durable evidence unchanged.
8. Against the same still-active token, correct the payload and confirm normal finalization succeeds exactly once.
9. Attempt continuation with another `hostTurnId`; expect ownership rejection.
10. Trigger a Project CAS mismatch; confirm no partial claim/decision state exists and the caller receives a fresh no-path continuation.
11. During restart confirm `ProjectRuntime` recovers Host turn first, rereads state, and does not schedule general Worker/Run recovery while `hostTurn` remains.

## 9. Validate automatic Review decisions and repair progress

1. Submit a valid Review in which every enabled Task has `completionPercentage === 100` and `issues: []`; confirm the only plan is `ACCEPT` and Publish starts without a Host-side public Leader-decision call.
2. Submit a valid Review with at least one incomplete Task while `autoRepairRounds < 15`; confirm the only plan is `REPAIR`, the counter increments, and one approved-scope Revision starts automatically from all current nested `tasks[].issues[]`.
3. Inspect the Pi repair prompt and confirm it contains every current issue with its owning Task ID and project-relative path, not a selected subset or stale issue. Confirm the Review artifact contains `schemaVersion: 2`, direct task/Candidate/session bindings, `gate.result`, and in-artifact `reviewHash`; confirm the Leader artifact contains only revision, reviewHash, decision/reason/time, and decisionHash, with no direct Candidate/task-source or repair issue fields.
4. Reach 15 automatic repair rounds with a valid incomplete Review; confirm the plan is `PAUSE_REPAIR_LIMIT`, the durable state is `USER_INPUT_REQUIRED/AUTOMATIC_REPAIR_LIMIT`, Candidate/Review evidence is retained, and no additional repair starts.
5. As the owning Host, submit `resume_review_decision` through `smartflow_review_turn` with the unchanged `turnToken`; confirm stored v2 Review replanning uses `repairRounds: 0`, a resulting REPAIR commits `autoRepairRounds: 1`, and RepairCoordinator then either prepares the next Revision or enters a genuine repair pause. Confirm no transient `LEADER_DECISION` or `REPAIR_TASKS_READY` pause is produced, and public `smartflow_resume` cannot bypass active `hostTurn` ownership.
6. Hold failure IDs, unique `(task.id, issue.path)` scope, and Candidate-operation relevant-path hashes constant until `noProgressCount` reaches the default threshold 15; expect `REPAIR_NO_PROGRESS` and no further automatic repair preparation.
7. Change only `message`/`suggestedFix`, the issue order, or unrelated files; confirm none counts as progress or resets the no-progress counter.
8. Strictly shrink the failure/Task/path scope, then separately change a relevant Candidate operation hash; confirm each counts as progress and resets the counter. Confirm whole-Candidate hash changes alone are insufficient when relevant paths are unchanged, and no Result Snapshot is reread for this comparison.
9. Confirm the set of legal Review plans is exactly `ACCEPT | REPAIR | PAUSE_REPAIR_LIMIT`; schema/coverage failures are pre-decision zero-write rejections rather than pauses.
10. Confirm any real pause/conflict is `USER_INPUT_REQUIRED`, while only `COMPLETED/CANCELED/FAILED` yields `DONE`.

## 10. Validate cumulative Candidate and safe Publish

1. Record Baseline `A`; produce Revision 1 `A → B`, then repair Revision 2 `B → C`.
2. Confirm formal Candidate is `A → C`, repair evidence is `B → C`, and old evidence is immutable.
3. Confirm the same Reviewer examines the latest full result and cumulative changed paths.
4. On automatic accept, confirm Publish derives `ApplyOperation[]` from the bound Candidate plus immutable `REVISION_RESULT`, reads blobs from the Run Git object store with hash/size checks, acquires the Project Publish lease, and publishes a non-conflicting Candidate; expect `N/N` before COMPLETED.
5. For overlapping Runs, publish the first and expect the second to return `PRECHECK_CONFLICT`, full paths, `0/N`, `activeWorkspaceChanged=false`, no PublishAttempt, and an owning-Host `USER_INPUT_REQUIRED` containing the reviewed Candidate `worktreePath` plus `retry_publish | confirm_manual_publish | cancel`.
6. Submit `confirm_manual_publish` before the original project matches the Candidate; expect `MANUAL_PUBLISH_TARGET_MISMATCH` and no completion. Manually merge the reviewed result into the original project, submit confirmation again, and require every target kind/hash/mode to match before `manual-confirmation-v1` becomes COMMITTED.
7. Disable required adapter batch/CAS/query capability and expect `MANUAL_PUBLISH_REQUIRED` with zero writes and no attempt. Separately simulate PARTIAL/UNKNOWN or an operation-identity mismatch; confirm `PUBLISH_RECOVERY_BLOCKED`, no `confirm_manual_publish` option, and never a false `DONE`.

## 11. Verify legacy removal and evidence boundary

1. Confirm packages/dependencies contain no OpenCode, Claude Provider placeholder, or execution-broker runtime.
2. Confirm protocol/state contain no Broker session, effects, managed-process ledger, Worker block, or `smartflow_submit_tool_decision`.
3. Confirm runtime/help contains none of `SMARTFLOW_WORKER`, `SMARTFLOW_MODEL_*`, `SMARTFLOW_PI_PROVIDER`, or `SMARTFLOW_PI_CREDENTIAL_ENV`.
4. Reconcile a terminal Run; confirm temporary Workspace/runtime/index/object store are deleted while Task/Snapshot/Candidate/Review v2/Leader v2 references, PublishAttempt/PublishResult, precheck/recovery facts, and audit records remain. Confirm no transfer package, signature key, or bundle CLI surface is created.
5. Run the local protocol, contract, integration, security, E2E, build, typecheck, lint, and diff checks listed by the repository.
6. Treat the covered production-composition two-tool success as scenario evidence only.
7. Confirm T204 coverage rejects cross-Host continuations, persists atomic Review begin/finalize transitions, reconstructs a lost response from durable `AWAITING_REVIEW`, and recovers the single deadline before general Run recovery.
8. Confirm T205 coverage forwards cumulative `changedPaths`, enforces exact enabled-Task Review coverage, separates inspection actions from mutable answers, distinguishes revision `COLLECT` forms from complete `CONFIRM` answers, and returns embedded paused results without calling the independent `smartflow_result` management API.
9. Confirm repair-loop coverage passes every current nested issue to Pi and tests both strict scope reduction/relevant-path hash progress and wording/unrelated-path non-progress.
10. Keep T190/T208 open until pinned Pi 0.83.0's real exports, Extension registration, and RPC model resolution are exercised by a checked-in reproducible test.
11. Keep T192/T209 open until an explicitly authorized real-model `smartflow_execute → smartflow_review_turn*` run produces checked-in, auditable evidence. A gitignored `.smartflow-e2e` transcript is insufficient.

The real-model acceptance sends fixture Task/project content to the configured endpoint. Run it only after explicit user authorization with `SMARTFLOW_RUN_REAL_PI_E2E=1`, all required `SMARTFLOW_PI_*` variables, and any capability overrides; never commit credentials or raw sensitive content.
