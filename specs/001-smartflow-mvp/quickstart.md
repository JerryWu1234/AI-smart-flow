# SmartFlow 4.1 Acceptance Walkthrough

This walkthrough validates the Pi migration, removal of Broker/OpenCode, daemon-owned mechanical orchestration, the composite Review turn, and retained isolated Git Workspace/Publish behavior.

## 1. Freeze task and Pi configuration

1. Start the MCP server with exactly one configured model: `SMARTFLOW_PI_API`, `SMARTFLOW_PI_BASE_URL`, `SMARTFLOW_PI_MODEL`, and `SMARTFLOW_PI_API_KEY`.
2. Omit optional values and confirm context `1000000`, max output `384000`, thinking `high`, and Attempt deadline `1800000ms`; repeat with legal overrides.
3. Start a Run from `tasks-a.md`; record canonical path, Task Artifact, `tasksSha256`, and `providerRuntimeConfigHash` while confirming the API Key is absent.
4. Confirm the canonical task file is mirrored to the Run workspace before Worker execution and the Reviewer reads that copy.
5. Change effective Pi runtime config; confirm the active Revision pauses/fails instead of changing model/API.
6. Start through a path alias; expect `TASK_ALREADY_ACTIVE` and no new Attempt/workspace.
7. Repeat parsing with each API: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.

## 2. Start sandboxed Pi

1. Confirm `ExecutionSandboxAdapter` launches the Pi SDK child and records Attempt, Pi session, and containment identity.
2. Confirm the child loads only the bundled SmartFlow model Extension and registers one MCP-configured model through Pi's official runtime API.
3. Confirm JSONL RPC ready/prompt/events/terminal flow over stdin/stdout.
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
3. Restart Daemon outside an active Review turn; confirm recovery uses `state.json`, not an assumed live Pi session.
4. Complete a repair Revision; confirm a new Pi session starts from previous Result Tree.
5. Submit an independent feature; confirm Host classifies it as a new Task/Run/session.
6. Cancel a Run; confirm the full Pi process tree exits before CANCELED is durable.
7. Force Attempt deadline; confirm zero surviving processes, exactly one `TIMED_OUT`, Run `PAUSED`, and no replacement before allowed recovery.

## 6. Validate the sole public Review workflow

1. Call `smartflow_execute` once with approved Task hash and record `projectId/jobId`.
2. Thereafter call only `smartflow_review_turn` for Review orchestration. Use one stable `hostTurnId` and a new idempotency `requestId` per call.
3. On `NOT_READY`, confirm no `worktreePath` exists, wait `retryAfterMs`, and poll again.
4. On first `REVIEW_REQUIRED`, confirm `reviewerSession.mode === "CREATE"`; create an independent Reviewer, read the synchronized Task/current files, and submit Review with the same `turnToken`.
5. On later repair Review, confirm `mode === "RESUME"` with the original Reviewer session and a new Pi session.
6. Inspect logs/spies to prove the Daemon alone performed wait, Action claim/renew, Review submission, and Leader decision mechanics; none has a public MCP handler.
7. Confirm the registered public MCP surface is exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`.
8. Confirm the public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist, and that their Review mechanics are Daemon-internal only.
9. Confirm `HostActionLoop` and `apps/host-skill/src/action-loop.ts` are absent; the Host workflow has no alternate Review orchestration branch.

## 7. Validate independent Run management APIs

1. Exercise `smartflow_status` independently and confirm it reports Run progress without exposing a claimed worktree path.
2. Exercise public `smartflow_resume` only as an independent paused-Run recovery API when no active `hostTurn` owns the answer; it must not accept a ReviewTurn answer or bypass owner/token checks.
3. Exercise public `smartflow_cancel` as a standalone Run operation outside an active ReviewTurn answer and confirm cancellation does not submit Review or make a Leader decision.
4. Exercise `smartflow_result` independently for the Run's canonical result; confirm the Host Review workflow does not use it as a pause fallback.
5. Verify these four APIs in management-specific contract scenarios, not as Review continuations or an alternate Review orchestration sequence.

## 8. Validate Host-turn checkpoint, restart, and path safety

1. Pause immediately after durable `CLAIMING`; restart Daemon and confirm it reconciles one existing Action without duplicate claim.
2. Restart during `AWAITING_REVIEW`; confirm the same `turnToken`, Action, reviewAttempt, Reviewer mode, and 30-minute deadline return.
3. Advance 60 seconds and confirm claim lease renewal; verify renewal is scheduled no later than 30 seconds before expiry.
4. Force three renewal failures with 1-second retry and confirm a durable Host-review-unavailable pause.
5. Force the 30-minute deadline and confirm pause without stale path disclosure.
6. Submit old Review/failure/answer continuations and confirm each causes no side effect and returns no-path `NOT_READY`.
7. Attempt continuation with another `hostTurnId`; expect ownership rejection.
8. Trigger concurrent composite calls and CAS mismatches; confirm per-Run serialization, at most four total attempts (initial plus up to three fresh-state retries), and no duplicate Review/repair/Publish.
9. During restart confirm `ProjectRuntime` recovers Host turn first, rereads state, and does not schedule general Worker/Run recovery while `hostTurn` remains.

## 9. Validate automatic Review decisions

1. Submit `APPROVE + 100% + no blocking finding`; confirm Daemon automatically accepts and progresses to Publish without a Host-side public Leader-decision call.
2. Submit incomplete Review with blocking findings; confirm only their fingerprints become RepairItems, `autoRepairRounds` increments, and an approved-scope Revision starts automatically.
3. Submit an incomplete Review with no actionable blocking finding; expect `USER_INPUT_REQUIRED/INVALID_REVIEW` with `cancel` as its only mutable answer. As the owning Host, submit that answer through `smartflow_review_turn` with the active `turnToken`; do not use public `smartflow_cancel` as the ReviewTurn answer.
4. Reach 15 automatic repair rounds; expect `USER_INPUT_REQUIRED/AUTOMATIC_REPAIR_LIMIT`, retained Candidate/Review, and no additional repair.
5. As the owning Host, submit `resume_review_decision` through `smartflow_review_turn` with the `USER_INPUT_REQUIRED` turn's unchanged `turnToken`; confirm HostTurnCoordinator internally invokes Daemon resume mechanics, clears the checkpoint, resets the counter, and allows the next group of up to 15 rounds. Confirm public `smartflow_resume` cannot provide this answer or bypass active `hostTurn` ownership.
6. Confirm any pause/conflict is `USER_INPUT_REQUIRED`, while only `COMPLETED/CANCELED/FAILED` yields `DONE`.

## 10. Validate cumulative Candidate and safe Publish

1. Record Baseline `A`; produce Revision 1 `A → B`, then repair Revision 2 `B → C`.
2. Confirm formal Candidate is `A → C`, repair evidence is `B → C`, and old evidence is immutable.
3. Confirm the same Reviewer examines the latest full result and cumulative changed paths.
4. On automatic accept, acquire Project Publish lease and publish a non-conflicting Candidate; expect `N/N` before COMPLETED.
5. For overlapping Runs, publish first then expect second `PRECHECK_CONFLICT`, full paths, `0/N`, and DeliveryBundle.
6. Disable batch capability; confirm bundle only. Simulate PARTIAL/UNKNOWN; confirm `PUBLISH_RECOVERY_BLOCKED`, never false `DONE`.

## 11. Verify legacy removal and evidence boundary

1. Confirm packages/dependencies contain no OpenCode, Claude Provider placeholder, or execution-broker runtime.
2. Confirm protocol/state contain no Broker session, effects, managed-process ledger, Worker block, or `smartflow_submit_tool_decision`.
3. Confirm runtime/help contains none of `SMARTFLOW_WORKER`, `SMARTFLOW_MODEL_*`, `SMARTFLOW_PI_PROVIDER`, or `SMARTFLOW_PI_CREDENTIAL_ENV`.
4. Reconcile a terminal Run; confirm temporary Workspace/runtime/index/object store are deleted while audit Artifacts remain.
5. Run the local protocol, contract, integration, security, E2E, build, typecheck, lint, and diff checks listed by the repository.
6. Treat the covered production-composition two-tool success as scenario evidence only.
7. Confirm T204 coverage rejects cross-Host continuations and Daemon-internal Review mutations, reconciles a lost successful claim from its durable lease, and recovers Host turns before general Run recovery.
8. Confirm T205 coverage forwards cumulative `changedPaths`, separates inspection actions from mutable answers, distinguishes revision `COLLECT` forms from complete `CONFIRM` answers, and returns embedded paused results without calling the independent `smartflow_result` management API.
9. Keep T190/T208 open until pinned Pi 0.83.0's real exports, Extension registration, and RPC model resolution are exercised by a checked-in reproducible test.
10. Keep T192/T209 open until an explicitly authorized real-model `smartflow_execute → smartflow_review_turn*` run produces checked-in, auditable evidence. A gitignored `.smartflow-e2e` transcript is insufficient.

The real-model acceptance sends fixture Task/project content to the configured endpoint. Run it only after explicit user authorization with `SMARTFLOW_RUN_REAL_PI_E2E=1`, all required `SMARTFLOW_PI_*` variables, and any capability overrides; never commit credentials or raw sensitive content.
