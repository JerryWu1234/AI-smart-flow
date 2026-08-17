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
}
```

The original canonical task file is mirrored byte-for-byte to the same path in the Run workspace before each Worker attempt. Worker and Reviewer read that synchronized worktree file; TaskSourceArtifact remains audit evidence. TaskManifest contains no Provider field, permission policy, Broker tool definition, or model credential.

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

## Review entities and durable Host turn

```ts
interface ReviewerBinding {
  jobId: string;
  reviewerSessionId: string;
  createdByActionId: string;
}

interface ReviewDecision {
  actionId: string;
  revision: number;
  taskSourceHash: string;
  candidateHash: string;
  reviewerSessionId: string;
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

`AWAITING_REVIEW` proves that Review context, Host ownership, and the 30-minute deadline committed atomically with the `REVIEWING` phase; it is the only stage from which the public Review protocol discloses the Reviewer worktree. `AWAITING_USER_INPUT` persists a nonterminal typed pause. For a publish-related pause, only the owning Host's `USER_INPUT_REQUIRED` may additionally receive the same reviewed Candidate `worktreePath`; ordinary status/result, non-publish pauses, stale continuations, and terminal outputs remain path-free. ReviewerBinding survives repair Revisions; HostTurn does not replace it.

`smartflow_execute → smartflow_review_turn*` is the sole public Review orchestration path. The public MCP surface contains exactly six tools: `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`. Status, resume, cancel, and result are separate Run-management APIs, not Review continuations or a second Review orchestration path. Public `smartflow_resume` is for independent paused-Run recovery and cannot answer or bypass an active `hostTurn`. The old wait/claim/renew/submission/Leader primitive symbols, schemas, handlers, registrations, and aliases do not exist; Review begin and finalization are atomic Daemon domain operations.

## Sole public ReviewTurn orchestration protocol

```ts
interface ReviewTurnInput {
  requestId: string;
  projectId: string;
  jobId: string;
  hostTurnId: string;
  turnToken?: string;
  review?: { reviewerSessionId: string; result: ReviewSubmissionInput };
  answer?: ResumeAction | RevisionApprovalAnswer;
  reviewUnavailableReason?: string;
}

type ReviewTurnOutput =
  | {
      kind: "NOT_READY";
      projectId: string;
      jobId: string;
      revision: number;
      stateVersion: number;
      phase: RunPhase;
      retryAfterMs: number;
      progress: { completed: number; total: number };
    }
  | {
      kind: "REVIEW_REQUIRED";
      projectId: string;
      jobId: string;
      revision: number;
      stateVersion: number;
      turnToken: string;
      worktreePath: string;
      reviewAttemptId: string;
      taskSourceHash: string;
      candidateHash: string;
      changedPaths: string[];
      reviewerSession:
        | { mode: "CREATE" }
        | { mode: "RESUME"; reviewerSessionId: string };
      piSessionId: string;
      deadlineAt: string;
    }
  | {
      kind: "USER_INPUT_REQUIRED";
      projectId: string;
      jobId: string;
      revision: number;
      stateVersion: number;
      turnToken: string;
      pause: { code: string; message: string };
      worktreePath?: string;
      review?: ReviewSubmission;
      repairDraft?: RepairDraft;
      requiredInput?: RequiredRevisionInput;
      options: Array<{ answer: string; description: string }>;
    }
  | { kind: "DONE"; result: ResultOutput };
```

`review`, `answer`, and `reviewUnavailableReason` are mutually exclusive and require `turnToken`. Stale continuations return current no-path `NOT_READY`. `DONE` is terminal-only and embeds canonical `ResultOutput` directly. That payload has the same shape as the independent `smartflow_result` response, but producing `DONE` does not call that public API.

## Automatic repair counter and decision plan

```ts
interface RunReviewAutomation {
  hostTurn?: HostTurn;
  autoRepairRounds?: number;
}

type ReviewDecisionPlan =
  | { kind: "ACCEPT"; decision: "accept"; repairItems: [] }
  | { kind: "REPAIR"; decision: "repair"; repairItems: RepairItem[] }
  | { kind: "PAUSE_INVALID_REVIEW"; decision: "pause"; repairItems: [] }
  | { kind: "PAUSE_REPAIR_LIMIT"; decision: "pause"; repairItems: RepairItem[] };
```

`autoRepairRounds` counts daemon-started repairs in the current group and is incremented with automatic repair. To grant another group, the owning Host submits `resume_review_decision` as a `smartflow_review_turn` answer with the active `turnToken`; HostTurnCoordinator atomically re-evaluates the stored Review with a reset allowance and proceeds directly to repair or another real pause. Public `smartflow_resume` is not used for that active HostTurn answer. Accept requires `APPROVE + 100% + no blocking finding`; repair uses only current blocking finding fingerprints and requires counter `< 15`; incomplete Review without actionable findings pauses invalid.

## CAS and idempotency model

- Project `stateVersion` CAS remains the durable writer boundary; competing writes return a fresh no-path continuation rather than retrying a partial primitive sequence.
- Child request IDs are deterministic hashes of stable turn identity and operation scope.
- Review begin and finalization are each one domain mutation; finalization directly selects `READY_TO_PUBLISH`, `FIXING`, or a real `PAUSED` state.
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

The Project state schema is version 6. Startup migration accepts schema-v4 and schema-v5 records: it preserves the v4 Review conversion, removes obsolete delivery references/actions from v5, records legacy Publish identity compatibility without deleting old files, and safely blocks an in-flight operation whose old hash cannot be reconstructed from the Git source. `RunRecord` retains Task, Revision chain, snapshots, Candidate, Review, publish, receipts, and cleanup, and includes:

```ts
interface RunRecordReviewTurnFields {
  hostTurn?: HostTurn;
  autoRepairRounds?: number;
}
```

It stores `workerAttempts: PiWorkerAttempt[]` and no longer stores Broker sessions, effects, managed-process ledgers, Worker block answers, Provider-selection fields, or model credentials. Old active records containing removed fields cannot resume or Publish as 4.x Runs.

## Lifecycle rules

- Active Run: retain every Revision workspace/snapshot, Attempt/session Artifact, Review history, Host turn, and repair count; forbid Git `gc`/`prune`.
- Attempt terminal: persist terminal state and session Artifact, reconcile process tree, then clean Run-local Pi runtime files.
- Review turn: atomically persist `REVIEWING` plus `AWAITING_REVIEW` before path disclosure; clear or replace the checkpoint only through a current CAS-bound transition.
- Reconciled terminal Run: retain task/snapshot/Candidate/Review/automatic-decision Artifact references plus durable PublishAttempt/PublishResult and audit facts; delete temporary workspaces, indexes, runtime directories, object store, and derivable patch/evidence/blob copies.
- Recovery: `state.sqlite` references exact task binding, Revision, Attempt, Host turn, and Publish operation; it never infers state from mutable files, timers, queues, or session files.
- Audit: `audit_events` in the same SQLite database is the only runtime audit sink and is not a second recovery authority.
