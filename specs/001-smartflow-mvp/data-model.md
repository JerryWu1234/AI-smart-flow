# SmartFlow 4.0 Data Model

These are design-level entities. Runtime implementation maps them to Zod schemas, `ArtifactRef` and project `state.json`.

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

The canonical task-path binding is created atomically with the Run and released after terminal reconciliation. Different task paths may be active together; one project Publish lease serializes original-project writeback.

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

Worker and Reviewer read the immutable TaskSourceArtifact, never the mutable source file. TaskManifest contains no Provider field, permission policy, Broker tool definition or model credential.

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
  attemptDeadlineMs: number;   // default 1_800_000
  resourcePolicy: "workspace-project-resources";
}

interface ResolvedWorkerLaunchConfiguration {
  runtimeConfig: PiRuntimeConfiguration;
  credential: string;
  daemonConfigFingerprint: string;
}
```

The MCP server process environment is the sole user source. One instance resolves exactly one API/Base URL/model/API Key. `providerRuntimeConfigHash` covers the non-secret runtime configuration; the credential remains separate and only its digest participates in the daemon process fingerprint. The credential is never serialized into TaskManifest, Run state, session or Artifact data.

The Pi child receives a fixed internal registration ID plus the resolved environment, and a bundled Extension registers the model in memory. The internal ID is not a SmartFlow Provider field. No `models.json` entity or persisted model-registration record exists.

## GitWorkspaceSnapshot

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
```

`treeId` represents the effective active-workspace view, including allowed dirty and untracked content. Original-project absolute paths are internal only and are never sent to Pi or exposed through MCP.

## GitRunWorkspaceRef

```ts
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
  incrementalPatch?: ArtifactRef;
}
```

Revision 1 points to Run Baseline. Later Revisions point to the previous Result Snapshot. Pi receives only the current `root`; object store, temporary index and other Run directories remain outside its project-data sandbox policy.

## PiWorkerAttempt

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
```

An Attempt is the durable identity of one Pi child execution. Host reconnect does not create a new Attempt while the child is alive. Crash recovery and each new Revision create a new Attempt/session. Deadline expiry records `TIMED_OUT` only after containment termination is reconciled. `processIdentity` and `containmentId` replace the generic Broker managed-process/effect ledgers.

## PiSessionArtifact

```ts
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

This is audit/recovery evidence, not the state machine truth. A missing/corrupt session Artifact may force a new Pi session but cannot change the frozen Task, Revision input or Result Snapshot.

## GitCandidateEvidence

```ts
interface GitCandidateEvidence {
  revision: number;
  runBaselineSnapshotHash: string;
  inputSnapshotHash: string;
  resultSnapshotHash: string;
  runBaselineTreeId: string;
  inputTreeId: string;
  resultTreeId: string;
  canonicalOperations: CandidateOperation[];
  incrementalPatchArtifact?: ArtifactRef;
  cumulativePatchArtifact: ArtifactRef;
  blobs: Record<string, { oldBlobId: string | null; newBlobId: string | null }>;
  modes: Record<string, { oldMode: string | null; newMode: string | null }>;
  evidenceArtifactHash: string;
  candidateHash: string;
}
```

Formal Candidate and cumulative patch compare Run Baseline to current Result. `.smartflow-runtime/` and SmartFlow/Pi session temporaries are excluded before Result capture.

## Review and decision entities

```ts
interface ReviewerBinding {
  jobId: string;
  reviewerSessionId: string;
  createdByActionId: string;
}

interface ReviewDecision {
  actionId: string;
  revision: number;
  candidateHash: string;
  reviewerSessionId: string;
  reviewArtifact: ArtifactRef;
}

interface LeaderDecision {
  revision: number;
  reviewHash: string;
  decision: "accept" | "repair" | "pause";
  repairItems?: RepairItem[];
}
```

ReviewerBinding survives repair Revisions. ReviewDecision and LeaderDecision are current only for the bound Revision/Candidate and remain immutable audit history after invalidation.

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
  deliveryArtifact: ArtifactRef;
}
```

Any touched-path conflict returns before the batch starts. PARTIAL or UNKNOWN results persist as `PUBLISH_RECOVERY_BLOCKED` and never become `COMPLETED`.

## RunRecord migration

4.0 RunRecord retains Task, Revision chain, Git snapshots, Candidate, Review, decisions, publish, request receipts and cleanup status. It stores `workerAttempts: PiWorkerAttempt[]` and no longer stores:

- `brokerSession`;
- `effectExecutions`;
- `managedProcesses`;
- `workerBlock` or Worker tool-decision answer/receipt;
- any Worker Provider-selection field or model credential.

Old active records containing those fields are unsupported migration input and cannot be resumed or published as 4.0 Runs.

## Lifecycle rules

- Active Run: retain every Revision workspace/snapshot and every PiWorkerAttempt/session Artifact; forbid Git `gc`/`prune`.
- Attempt terminal: persist terminal state and session Artifact, reconcile process tree, then clean Run-local Pi runtime files. Timeout uses the same order and cannot start a replacement Attempt until stop is proven.
- Reconciled terminal Run: retain task/snapshot/Candidate/Review/Leader/Publish audit Artifacts and patch/bundle; delete temporary workspaces, indexes, runtime directories and object store.
- Recovery: `state.json` references the exact task binding, Revision chain, Attempt and publish operation; it never infers state from mutable files, Pi session files or `events.jsonl`.
