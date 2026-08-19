# SmartFlow Data Model

These are design-level entities. Runtime implementation maps them to Zod schemas, `ArtifactRef`, and the Project's schema-v6 `state.sqlite`.

## ProjectRunIndex

```ts
interface ProjectRunIndex {
  activeRunsByTaskPath: Record<string, string>;
  runs: Record<string, RunRecord>;
  publishLease: null | {
    jobId: string;
    operationId: string;
    acquiredAt: string;
  };
}
```

The canonical task-path binding is created atomically with the Run and released after terminal reconciliation. Different task paths may be active together; all mutations use Project-wide CAS and one Project Publish lease serializes original-project writeback.

## TaskSourceArtifact and TaskManifestV3

```ts
interface TaskSourceArtifact {
  canonicalTaskPath: string;
  sourceHash: string;
  artifact: ArtifactRef;
  approvedAt: string;
}

interface TaskManifestV3 {
  schemaVersion: 3;
  runId: string;
  revisionId: string;
  providerRuntimeConfigHash: string;
  taskSourceArtifact: ArtifactRef;
  tasksSha256: string;
  enabledTaskIds: string[];
}
```

The original canonical task file is mirrored byte-for-byte to the same path in the Run workspace before each Worker attempt. Worker and Reviewer read that synchronized worktree file; TaskSourceArtifact remains audit evidence. `enabledTaskIds` is derived once from the frozen TaskSource, contains unique IDs in source order, and remains bound through the immutable TaskManifest artifact; Review and Publish never reconstruct it from a mutable task file. TaskManifest contains no Provider field, permission policy, Broker tool definition, or model credential.

## PiRuntimeConfiguration and credential

```ts
type PiModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

interface PiRuntimeConfiguration {
  api: PiModelApi;
  baseUrl: string;
  modelId: string;
  contextWindow: number;       // default 1_000_000
  maxTokens: number;           // default 384_000
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  attemptDeadlineMs: number;   // default 300_000; minimum 60_000 rolling heartbeat window
  resourcePolicy: "workspace-project-resources";
}

interface ResolvedWorkerLaunchConfiguration {
  runtimeConfig: PiRuntimeConfiguration;
  credential: string;
  daemonConfigFingerprint: string;
}
```

The MCP server process environment is the sole user source. One instance resolves exactly one API/Base URL/model/API Key. `providerRuntimeConfigHash` covers non-secret runtime configuration; the credential remains separate and only its digest participates in the Daemon process fingerprint. No `models.json` entity or persisted model-registration record exists.

## Git workspace and snapshots

```ts
interface GitWorkspaceSnapshot {
  schemaVersion: 1;
  repositoryId: string;
  snapshotKind: "RUN_BASELINE" | "REVISION_INPUT" | "REVISION_RESULT";
  revision: number;
  treeId: string;
  snapshotHash: string;
  includedPathPolicyHash: string;
  metadataArtifact: ArtifactRef;
  createdAt: string;
}

interface GitRunWorkspaceRef {
  runBaselineSnapshot: ArtifactRef;
  objectDirectory: string;
  revisions: Record<string, GitRevisionWorkspaceRef>;
}

interface GitRevisionWorkspaceRef {
  revision: number;
  root: string;
  temporaryIndexPath: string;
  inputSnapshot: ArtifactRef;
  resultSnapshot?: ArtifactRef;
  candidate?: ArtifactRef;
}
```

Revision 1 points to Run Baseline. Later Revisions point to the previous Result Snapshot. Pi receives only the current root; object store, index, original-project path, and other Run directories remain outside its project-data authority and public protocol. The runtime schema still accepts optional `incrementalPatch`, `cumulativePatch`, and `evidence` references from legacy v2 records, but new Revisions never write them.

## PiWorkerAttempt and PiSessionArtifact

```ts
interface PiWorkerAttempt {
  attemptId: string;
  jobId: string;
  revision: number;
  generation: number;
  providerRuntimeConfigHash: string;
  status:
    | "PREPARING"
    | "RUNNING"
    | "COMPLETED"
    | "BLOCKED"
    | "FAILED"
    | "TIMED_OUT"
    | "CANCELED";
  piSessionId?: string;
  containmentId?: string;
  processIdentity?: ProcessIdentity;
  sessionArtifact?: ArtifactRef;
  terminalReason?: string;
  startedAt: string;
  endedAt?: string;
}

interface PiSessionArtifact {
  attemptId: string;
  piSessionId: string;
  revision: number;
  providerRuntimeConfigHash: string;
  transcriptOrSession: ArtifactRef;
  terminalStatus: "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "CANCELED";
  createdAt: string;
}
```

An Attempt is the durable identity of one Pi child execution. Host reconnect does not create a new Attempt while the child is alive. Crash recovery and every new Revision create a new Attempt/session. Session Artifact is evidence, not state-machine truth.

## Candidate v3

```ts
interface GitCandidateV3 {
  schemaVersion: 3;
  revision: number;
  runBaselineSnapshotHash: string;
  inputSnapshotHash: string;
  resultSnapshotHash: string;
  operations: CandidateOperation[];
  candidateHash: string;
}
```

The formal Candidate compares the Run Baseline to the current Result Snapshot. Snapshot Artifacts already carry Git tree, blob, and mode evidence, so Candidate v3 binds their hashes rather than copying those values into another Artifact. `.smartflow-runtime/` and session temporaries are excluded before Result capture. Publish derives `ApplyOperation[]` directly from the bound Candidate and immutable `REVISION_RESULT`; final file bytes remain in the Run Git object store and are hash/size checked when read. Worker does not persist incremental or cumulative patches. Verification remains backward-compatible with unversioned and v2 Candidate Artifacts.

## ReviewResult v2 entities and durable Host turn

`ReviewResult` is the only Reviewer result model. The domain result, task result, and issue are strict objects with no compatibility aliases:

```ts
interface Issue {
  path: string;
  message: string;
  suggestedFix?: string;
}

interface TaskReview {
  id: string;
  completionPercentage: number;
  issues: Issue[];
}

interface ReviewResult {
  tasks: TaskReview[];
}

interface DurableReviewDecisionV2 {
  schemaVersion: 2;
  revision: number;
  claimId: string;
  reviewAttemptId: string;
  taskSourceHash: string;
  candidateHash: string;
  reviewerSessionId: string;
  piSessionId: string;
  gate: {
    accepted: boolean;
    allowedLeaderDecisions: Array<"accept" | "repair" | "pause">;
    result: ReviewResult;
  };
  reviewHash: string;
}

interface DurableLeaderDecisionV2 {
  schemaVersion: 2;
  revision: number;
  reviewHash: string;
  decision: "accept" | "repair" | "pause";
  reason: string;
  decidedAt: string;
  decisionHash: string;
}
```

Validation is normative:

- `ReviewResult` contains only `tasks`; each `TaskReview` contains only `id`, `completionPercentage`, and `issues`; each `Issue` contains only `path`, `message`, and optional `suggestedFix`.
- Task IDs are unique and their set equals `manifest.enabledTaskIds` exactly: no missing, duplicate, disabled, or unknown task is accepted.
- `completionPercentage` is an integer from 0 through 100. It is 100 if and only if `issues` is empty; every incomplete task has at least one issue.
- `path` is trimmed and non-empty; a leading `/`, any backslash, and any empty/`.`/`..` slash-delimited segment are invalid. These are the complete lexical checks: drive-qualified forms are not separately classified, and the schema does not check filesystem existence, file-vs-directory type, or symlinks.
- `message` is non-empty; `suggestedFix`, when present, is non-empty guidance rather than a second identity field. Concrete function/behavior, trigger, and impact are Reviewer prompt requirements, not natural-language checks performed by the schema.
- Within one task, issues are unique by trimmed `path + message`; array order and `suggestedFix` do not create another issue.
- The strict v2 objects reject every unknown or legacy key; no compatibility aliases or secondary review/repair structures exist.

Durable Review and Leader artifacts always use `schemaVersion: 2`. `reviewHash` is serialized in `DurableReviewDecisionV2` and hashes the canonical body without itself; `decisionHash` does the same for `DurableLeaderDecisionV2`. The Leader artifact has no `plan`, direct `candidateHash`/`taskSourceHash`, or separate repair payload and binds provenance transitively through `reviewHash`. Review/Leader v1 artifacts are rejected by strict v2 parsing; recovery reports `ARTIFACT_SEMANTIC_VALIDATION_FAILED` and pauses or blocks the affected Run. Operators may choose a new Data Directory for deployment, but the runtime uses an unversioned layout and has no format marker/probe. This artifact boundary is independent of supported Project state schema-v4/v5 to schema-v6 migration.

```ts
interface ReviewerBinding {
  jobId: string;
  reviewerSessionId: string;
  createdByActionId: string;
}

interface BoundReviewResult {
  actionId: string;
  revision: number;
  taskSourceHash: string;
  candidateHash: string;
  reviewerSessionId: string;
  reviewHash: string;
  reviewArtifact: ArtifactRef;
}

interface HostTurnIdentity {
  turnToken: string;
  hostTurnId: string;
  revision: number;
  startedAt: string;
}

type HostTurn =
  | (HostTurnIdentity & {
      stage: "AWAITING_REVIEW";
      reviewAttemptId: string;
      deadlineAt: string;
    })
  | (HostTurnIdentity & {
      stage: "AWAITING_USER_INPUT";
      pauseCode: string;
    });
```

`AWAITING_REVIEW` proves that Review context, Host ownership, and the 30-minute deadline committed atomically with the `REVIEWING` phase; it is the only stage from which the public Review protocol discloses the Reviewer worktree. `AWAITING_USER_INPUT` persists a genuine nonterminal typed pause. For a publish-related pause, only the owning Host's `USER_INPUT_REQUIRED` may additionally receive the same reviewed Candidate `worktreePath`; ordinary status/result, non-publish pauses, stale continuations, and terminal outputs remain path-free. ReviewerBinding survives repair Revisions; HostTurn does not replace it.

`smartflow_execute → smartflow_review_turn*` is the sole public Review orchestration path. The public MCP surface contains exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. Status, resume, cancel, and result are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. The old wait/claim/renew/submission/Leader primitive symbols, schemas, handlers, registrations, and aliases do not exist; Review begin and finalization are atomic Daemon domain operations.

## Sole public ReviewTurn orchestration protocol

```ts
interface ReviewTurnInput {
  requestId: string;
  projectId: string;
  jobId: string;
  hostTurnId: string;
  turnToken?: string;
  review?: { reviewerSessionId: string; result: ReviewResult };
  answer?: ResumeAction | RevisionApprovalAnswer;
  reviewUnavailableReason?: string;
}

type ReviewTurnOutput =
  | {
      kind: "NOT_READY";
      retryAfterMs: number;
    }
  | {
      kind: "REVIEW_REQUIRED";
      turnToken: string;
      reviewerSession:
        | { mode: "CREATE" }
        | { mode: "RESUME"; reviewerSessionId: string };
      worktreePath: string;
      tasksPath: string;
      taskIds: string[];
      changedPaths: string[];
      deadlineAt: string;
    }
  | {
      kind: "USER_INPUT_REQUIRED";
      turnToken: string;
      pause: { code: string; message: string };
      result: ResultOutput;
      options: Array<{ answer: ResumeAction; description: string }>;
      requiredInput?: RequiredRevisionInput;
      review?: ReviewResult;
      worktreePath?: string;
    }
  | { kind: "DONE"; result: ResultOutput };
```

The output is a compact projection of Daemon state carrying only what a caller can act on. Run identity the caller already supplied, `revision`/`stateVersion` CAS bookkeeping, Run `phase`, Review attempt identity, task-source/Candidate hashes, Provider session identity, and Task-completion counts all stay inside the Daemon and its durable evidence. `REVIEW_REQUIRED` does name `tasksPath` and `taskIds`, because a caller cannot satisfy the exact Task coverage the Daemon enforces without them.

`review`, `answer`, and `reviewUnavailableReason` are mutually exclusive and require `turnToken`. A submitted result is validated completely before any durable artifact or state write. Validation failure rejects the continuation atomically, leaves the Run, checkpoint, token, counters, Candidate, Review history, and state version unchanged, and lets the owning Host correct and resubmit against the same active turn. Stale continuations return current no-path `NOT_READY`. `DONE` is terminal-only and embeds canonical `ResultOutput` directly. That payload has the same shape as the independent `smartflow_result` response, but producing `DONE` does not call that public API.

## Automatic repair counter and decision plan

```ts
interface RepairRound {
  failureIds: string[];
  tasks: TaskReview[];
  relevantPathHashes: Record<string, string>;
}

interface RunReviewAutomation {
  hostTurn?: HostTurn;
  autoRepairRounds?: number;
  noProgressCount: number;
  // Previous RepairRound is stored at run.recovery.repairRound.
}

type ReviewDecisionPlan =
  | { kind: "ACCEPT"; decision: "accept"; reason: string }
  | { kind: "REPAIR"; decision: "repair"; reason: string }
  | { kind: "PAUSE_REPAIR_LIMIT"; decision: "pause"; reason: string };
```

The plan is mechanical and exhaustive only for a valid `ReviewResult`: all tasks at 100% with empty issues produce `ACCEPT`; otherwise `autoRepairRounds < 15` produces `REPAIR` and forwards every nested issue from the current result; otherwise it produces `PAUSE_REPAIR_LIMIT`. Neither Host nor Leader authors, filters, rewrites, or supplements repair data. An invalid payload produces no plan and no pause state.

`RepairCoordinator.prepare()` builds the current `RepairRound` and compares it with `run.recovery.repairRound`. `relevantPathHashes` comes directly from Candidate operations: non-delete operations use `newEntry.sha256`, and deletions use `DELETED`. Stable problems are `failure:<id>` plus `issue:<taskId>:<path>`. The current set being a strict subset of the previous set, or a relevant hash changing for any Issue path in either round, is progress. Progress resets `noProgressCount`; otherwise it increments. The first round compares current/current with an existing count of `-1`, producing zero. `message`, `suggestedFix`, percentages, and issue order do not participate. Result Snapshots are not reread for this comparison. The default no-progress threshold is 15; reaching it produces the operational `REPAIR_NO_PROGRESS` pause without adding a fourth Review decision.

For `resume_review_decision`, HostTurnCoordinator verifies current durable artifacts and invokes `finalizeStoredReview()` with `repairRounds: 0` and reset allowance. The stored v2 Review is parsed and hash-checked, but exact manifest Task coverage is not rerun. If the plan is `REPAIR`, the committed `autoRepairRounds` becomes 1. Existing `noProgressCount` and `run.recovery.repairRound` remain until repair preparation recomputes them and either creates a new Revision or enters a genuine pause. Integrity, ownership, or CAS failure rejects the continuation without a partial update.

## CAS and idempotency model

- Project `stateVersion` CAS remains the durable writer boundary; competing writes return a fresh no-path continuation rather than retrying a partial primitive sequence.
- Child request IDs are deterministic hashes of stable turn identity and operation scope.
- Review begin and finalization are each one domain mutation; finalization directly selects `READY_TO_PUBLISH`, `FIXING`, or the real repair-limit `PAUSED` state.
- Finalization validates the complete strict `ReviewResult`, exact enabled-task coverage, issue invariants, v2 artifact version, and every binding before creating any Review/Leader artifact or mutating state. Any failure is an atomic rejection: Run state, `stateVersion`, host turn/token/deadline, counters, Review history, Candidate, and child requests remain byte-for-byte unchanged.
- Review deadline is one durable 30-minute timestamp; no short claim lease or renewal loop exists.
- On restart, durable `hostTurn` is recovered before ordinary Run recovery; ProjectRuntime rereads state and schedules no competing recovery while the checkpoint remains.

## Publish capability and result

```ts
interface WorkspaceApplyCapabilities {
  expectedOldHashCas: boolean;
  atomicBatchCas: boolean;
  preflightBatchWrite?: boolean;
  stableOperationId: boolean;
  queryResult: boolean;
}

interface PublishConflictResult {
  status: "PRECHECK_CONFLICT";
  publishedCount: 0;
  totalCount: number;
  activeWorkspaceChanged: false;
  conflicts: GitPublishConflict[];
}
```

Any touched-path conflict returns before the batch starts. PARTIAL or UNKNOWN persists as `PUBLISH_RECOVERY_BLOCKED` and never becomes `COMPLETED`.

Publish deterministically derives canonical `ApplyOperation[]` from the accepted Candidate and its bound immutable `REVISION_RESULT`. Each non-delete operation references a Git blob by object ID plus SHA-256 and size; the default filesystem adapter reads it with `git cat-file blob` from the retained Run object store and verifies both integrity values. No parallel publish-blob tree, patch package, signature, or transfer artifact is created. A `PUBLISHING` recovery reconstructs the same operations and blob reader from the Candidate, Result Snapshot, and object store; an old or mismatched operation identity remains `PUBLISH_RECOVERY_BLOCKED`.

When capability probing cannot prove the required batch/CAS/query guarantees, or preflight finds a conflict, Publish performs no write and creates no attempt. The owning Host receives the reviewed Candidate `worktreePath` and may retry, cancel, or ask the user to merge externally and submit `confirm_manual_publish`. Confirmation only observes the original project's target paths; every expected kind/hash/mode must match before a `manual-confirmation-v1` COMMITTED result is persisted. A mismatch returns to `MANUAL_PUBLISH_TARGET_MISMATCH`, and recovery-blocked attempts never expose this bypass.

## RunRecord schema-v6 additions

The Project state schema is version 6. Startup migration accepts schema-v4 and schema-v5 records: it preserves the v4 Review-state conversion, removes obsolete delivery references/actions from v5, records legacy Publish identity compatibility without deleting old files, and safely blocks an in-flight operation whose old hash cannot be reconstructed from the Git source. This state migration is a separate version axis from strict Review/Leader artifact v2 parsing. The runtime keeps the unversioned Data Directory layout; encountering a v1 Review/Leader artifact fails semantic validation and pauses or blocks only the affected Run rather than rejecting an entire directory format. `RunRecord` retains Task, Revision chain, snapshots, Candidate, Review history, publish, receipts, and cleanup, and includes:

```ts
interface RunRecordReviewTurnFields {
  hostTurn?: HostTurn;
  autoRepairRounds?: number;
  noProgressCount: number;
  // recovery?: { repairRound?: RepairRound; ...other recovery facts }
}
```

It stores `workerAttempts: PiWorkerAttempt[]` and no longer stores Broker sessions, effects, managed-process ledgers, Worker block answers, Provider-selection fields, model credentials, or any secondary Review/repair identity or draft. Old active records containing removed fields cannot resume or Publish as 4.x Runs.

## Lifecycle rules

- Active Run: retain every Revision workspace/snapshot, Attempt/session Artifact, durable Review history, Host turn, repair count, no-progress count, and `recovery.repairRound`; forbid Git `gc`/`prune`.
- Attempt terminal: persist terminal state and session Artifact, reconcile process tree, then clean Run-local Pi runtime files.
- Review turn: atomically persist `REVIEWING` plus `AWAITING_REVIEW` before path disclosure; validate a submission completely before any v2 Review/Leader Artifact or state mutation; clear or replace the checkpoint only through a current CAS-bound transition.
- Reconciled terminal Run: retain task/snapshot/Candidate/durable Review/Leader references plus PublishAttempt/PublishResult and audit facts; delete temporary workspaces, indexes, runtime directories, object store, and derivable patch/evidence/blob copies.
- Recovery: `state.sqlite` references exact task binding, Revision, Attempt, Host turn, strict v2 Review/Leader artifacts, and Publish operation; it never infers state from mutable files, timers, queues, session files, or secondary review/repair drafts.
- Compatibility: strict v2 parsers reject v1 Review/Leader artifacts without in-place artifact conversion; supported Project state v4/v5 records still migrate idempotently to schema v6 in the existing directory layout.
- Audit: `audit_events` in the same SQLite database is the only runtime audit sink and is not a second recovery authority.
