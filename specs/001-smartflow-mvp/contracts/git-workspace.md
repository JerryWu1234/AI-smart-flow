# Git Workspace Adapter Contract

## Purpose

Provide Git-backed snapshots, Pi-visible isolated materialization, Candidate evidence and publish preflight while preserving SmartFlow's state machine and Artifact boundaries.

## G0 frozen decisions

These rules must be frozen before Git Adapter implementation begins:

1. **Content filters do not block the Run**
   - The capability probe does not inspect or block Git LFS, `.gitattributes`, or custom `clean`, `smudge` or `process` filters.
   - Snapshot and materialization use the current worktree bytes through the normal file flow.
2. **Candidate identity binds snapshots without copying their evidence**
   - Candidate v3 binds the Run Baseline, Revision Input, and Result Snapshot hashes plus canonical cumulative operations.
   - Snapshot Artifacts remain the sole source of Git tree/blob/mode evidence; Candidate does not repeat tree IDs, blob maps, mode maps, or an evidence Artifact hash.
   - Git object IDs remain internal evidence references and must not replace SmartFlow's SHA-256 integrity bindings.
3. **Automatic publish requires a conflict-checked batch adapter**
   - A preflight conflict must return before publishing starts and must cause zero writes.
   - Automatic publish is allowed when the Apply Adapter supports expected-old-hash checks, stable operation IDs, result queries, and either strict `atomicBatchCas` or local `preflightBatchWrite`.
   - `preflightBatchWrite` checks every Candidate path before writing, then replaces files one by one. A process or machine failure after writing starts may produce PARTIAL or UNKNOWN and must enter `PUBLISH_RECOVERY_BLOCKED`.
   - Without either supported batch mode, SmartFlow performs no write and creates no PublishAttempt. It pauses with the reviewed Candidate workspace available only to the owning Host, who may retry, cancel, or externally merge and request strict target-state confirmation.
4. **There is no legacy fallback**
   - Missing Git or any unsupported repository capability enters `PAUSED` with a durable reason.
   - SmartFlow must not silently fall back to the legacy Baseline/Candidate scanner.
5. **Revision trees form an immutable chain**
   - The Run Baseline is captured once and never replaced.
   - Revision 1 uses the Run Baseline as input; every later Revision uses the previous Revision's Result Tree.
   - Review and Publish use cumulative Candidate operations from the Run Baseline to the current Result Tree. Git patches are generated from the bound trees only when needed and are not retained as per-Revision Artifacts.
   - All Revisions share one append-only Run object store, but use separate indexes, Workspaces, Snapshot Artifacts and Candidate Artifacts.
   - Git `gc` and `prune` are forbidden while any Revision snapshot is referenced.
6. **Task-path concurrency and Git state are Run-scoped**
   - The canonical absolute task-file path permits only one Active Run; different task files may run concurrently in one Project.
   - Every Run owns a separate task Artifact, fence/generation, object store and Revision directory. Git state must never be shared across Runs.
   - Project Publish is serialized; execution and Review are not path-reserved.

G0 is complete only when these decisions are represented by the capability result, Candidate hash contract, Publish capability contract and acceptance scenarios.

## Design surface

```ts
interface GitWorkspaceAdapter {
  probeRepository(input: { projectRoot: string }): Promise<GitCapabilities>;
  captureBaseline(input: CaptureInput): Promise<GitWorkspaceSnapshot>;
  materialize(input: MaterializeInput): Promise<GitRevisionWorkspaceRef>;
  captureResult(input: CaptureResultInput): Promise<GitWorkspaceSnapshot>;
  buildCandidate(input: BuildCandidateInput): Promise<GitCandidateV3>;
  preflight(input: PublishPreflightInput): Promise<GitPublishConflict[]>;
  cleanup(input: CleanupInput): Promise<void>;
}
```

The exact TypeScript names can change during implementation. Snapshot and Candidate operations produce durable Artifacts and state transitions. Publish deterministically combines the Candidate with its bound immutable Result Snapshot, then reads final bytes from the retained Run Git object store using object ID plus SHA-256 and size checks; it does not create a second delivery artifact.

## Safety invariants

- Commands use explicit argv and an explicit working directory; no shell interpolation.
- `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and any alternates point into the current Run Data Dir.
- The adapter never changes the user's normal index, refs, branch, worktree files or Git configuration.
- The adapter never invokes `commit`, `push`, `reset`, `clean`, `checkout`, `merge`, `rollback` or an equivalent destructive operation against the active workspace.
- Every snapshot is deterministic for the same effective file view and inclusion policy.
- Candidate operations are sorted canonically and carry expected old content hashes and modes.
- A new Revision never overwrites an earlier Revision's Snapshot or Candidate Artifacts.
- A preflight-detected conflict returns before publish starts and causes zero writes.
- Preflight inspects only cumulative Candidate paths. A conflict result includes all conflict paths, `0/N`, `activeWorkspaceChanged=false`, and durable `publishPrecheck`; it creates neither a PublishAttempt nor a write.
- For `PUBLISH_ADAPTER_UNAVAILABLE` or `PUBLISH_PRECHECK_CONFLICT`, only the owning Host's `USER_INPUT_REQUIRED` may expose the reviewed Candidate `worktreePath` and `confirm_manual_publish`. Confirmation is read-only and succeeds only when every Candidate target kind/hash/mode already matches in the original project.
- PARTIAL or UNKNOWN apply results enter `PUBLISH_RECOVERY_BLOCKED`; they never become `COMPLETED`, are not automatically rolled back, and cannot use manual confirmation.
- Temporary state is retained until referenced Artifacts and publish/recovery reconciliation are durable; cleanup is idempotent.
- Pi receives only the materialized Revision workspace. The Run object store, temporary index, original project path and other Revision/Run directories are not inside Pi's project-data sandbox policy.
- `.smartflow-runtime/` is excluded or removed before Result Snapshot and Candidate generation.

## Capability result

The probe must report repository identity, Git version, worktree support, symlink/mode behavior, submodule/nested-repository signals, and the effective inclusion policy. It does not inspect or block Git LFS, `.gitattributes`, or custom `clean`/`smudge`/`process` filters.
