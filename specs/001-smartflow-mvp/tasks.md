# Tasks: SmartFlow 4.x Pi Worker and Daemon Review Turn

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`
**Scope**: Preserve the sandboxed Pi Worker migration baseline and add SmartFlow 4.1 Solution D daemon-owned mechanical orchestration with a composite Review turn.
**Task IDs**: Continue after completed SmartFlow 3.0 baseline T109–T140; Phase 12 records the 4.1 delta without rewriting historical task status.

## Format

`[ID] [P?] [Story?] Description with exact path`

- `[P]` means different files and no incomplete dependency conflict.
- `[US#]` maps to the user stories in `spec.md`.
- Tests for changed behavior are written before implementation. Tests dedicated to removed code are deleted with that code.

## Phase 1: Setup

**Purpose**: Add the Pi SDK package boundary and dependency without creating a second Provider compatibility path.

- [X] T141 Add the pinned `@earendil-works/pi-coding-agent` dependency, raise Node engine to the verified SDK minimum, and add `@smartflow/provider-pi` workspace references in `package.json`, `pnpm-lock.yaml`, `apps/daemon/package.json`, and `apps/cli/package.json` — Acceptance: dependency resolution contains Pi and can build an empty provider package.
- [X] T142 [P] Create the parent/child package skeleton and exports in `packages/provider-pi/package.json`, `packages/provider-pi/tsconfig.json`, and `packages/provider-pi/src/index.ts` — Acceptance: workspace TypeScript resolution recognizes `@smartflow/provider-pi` without importing OpenCode/Broker.

---

## Phase 2: Foundational Contracts and Containment

**Purpose**: Freeze schema, Provider and process contracts before connecting a real Pi Agent.

**Critical**: No user-story implementation starts until T143–T151 are complete.

- [ ] T143 [P] Add failing provider/MCP contract cases to `packages/protocol/src/schema/protocol.test.ts` and `tests/contract/mcp-v5.test.ts` — Acceptance: tests require provider `pi`, Pi Attempt/session/containment fields, and absence of `smartflow_submit_tool_decision`/workerBlock answers.
- [ ] T144 Implement the 4.0 provider, Worker Attempt and MCP schemas in `packages/protocol/src/schema/run-state.ts`, `packages/protocol/src/schema/mcp-tools.ts`, and `packages/protocol/src/index.ts` — Acceptance: T143 passes and old Broker/tool-decision payloads are rejected.
- [X] T145 [P] Add failing TaskManifest v3 cases to `packages/task-manifest/src/task-manifest.test.ts` and `packages/task-manifest/src/validator.test.ts` — Acceptance: tests require `providerRuntimeConfigHash`, reject any Provider field and reject permission-policy/OpenCode/Claude fields.
- [X] T146 Implement TaskManifest v3 in `packages/task-manifest/src/schema.ts`, `packages/task-manifest/src/task-manifest.ts`, `packages/task-manifest/src/validator.ts`, and `packages/task-manifest/src/test-fixture.ts` — Acceptance: T145 passes and frozen task bytes/config hash remain reproducible.
- [X] T147 [P] Add failing PiWorkerAttempt persistence/integrity cases to `packages/state-store/src/schema.test.ts` and `tests/crash/atomic-state.test.ts` — Acceptance: tests require Attempt/session/containment/process identity and `TIMED_OUT`, and reject Broker/effect/managed-process/workerBlock state.
- [X] T148 Implement the 4.0 RunRecord migration in `packages/state-store/src/schema.ts`, `packages/state-store/src/test-fixture.ts`, and `packages/state-store/src/index.ts`, and delete `packages/state-store/src/effect-recovery.ts` — Acceptance: T147 passes, old active state fails with an explicit unsupported migration result, no effect-recovery export remains, and `state.json` remains the recovery truth.
- [X] T149 Remove Broker tool/dispatcher/block-answer surfaces from `packages/provider-core/src/worker-provider.ts`, `packages/provider-core/src/index.ts`, and `packages/provider-core/package.json`, and delete `packages/provider-core/src/broker-tools.ts`, `packages/provider-core/src/workspace-dispatcher.ts`, and `packages/provider-core/src/workspace-dispatcher.test.ts` — Acceptance: WorkerProvider accepts prompt/workspace/config/abort lifecycle only and exposes no custom file-operation interface.
- [ ] T150 [P] Add failing streaming-process, deadline and containment tests to `packages/workspace/src/execution-sandbox-adapter.test.ts` and `tests/security/workspace.test.ts` — Acceptance: tests cover stdin/stdout JSONL, stable containment identity, timeout/full-tree termination, network allow, workspace-local writes, and denial of original/state/other-Run/user-data paths.
- [ ] T151 Extend `packages/workspace/src/execution-sandbox-adapter.ts` and `packages/workspace/src/index.ts` with sandboxed streaming child handles, deadline termination and network-allow policy — Acceptance: T150 passes, runtime bootstrap is read-only, timed-out containment has zero surviving processes, and unsupported platforms fail closed.

**Checkpoint**: Protocol, Manifest, state and sandbox can express one Pi Attempt without Broker.

---

## Phase 3: User Story 1 — Freeze Task and Start a Pi Run (Priority: P1)

**Goal**: Leader starts a Run whose immutable Task and Pi runtime config cannot drift or fallback.

**Independent Test**: Start from a Task file, mutate the source/config, and confirm the current Run keeps frozen Task bytes and either the same Pi config hash or pauses.

### Tests

- [ ] T152 [US1] Add failing Pi registration/config tests to `apps/daemon/src/worker-config.test.ts`, `apps/daemon/src/provider-registry.test.ts`, and `tests/integration/provider-config-binding.test.ts` — Acceptance: tests require one MCP-configured API/Base URL/model/direct API Key, 1M/384K/high/deadline defaults, a stable non-secret config hash, credential redaction and fail-closed drift behavior.

### Implementation

- [ ] T153 [US1] Replace legacy launch configuration with the direct MCP single-model contract in `apps/daemon/src/worker-config.ts` and `packages/provider-pi/src/runtime-config.ts` — Acceptance: only `SMARTFLOW_PI_API/BASE_URL/MODEL/API_KEY` are required, optional capability defaults/overrides are frozen, Provider/credential-indirection fields are absent, and the API Key never enters runtime hashes/logs.
- [ ] T154 [US1] Bind the fixed Pi Worker and frozen MCP model config in `apps/daemon/src/provider-registry.ts`, `apps/daemon/src/runtime-composition.ts`, and `apps/daemon/src/project-runtime.ts` — Acceptance: T152 passes and missing/incompatible API/model capability pauses without Worker/API/model fallback.
- [ ] T155 [US1] Replace installed OpenCode probing with Pi SDK/runtime/in-memory-model probing in `apps/cli/src/doctor.ts`, `apps/cli/src/provider-gate.ts`, `apps/cli/src/main.ts`, and `apps/cli/src/doctor.test.ts` — Acceptance: CLI reports Pi/Node/Sandbox/model-registration readiness, redacts the direct API Key, and has no Provider-selection or Broker permission-policy checks.

**Checkpoint**: Leader can create a Pi-bound Run/Revision with immutable Task/config input.

---

## Phase 4: User Story 2 — Pi Directly Works Inside Isolated Workspace (Priority: P1)

**Goal**: A real Pi SDK child uses official coding tools and arbitrary Shell/network within the isolated workspace while OS sandbox blocks all protected project/user data.

**Independent Test**: Run add/modify/delete/search/Shell/network through Pi, build Candidate, and prove original project/state/other Run access is denied.

### Tests

- [ ] T156 [P] [US2] Add failing Pi RPC/config/Extension/event tests to `packages/provider-pi/src/pi-provider.test.ts`, `packages/provider-pi/src/rpc-client.test.ts`, `packages/provider-pi/src/runtime-config.test.ts`, and `packages/provider-pi/src/event-normalizer.test.ts` — Acceptance: tests cover in-memory single-model registration for four APIs, ready/prompt/tool/terminal JSONL, malformed stream, cancellation, no `models.json` access and runtime config drift.
- [ ] T157 [P] [US2] Add failing real-workspace, containment and path-disclosure cases to `tests/integration/pi-runner.test.ts`, `tests/security/pi-containment.test.ts`, `tests/security/runtime-path-disclosure.test.ts`, `tests/fixtures/tiny-repo/package.json`, `tests/fixtures/tiny-repo/sum.js`, and `tests/fixtures/tiny-repo/sum.test.js` — Acceptance: official tools can change any workspace project file and run Shell/network, path/symlink/subprocess escape attempts fail, and known workspace/state/session absolute-path canaries never appear in Worker events, MCP payloads, UI data, logs or Finalize Artifacts.

### Implementation

- [ ] T158 [US2] Implement the sandbox child and bundled in-memory model Extension using Pi SDK RPC/resource loading in `packages/provider-pi/src/worker-entry.ts`, `packages/provider-pi/src/mcp-model-extension.ts`, and `packages/provider-pi/src/runtime-resources.ts` — Acceptance: the Extension calls official `pi.registerProvider()` for one MCP model, cwd/session roots are Run-local, `models.json` is never accessed, SmartFlow MCP/global Skills are absent, and blocked work exits structurally.
- [ ] T159 [US2] Implement parent JSONL RPC, direct MCP config hash/probe, deadline handling and event/path/credential normalization in `packages/provider-pi/src/pi-provider.ts`, `packages/provider-pi/src/rpc-client.ts`, `packages/provider-pi/src/runtime-config.ts`, and `packages/provider-pi/src/event-normalizer.ts` — Acceptance: T156 passes, internal paths and API Key are redacted before events leave the provider, and no official Pi tool is wrapped/reimplemented.
- [ ] T160 [US2] Connect Pi Attempt lifecycle, runtime cleanup and Candidate capture in `apps/daemon/src/worker-runner.ts`, `apps/daemon/src/runtime-composition.ts`, and `apps/daemon/src/project-runtime.ts` — Acceptance: T157 passes, `.smartflow-runtime/` is absent from Result Snapshot/Candidate, and Candidate begins only after process reconciliation.
- [ ] T161 [US2] Remove Worker tool-decision/workerBlock protocol and Host branches, and apply external path redaction in `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/tools/status.ts`, `apps/mcp-server/src/tools/result.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `apps/mcp-server/src/tools/resume.ts`, `apps/host-skill/src/workflow.ts`, `packages/observability/src/redaction.ts`, and `packages/protocol/src/schema/mcp-tools.ts`; delete `apps/mcp-server/src/tools/submit-tool-decision.ts`, `tests/integration/worker-block-resume.test.ts`, and `tests/security/tool-decision.test.ts` — Acceptance: Pi cannot receive SmartFlow MCP/user tool answers, Leader handles terminal blocked state, and T157 path canaries never appear externally.
- [ ] T162 [US2] Delete Broker runtime and its dedicated tests from `packages/execution-broker/`, `apps/daemon/src/process-effect-dispatcher.ts`, `apps/daemon/src/state-store-broker-ledger.ts`, `apps/daemon/src/state-store-broker-ledger.test.ts`, `apps/daemon/src/state-store-effect-store.ts`, `tests/integration/broker-executor.test.ts`, `tests/security/broker-bypass.test.ts`, and `tests/crash/broker-process-durability.test.ts` — Acceptance: no Broker/effect ledger code or tests remain.
- [ ] T163 [US2] Delete OpenCode/Claude providers and dedicated fixtures/tests from `packages/provider-opencode/`, `packages/provider-claude-agent/`, `tests/live-provider/opencode/`, `tests/integration/opencode-runner.test.ts`, `tests/fixtures/opencode-vertical-slice-child.mjs`, and `bin/opencode`; remove their dependencies/scripts/build entries from `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsdown.config.mjs`, and `tsdown.helpers.config.mjs` — Acceptance: published/runtime dependency graph has Pi only and T156–T160 still pass.

**Checkpoint**: Real Pi performs workspace work; custom Broker/OpenCode/Claude code is gone.

---

## Phase 5: User Story 3 — Review and Repair the Pi Candidate (Priority: P1)

**Goal**: Existing bound Reviewer semantics operate on Pi-generated cumulative Candidates; repair starts a new Pi session but keeps the same Reviewer.

**Independent Test**: Complete `A → B → C`, confirm new Pi session for Revision 2, same Reviewer session, cumulative `A → C`, and no stale Review acceptance.

### Tests

- [ ] T164 [P] [US3] Update failing Review/repair coverage for Pi identities and no-progress stopping in `tests/e2e/review-repair.test.ts`, `tests/e2e/production-repair-loop.test.ts`, and `tests/contract/review-decision.test.ts` — Acceptance: tests distinguish Pi session from Reviewer session, require cumulative changed-path coverage, and prove that the same blocking finding with no effective related-path change across two repair rounds produces `REPAIR_NO_PROGRESS` without starting a third automatic repair.

### Implementation

- [ ] T165 [US3] Remove Broker/workerBlock assumptions while preserving Candidate/Reviewer bindings in `apps/daemon/src/review-coordinator.ts`, `apps/daemon/src/repair-coordinator.ts`, `packages/review/src/host-action.ts`, and `apps/host-skill/src/reviewer.ts` — Acceptance: T164 passes and Reviewer result still returns only to Leader.
- [ ] T166 [US3] Update repair Revision launch inputs in `packages/review/src/repair-loop.ts`, `apps/daemon/src/project-runtime.ts`, and `apps/daemon/src/repair-coordinator.ts` — Acceptance: each approved repair uses prior Result Tree, new Pi Attempt/session and existing ReviewerBinding.

**Checkpoint**: Review/Leader/repair behavior is unchanged except for explicit Pi session semantics.

---

## Phase 6: User Story 4 — Publish or Deliver the Reviewed Candidate (Priority: P1)

**Goal**: Pi Provider migration does not weaken Candidate binding, project-level serialization or zero-write conflict behavior.

**Independent Test**: Publish one accepted Pi Candidate and force an overlapping Run conflict; confirm `N/N` then `0/N` with no Broker/effect dependency.

### Tests

- [ ] T167 [P] [US4] Update publish regression cases to use Pi Attempts in `tests/integration/publish-cas.test.ts`, `tests/e2e/publish-safety.test.ts`, and `packages/publish/src/preflight.test.ts` — Acceptance: committed, bundle, conflict and PARTIAL/UNKNOWN results depend only on current Task/Candidate/Review/Leader evidence.

### Implementation

- [ ] T168 [US4] Remove legacy Worker-effect references from publish preparation/recovery in `apps/daemon/src/publish-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `packages/publish/src/publish-service.ts`, and `packages/publish/src/delivery-bundle.ts` — Acceptance: T167 passes, conflict remains zero-write `0/N`, and Publish is the only original-project write path.

**Checkpoint**: Existing safe Publish contract is green with Pi-generated Candidate state.

---

## Phase 7: User Story 5 — Reconnect, Recover, Cancel, or Start a New Task (Priority: P1)

**Goal**: Session behavior follows Task/Revision semantics, not an assumption that an old Pi process always survives.

**Independent Test**: Cover live Host reconnect, Pi crash, Daemon restart, repair Revision, independent feature and cancel.

### Tests

- [ ] T169 [P] [US5] Add failing Attempt/session/timeout recovery cases to `tests/crash/run-recovery.test.ts`, `tests/crash/cancel.test.ts`, `tests/crash/full-lifecycle.test.ts`, and `tests/integration/short-mcp-calls.test.ts` — Acceptance: live reconnect creates no session, crashes create exactly one new Attempt/session, timeout creates exactly one `TIMED_OUT` Attempt with zero surviving processes and no automatic replacement, and cancel kills the full process tree.
- [ ] T170 [P] [US5] Update concurrent-Run isolation cases for Pi in `tests/integration/state-concurrency.test.ts`, `tests/integration/mcp-lifecycle.test.ts`, and `tests/security/pi-containment.test.ts` — Acceptance: separate jobs never share Pi sessions/runtime/workspaces and one Run cancel does not affect another.

### Implementation

- [ ] T171 [US5] Implement Pi Attempt deadline, reconciliation and cancellation in `apps/daemon/src/worker-runner.ts`, `apps/daemon/src/recovery-manager.ts`, `apps/daemon/src/cancel-manager.ts`, and `packages/state-store/src/state-store.ts` — Acceptance: T169 passes, timeout persists `TIMED_OUT` and `PAUSED`, and unproven old containment blocks Candidate/recovery until reconciled.
- [ ] T172 [US5] Implement live reconnect/new-session routing in `apps/daemon/src/recovery-manager.ts`, `apps/daemon/src/runtime-composition.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `apps/mcp-server/src/tools/status.ts`, and `apps/mcp-server/src/tools/resume.ts` — Acceptance: session matrix in `contracts/pi-worker.md` is enforced and only Leader creates new Task/Revision intent.
- [ ] T173 [US5] Update installed lifecycle harness for Pi sessions and direct MCP model configuration in `tests/helpers/runtime-harness.ts`, `tests/fixtures/installed-mcp-lifecycle-child.mjs`, and `tests/e2e/installed-package.test.ts` — Acceptance: installed package completes start/reconnect/repair/review/publish with one in-memory model, no `models.json`, no source-tree imports and no legacy Provider state.

**Checkpoint**: Same Task recovers safely; independent feature receives a new Task/Run/Pi session.

---

## Phase 8: Final Cleanup and Validation

**Purpose**: Remove every obsolete reference and run the whole supported quality gate.

- [ ] T174 Remove remaining legacy package/build references from `apps/daemon/package.json`, `apps/cli/package.json`, `packages/provider-core/package.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsdown.config.mjs`, and `tsdown.helpers.config.mjs` — Acceptance: repository search finds no Broker/OpenCode/Claude/workerBlock runtime symbol except explicit migration-history documentation.
- [ ] T175 [P] Update current runtime documentation and package-facing descriptions in `README.md`, `apps/host-skill/package.json`, `apps/host-skill/src/index.ts`, `apps/cli/src/main.ts`, and `apps/cli/src/doctor.ts` — Acceptance: user-facing behavior documents direct MCP single-model fields, four API values, 1M/384K/high defaults, no `models.json`, Pi isolation/recovery and no Broker; no new prompt/constant-only unit tests are added.
- [ ] T176 Run typecheck, build, contract, integration, security, crash and e2e entries from `package.json`, then execute `specs/001-smartflow-mvp/quickstart.md` — Acceptance: all 4.0 gates pass, removed-code tests are absent, and no original-project mutation occurs before Publish.

## Dependencies and Execution Order

### Phase dependencies

- Phase 1 precedes all other phases.
- Phase 2 is blocking and must finish before any user story.
- US1 configuration must finish before the real Pi integration in US2 is activated.
- US2 is the runtime migration core and precedes US3–US5 implementation.
- US3 and US4 can proceed in parallel after US2 because they primarily touch Review and Publish files.
- US5 depends on Pi Attempt lifecycle from US2 and repair session rules from US3.
- Final cleanup runs after all five stories.

### Within-story order

- Write the listed behavior tests first and confirm they fail for the intended missing behavior.
- Implement contracts/models before runtime composition.
- Connect Daemon lifecycle after provider/sandbox primitives exist.
- Delete legacy packages and their dedicated tests once the Pi path is connected; do not leave compatibility flags.

### Parallel opportunities

- T142 can run alongside T141 after the package name/version decision is frozen.
- T143, T145, T147 and T150 touch separate contract areas and can run in parallel.
- T156 and T157 can be authored in parallel.
- T164 and T167 can run in parallel after US2.
- T169 and T170 can run in parallel.

## Implementation Strategy

1. Freeze schema and containment contracts.
2. Connect one real Pi vertical slice in an isolated workspace.
3. Immediately delete Broker/OpenCode/Claude paths and their tests.
4. Restore Review/Publish regression coverage.
5. Complete crash/session/cancel behavior.
6. Run the full acceptance walkthrough and repository residue check.

The migration is complete only when there is one Worker path: sandboxed Pi Coding Agent SDK with official tools.

## Phase 9: Convergence

- [ ] T177 CRITICAL: Remove every active OpenCode/Broker import and execution branch from `apps/daemon/src/runtime-composition.ts`, `apps/daemon/src/project-runtime.ts`, `apps/cli/src/main.ts`, `apps/mcp-server/src/server.ts`, and `apps/host-skill/src/workflow.ts` so Pi is the only runnable Worker per Constitution CP-004/CP-005 and FR-004/FR-010 (contradicts)
- [ ] T178 CRITICAL: Complete the direct Pi Attempt pipeline from Git workspace materialization through containment reconciliation, `.smartflow-runtime` cleanup, cumulative Candidate and Review Action creation per Constitution CP-005 and FR-006–FR-017 (partial)
- [ ] T179 CRITICAL: Replace legacy effect/managed-process recovery and cancellation with auditable `workerAttempts[]` crash recovery, frozen deadline handling, full-tree cancellation and zero-replacement timeout behavior per Constitution CP-010/CP-011 and FR-025–FR-027/FR-036 (missing)
- [ ] T180 CRITICAL: Enforce external absolute-path non-disclosure across `packages/provider-pi/src/event-normalizer.ts`, `packages/observability/src/redaction.ts`, `apps/mcp-server/src/server.ts`, and `tests/security/runtime-path-disclosure.test.ts` for Worker events, MCP responses, logs, Git/Finalize Artifacts and error payloads per Constitution CP-006 and FR-035 (partial)
- [ ] T181 Finish immutable MCP process configuration binding in `apps/daemon/src/project-runtime.ts`, `apps/daemon/src/worker-config.ts`, and `apps/cli/src/doctor.ts`, including direct API Key redaction, capability failure and hash-drift pause without fallback per FR-002–FR-005 and US1/AC2–AC7 (partial)
- [ ] T182 Complete Pi Review/Repair bindings using Task/Review Artifact references and `piSessionId`, preserve one Reviewer session, and stop after two no-progress rounds per FR-017–FR-022 and US3 (partial)
- [ ] T183 Remove legacy Worker-effect assumptions from `apps/daemon/src/publish-coordinator.ts`, `packages/publish/src/publish-service.ts`, and `tests/e2e/publish-safety.test.ts`, and restore committed, DeliveryBundle, zero-write conflict and PARTIAL/UNKNOWN regressions for Pi Candidates per FR-028–FR-031 and US4 (partial)
- [ ] T184 Complete background daemon reconnect, same-live-session, crash-new-session, new-Revision-session and concurrent-Run isolation behavior in `apps/daemon/src/recovery-manager.ts`, `apps/daemon/src/runtime-composition.ts`, `tests/crash/run-recovery.test.ts`, and `tests/integration/state-concurrency.test.ts` per FR-023–FR-026 and US5/AC1–AC4 (partial)
- [ ] T185 Add and pass the real Pi workspace/tool/network, MCP in-memory model registration, containment escape, timeout, crash, cancel and installed end-to-end acceptance matrix in `tests/e2e/installed-package.test.ts`, `tests/integration/pi-runner.test.ts`, and `tests/security/pi-containment.test.ts` per SC-001–SC-003 and SC-010–SC-015 (missing)
- [ ] T186 Remove remaining legacy user-facing names, CLI behavior, package/build residue and documentation references from `README.md`, `apps/cli/src/main.ts`, `package.json`, `pnpm-lock.yaml`, and `tsdown.config.mjs`, then run the complete quality gate and `specs/001-smartflow-mvp/quickstart.md` per plan: Acceptance Gate 9 (partial)

## Phase 10: Convergence

- [ ] T187 CRITICAL: Replace process-group-only Pi termination in `packages/workspace/src/execution-sandbox-adapter.ts` with a verified containment mechanism that cannot be escaped by detached or daemonized descendants, and add timeout/cancel regressions to `packages/workspace/src/execution-sandbox-adapter.test.ts` proving zero surviving processes per Constitution CP-011 and FR-007/FR-027/FR-036/SC-012 (contradicts)
- [ ] T188 CRITICAL: Restrict Darwin read access in `packages/workspace/src/execution-sandbox-adapter.ts` and `packages/provider-pi/src/runtime-resources.ts` to the resolved minimum Node, system-library and Pi SDK bootstrap paths, remove global host metadata discovery, and add host-data canaries to `tests/security/pi-containment.test.ts` per Constitution CP-005 and FR-009/US2/AC3 (contradicts)
- [ ] T189 CRITICAL: Remove or redact absolute SmartFlow Data Dir and project-data paths from CLI doctor text/JSON output in `apps/cli/src/doctor.ts` and add a doctor path-canary regression to `apps/cli/src/doctor.test.ts` per Constitution CP-006 and FR-035/US2/AC7 (contradicts)
- [ ] T190 Verify the installed Pi SDK version, Extension `registerProvider` support, required exports and RPC model-resolution compatibility in `packages/provider-pi/src/pi-provider.ts` and `apps/cli/src/doctor.ts` without a model request, and fail closed instead of reporting hard-coded capabilities per Constitution CP-004 and FR-004/FR-040/US1 (partial)
- [ ] T191 Consume Pi child stderr with bounded backpressure handling in `packages/provider-pi/src/pi-provider.ts`, redact it before any log or Artifact persistence, and cover diagnostic path canaries and pipe saturation in `packages/provider-pi/src/pi-provider.test.ts` per FR-011/FR-035 and plan: RPC lifecycle (partial)
- [ ] T192 CRITICAL: Expand the opt-in installed real-Pi acceptance matrix in `tests/e2e/installed-package.test.ts` to cover direct MCP model registration, read, search, add, modify, delete, Shell, network, path/symlink/subprocess escape, timeout, crash and cancel, then run it only after explicit fixture-export authorization per SC-001–SC-003/SC-010–SC-015 (missing)

## Phase 11: Direct MCP Single-Model Configuration

**Purpose**: Replace the incomplete Pi Provider/credential-indirection contract with one MCP-configured model registered directly in memory, without `models.json`.

**Independent Test**: Launch the installed MCP server with each supported API and one custom endpoint/model; verify Pi resolves exactly that model, defaults/overrides freeze correctly, no model config file is touched, and the API Key is absent from every persisted or external surface.

- [X] T193 [P] [US1] Add direct MCP configuration contract cases to `apps/daemon/src/worker-config.test.ts`, `packages/provider-pi/src/runtime-config.test.ts`, and `tests/integration/provider-config-binding.test.ts` — Acceptance: four APIs pass; required fields, default `1000000/384000/high/1800000`, legal overrides and `maxTokens <= contextWindow` are enforced; old Provider/credential-indirection fields are rejected.
- [X] T194 [US1] Implement the direct single-model MCP configuration and non-secret hashing in `apps/daemon/src/worker-config.ts`, `packages/provider-pi/src/runtime-config.ts`, `apps/daemon/src/provider-registry.ts`, and `apps/daemon/src/project-runtime.ts` — Acceptance: MCP environment is the sole source, API Key stays outside runtime config/state/hash, credential rotation changes only the daemon fingerprint, and no Worker/API/model fallback remains.
- [X] T195 [P] [US2] Add bundled Extension registration tests to `packages/provider-pi/src/mcp-model-extension.test.ts` and `packages/provider-pi/src/pi-provider.test.ts` — Acceptance: official `pi.registerProvider()` receives one model with the frozen API/Base URL/model/capabilities, fixed internal ID and environment credential reference for all four APIs; API Key bytes are never copied into registration diagnostics.
- [X] T196 [US2] Implement and package the static model Extension in `packages/provider-pi/src/mcp-model-extension.ts`, `packages/provider-pi/src/runtime-resources.ts`, `packages/provider-pi/src/worker-entry.ts`, `packages/provider-pi/package.json`, and `tsdown.workspace.config.mjs` — Acceptance: Pi RPC loads the bundled Extension from a read-only bootstrap path, resolves the single model, and neither host nor workspace `models.json` is generated/read.
- [X] T197 [US1] Update Pi probing and installed help for direct MCP configuration in `packages/provider-pi/src/pi-provider.ts`, `apps/cli/src/doctor.ts`, `apps/cli/src/provider-gate.ts`, `apps/cli/src/main.ts`, and `README.md` — Acceptance: doctor verifies SDK/Extension/RPC model resolution without sending a model request, reports field-specific failures, and never emits API Key or internal absolute paths.
- [X] T198 [P] [US2] Add no-file/no-secret isolated integration coverage to `tests/integration/pi-runner.test.ts`, `tests/integration/short-mcp-calls.test.ts`, `tests/security/pi-containment.test.ts`, `tests/security/runtime-path-disclosure.test.ts`, and `tests/e2e/installed-package.test.ts` — Acceptance: MCP values reach only the intended child, one model is selected, `models.json` read/write count is zero, API Key canary leakage is zero, and workspace/process containment remains unchanged.
- [X] T199 Remove legacy model configuration fields and fixtures from `apps/daemon/src/daemon-launcher.test.ts`, `tests/integration/short-mcp-calls.test.ts`, `tests/e2e/installed-package.test.ts`, `README.md`, and `apps/cli/src/main.ts` — Acceptance: runtime/help/tests contain none of `SMARTFLOW_WORKER`, `SMARTFLOW_MODEL_*`, `SMARTFLOW_PI_PROVIDER` or `SMARTFLOW_PI_CREDENTIAL_ENV`; removed-field tests are deleted rather than retained.
- [X] T200 Run typecheck, lint, workspace/root builds and all local contract/integration/security/crash/e2e tests from `package.json`, then execute the updated `specs/001-smartflow-mvp/quickstart.md` — Acceptance: all local gates pass; real-model export remains opt-in; no Git commit is created.

---

## Phase 12: SmartFlow 4.1 Solution D — Daemon-Owned Review Turn

**Purpose**: Record the implemented composite Review-turn architecture without retroactively closing unrelated 4.0 convergence work. T204/T205 are complete after regression coverage and final semantic approval; T208/T209 remain open and align with existing T190/T192.

**Only public Review orchestration flow**: `smartflow_execute → smartflow_review_turn*`
**Public MCP surface**: exactly `smartflow_execute`, `smartflow_review_turn`, `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`
**Independent Run management APIs**: `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`
**Daemon-internal mechanics**: atomic Review begin/finalization, deterministic decision planning, approved-scope repair continuation, and Publish scheduling
**Public states**: `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`

- [X] T201 [P] Add the four-state `smartflow_review_turn` schema, no-path state guards, handler/registry entry, and exact six-tool public surface in `packages/protocol/src/schema/mcp-tools.ts`, `packages/protocol/src/schema/protocol.test.ts`, `apps/mcp-server/src/tools/review-turn.ts`, `apps/mcp-server/src/tools/index.ts`, `apps/mcp-server/src/server.ts`, and `tests/contract/mcp-v5.test.ts`, and ensure the five legacy wait/claim/renew/Review-submission/Leader-decision names have no symbols, schemas, handlers, registrations, or aliases — Acceptance: the registry exposes exactly the six named tools; `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist on the public surface or as internal callable primitives, and stale/poll/pause outputs cannot carry `worktreePath`.
- [X] T202 Implement deterministic Daemon mechanics and Review planning in `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/project-runtime.ts`, `packages/review/src/review-decision.ts`, and `packages/review/src/review-decision.test.ts` — Acceptance: valid 100% Review automatically accepts/publishes, actionable incomplete Review repairs, no-guidance Review pauses invalid, and the fifteenth round pauses without a Host-side or transient internal Leader-decision phase.
- [X] T203 [P] Persist schema-v5 `HostTurn` (`AWAITING_REVIEW | AWAITING_USER_INPUT`) and `autoRepairRounds`, plus idempotent v4→v5 migration, in `packages/state-store/src/schema.ts`, `packages/state-store/src/state-store.ts`, `packages/state-store/src/test-fixture.ts`, and `packages/state-store/src/schema.test.ts` — Acceptance: checkpoint binds `hostTurnId + turnToken + revision`; migration removes claim/lease fields and safely pauses ambiguous active Review state; automatic repair increments durably; `resume_review_decision` atomically re-evaluates stored Review and resets `autoRepairRounds`.
- [X] T204 Add per-Run serialization, Project-wide CAS reconciliation, stable child request IDs, stale continuation protection, atomic Review begin/finalization, restart recovery, one durable 30-minute deadline, and at most four total CAS attempts (initial plus up to three retries) in `apps/daemon/src/host-turn-coordinator.ts`, `apps/daemon/src/host-turn-coordinator.test.ts`, `apps/daemon/src/review-coordinator.ts`, and `apps/daemon/src/project-runtime.ts` — Acceptance: no duplicate Review/repair/Publish across concurrency, mismatch, lost response, or restart; paused Review preserves owning Host unless an explicit handoff is authorized; begin replay returns the durable turn without another mutation; Host-turn recovery precedes general Run recovery and rereads fresh state.
- [X] T205 Update the Host Skill to use only the sole public `smartflow_execute → smartflow_review_turn*` path and preserve Reviewer CREATE/RESUME behavior in `apps/host-skill/src/workflow.ts`, `apps/host-skill/src/workflow.test.ts`, and `apps/host-skill/src/reviewer.ts`; ensure `apps/host-skill/src/action-loop.ts` and the `HostActionLoop` symbol do not exist — Acceptance: `changedPaths` reaches the Reviewer callback; every advertised `USER_INPUT_REQUIRED` action carries all required fields and inspection options; unanswered pauses do not call the independent `smartflow_result` management API; Host only executes Reviewer/obtains user answers; Reviewer differs from Pi and remains bound across Revisions; the `HostActionLoop` symbol and related public exports/registrations/aliases do not exist.
- [X] T206 Add production-composition two-tool automatic repair, restart, single-deadline, user-pause, and terminal-result coverage in `tests/e2e/production-repair-loop.test.ts` — Acceptance: Host-level trace is `smartflow_execute → smartflow_review_turn*`, repair completes through the production runtime without transient `LEADER_DECISION` or `REPAIR_TASKS_READY`, `USER_INPUT_REQUIRED` is nonterminal, and only terminal state returns `DONE`.
- [X] T207 [P] Harden Pi model Extension and child compatibility assumptions for four API registrations, default export shape, self-contained runtime resources, and safe-integer model metadata in `packages/provider-pi/src/mcp-model-extension.ts`, `packages/provider-pi/src/mcp-model-extension.test.ts`, `packages/provider-pi/src/runtime-resources.ts`, and `packages/provider-pi/src/worker-entry.ts` — Acceptance: local mocked/export-shape tests pass for all supported APIs without `models.json` or credential leakage.
- [ ] T208 Verify the actual pinned `@earendil-works/pi-coding-agent@0.83.0` package exports, Extension host `registerProvider()` behavior, and RPC model-resolution contract in a reproducible installed-package test without a model request; fail closed on incompatibility in `packages/provider-pi/src/pi-provider.ts`, `packages/provider-pi/src/runtime-resources.ts`, and `apps/cli/src/doctor.ts` — Acceptance: checked-in evidence exercises the real installed SDK rather than a mocked `registerProvider`; aligns with and may close existing T190 only when both acceptance sets are met.
- [ ] T209 Add an explicitly authorized, checked-in/auditable real Pi two-tool E2E that runs `smartflow_execute → smartflow_review_turn*` through Reviewer CREATE/RESUME, at least one automatic repair, and terminal Publish/result in `tests/e2e/installed-package.test.ts` plus a redacted durable fixture transcript — Acceptance: no source-tree import or mock Provider, no credential/internal-path leakage, and evidence is reviewable in the repository; aligns with existing T192 and is not satisfied by gitignored `.smartflow-e2e` output.
- [X] T210 Synchronize Solution D across `.specify/memory/constitution.md`, `spec.md`, `plan.md`, `research.md`, `data-model.md`, current/historical ADRs, `contracts/`, `quickstart.md`, glossary, checklist, root design index, and `implementation-map.md`; validate IDs, links, ownership wording, untouched generic Spec Kit config, and `git diff --check` — Acceptance: FR-042–FR-051, SC-016–SC-020, and T201–T210 form a complete requirements→design→task→code→test map while T208/T209 remain visibly open.

### Phase 12 evidence boundary

- The schema-v5 Review simplification target matrix passes 63/63: state migration 7, protocol 11, Host-turn coordination 11, MCP lifecycle 17, production repair-loop E2E 4, crash recovery 10, and Pi-runner integration 3.
- Post-lint affected regressions pass 22/22; root build, typecheck, lint, and `git diff --check` pass. TypeScript source search finds zero removed wait/claim/renew/submit-review/report-unavailable/submit-leader callable schema or method symbols.
- This evidence closes T201–T207 only within their stated acceptance scope; it does not prove the real installed Pi SDK/endpoint.
- The real-Pi installed-package test remains explicitly gated and was not run, and no checked-in redacted transcript exists; T208/T209 and T190/T192 remain open.
