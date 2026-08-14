# Review Loop Glossary

| Term | Meaning |
| --- | --- |
| Leader / Host | The user-facing strong-model session. It approves task intent, creates/restores the independent Reviewer, and is the only component that communicates with the user. It no longer reconstructs deterministic Review/repair/Publish mechanics. |
| Daemon-owned mechanical orchestration | Frozen state-machine work performed by the Daemon: bounded progress, atomic Review begin/finalization, Review validation, accept/repair/pause planning, approved-scope repair, and Publish. It is not a second user-facing Leader. |
| Worker | The Pi Coding Agent session that implements the approved Revision in the isolated Run workspace. |
| Reviewer | An independent native session executed by the Host. It rereads the synchronized Task and current files, scores every Task, and reports structured completion; the Daemon never creates or replaces it. |
| Composite Review turn | One `smartflow_review_turn` request/response. After `smartflow_execute`, it is the only public Review orchestration and continuation API. |
| Public MCP surface | Exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. |
| Public Review orchestration path | Exactly `smartflow_execute → smartflow_review_turn*`; no management API or internal mechanic is an alternate Review path. |
| Run management APIs | `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. They are separate Run operations, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery; it cannot answer or bypass an active `hostTurn`. |
| Daemon-internal Review mechanics | Atomic Review begin/finalization, deterministic decision planning, approved-scope repair continuation, and Publish scheduling. They are domain operations, not callable wait/claim/renew/Leader primitives. |
| Absent Review primitive symbols | The symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision`, plus the `HostActionLoop` symbol, do not exist; the Daemon does not reconstruct them as internal callable APIs. |
| Four public states | The exclusive composite outputs: `NOT_READY`, `REVIEW_REQUIRED`, `USER_INPUT_REQUIRED`, and terminal-only `DONE`. |
| `NOT_READY` | A no-path progress response with bounded `retryAfterMs`; also the safe response to stale continuation payloads. |
| `REVIEW_REQUIRED` | A current Review turn whose `REVIEWING + AWAITING_REVIEW` state was committed atomically. This is the only response allowed to expose `worktreePath`. |
| `USER_INPUT_REQUIRED` | A durable nonterminal pause containing legal options and, when needed, a typed answer template. Only the owning Host may ask the user and submit the answer through `smartflow_review_turn` with the active `turnToken`. Public Run-management APIs are not ReviewTurn answers or continuations; public `smartflow_resume` cannot bypass the active owner/token checks. |
| `DONE` | A canonical terminal result for `COMPLETED`, `CANCELED`, or `FAILED`; never an alias for pause/conflict. |
| `hostTurnId` | Stable identity of the Host instance that owns the active durable turn. Another Host cannot implicitly continue it. |
| `turnToken` | Stable continuation token binding Review/failure/answer submissions to one Host turn and deriving idempotent child request IDs. |
| Atomic Review begin | One CAS mutation validates the current Candidate and writes `REVIEWING + AWAITING_REVIEW`, owner/token/revision, Review attempt, Reviewer mode, path provenance, and the 30-minute deadline. |
| Persistent Host-turn stages | Internal schema-v5 stages `AWAITING_REVIEW` and `AWAITING_USER_INPUT`; they are not additional public API states. Schema-v4 claim/lease fields exist only at the migration boundary. |
| Run workspace | The Run-scoped isolated Git workspace shared by Pi for writes and Reviewer for read-only inspection; it is not the user's original project. |
| Synchronized Task | The byte-for-byte approved Task copy at its canonical relative path inside the Run workspace, reread by Worker and Reviewer. |
| Review worktree path | The absolute Run-workspace path disclosed only in `REVIEW_REQUIRED` after atomic begin commits `AWAITING_REVIEW` for the owning Host. It never appears in status, `NOT_READY`, pauses, stale continuations, logs, or terminal results. |
| Bound Reviewer session | The first successful Reviewer session for the Run. The first Review requests `CREATE`; every later repair Review requests `RESUME` with the same session ID. |
| Full changed-file list | The cumulative set from Run baseline through the current Candidate, supplied on every review round. |
| Review deadline | One durable timestamp, thirty minutes from atomic Review begin; expiry causes a durable Host-review-unavailable pause. There is no shorter claim lease or renewal loop. |
| Lost-response replay | Repeating a begin or finalize turn reconstructs the same durable result without creating another Review attempt, decision, repair Revision, or Publish effect. |
| Mechanical decision plan | One of `ACCEPT`, `REPAIR`, `PAUSE_INVALID_REVIEW`, or `PAUSE_REPAIR_LIMIT`, derived only from validated Review data and durable repair count. |
| Automatic repair budget | Up to 15 daemon-started repair rounds per allowance. The owning Host submits `resume_review_decision` through `smartflow_review_turn` with the active `turnToken`; HostTurnCoordinator atomically re-evaluates the stored Review, resets `autoRepairRounds`, and proceeds directly to repair or a real pause. |
| Invalid Review pause | Incomplete Review with no actionable blocking finding. It exposes only `cancel`; the system does not invent repair scope. |
| Repair feedback | Current blocking Reviewer finding fingerprints converted into RepairItems for the next approved-scope Revision. |
| Completion percentage | The rounded arithmetic mean of all individual Task completion percentages; automatic accept additionally requires every Task to be 100%. |
| Stale continuation | A Review, failure, or answer whose token/current checkpoint no longer matches. It causes no side effect and returns current no-path progress. |
| Publish | Applying a 100%-approved, fully covered Candidate to the original project through conflict-checked CAS after the Daemon's deterministic accept. |
| Viewable pause | A durable stopped Run that retains Candidate/Review evidence and legal recovery actions without false completion or cleanup. |
