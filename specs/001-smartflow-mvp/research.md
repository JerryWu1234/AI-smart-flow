# SmartFlow 4.1 Design Decisions

## Decision 1: Use Pi Coding Agent SDK, not Agent Core directly

**Decision**: SmartFlow Worker integrates `@earendil-works/pi-coding-agent`. `@earendil-works/pi-agent-core` remains an upstream implementation dependency, not SmartFlow's direct coding runtime.

**Rationale**: Coding Agent SDK already supplies agent session management, coding tools, resource loading and RPC mode. Agent Core alone would require SmartFlow to rebuild the exact file/tool layer the migration is intended to remove.

**Alternatives considered**: Direct Agent Core integration was rejected because it recreates a custom coding-agent and tool stack.

## Decision 2: Delete Broker and use Pi official tools directly

**Decision**: Pi directly uses official `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`. SmartFlow removes ToolExecutionBroker, broker bridges, effect IDs/hashes/receipts and per-tool user decisions.

**Rationale**: Two file-operation implementations create duplicated semantics and maintenance. Once the whole Worker is strongly contained, a second in-process permission layer is not the security boundary.

**Alternatives considered**: Keeping Broker as a Pi tool bridge was rejected because it preserves the duplicate file-operation system and disables Pi's native coding behavior.

## Decision 3: Sandbox the entire Pi process tree

**Decision**: Pi Worker and every subprocess run inside an OS sandbox. Project/user-data access is limited to the current Revision workspace; arbitrary workspace-local Shell commands and network access are allowed. Node.js, system runtime files and Pi SDK receive only the read-only bootstrap access needed to run.

**Rationale**: Shell commands can spawn arbitrary processes and bypass JavaScript path guards. Process-level containment is the only boundary that applies consistently to official tools, Shell commands and their descendants.

**Alternatives considered**: Prompt-only restrictions and per-tool path validation were rejected because neither constrains subprocess system calls.

## Decision 4: Run Pi as a sandbox child over SDK JSONL RPC

**Decision**: Daemon launches a small child entry that imports Pi Coding Agent SDK and runs its RPC mode. Parent and child communicate through JSONL stdin/stdout; SDK execution never occurs inside the unsandboxed Daemon process.

**Rationale**: Pi SDK supports programmatic sessions and JSONL RPC. A child process makes the OS sandbox, process-tree cancellation and session lifecycle explicit without turning the CLI UI into the integration boundary.

**Alternatives considered**: Calling `createAgentSession` directly in Daemon was rejected because the Agent and its tools would inherit Daemon filesystem authority. Driving the interactive CLI was rejected because it is not a stable SDK integration surface.

## Decision 5: Split Host-only capabilities from Daemon-owned mechanics

**Decision**: Host/Leader retains SmartFlow MCP, Reviewer creation/restoration, and all user interaction. Pi Worker receives no SmartFlow MCP server. The Daemon owns frozen deterministic mechanics after execution starts: bounded waiting, Review Action claim/renewal, Review submission, accept/repair/pause planning, same-scope repair continuation, and Publish progression. The Daemon never creates or replaces a Reviewer. Current migration does not dynamically inject Host/global Skills; only project-local resources already present in the workspace may be discovered by Pi.

**Rationale**: Leader-only interaction is a capability and authority boundary, not a requirement that one live Host manually reproduce every state-machine transition. Moving deterministic mechanics into the durable Daemon removes duplicated CAS/retry logic while preserving the two capabilities only Host has: native Reviewer sessions and user communication.

**Alternatives considered**: Keeping the complete orchestration loop in Host was rejected because claim/retry/restart state remained non-durable and each Host integration could diverge. Letting Daemon create Reviewer sessions was rejected because it violates the independent Reviewer capability boundary. Exposing SmartFlow MCP/global Skills to Pi was rejected because it broadens authority and couples control planes.

## Decision 6: Recover business state, not an assumed live Pi session

**Decision**: Host reconnect continues the same live Attempt/session. Worker or Daemon crash creates a new Attempt/Pi session with the same job, Revision and workspace. A frozen Attempt deadline terminates the containment and persists `TIMED_OUT` before controlled recovery. A new Revision creates a new Pi session. An independent new feature creates a new Task/Run, as classified by Host/Leader from user intent.

**Rationale**: Task Artifacts, Revision snapshots and `state.json` are durable; an in-memory Agent session is not. Recovery must remain correct even when session files or processes are gone.

**Alternatives considered**: Requiring every crashed process to resume the identical Pi session was rejected because it makes recovery depend on unproven external state.

## Decision 7: Git owns snapshot/diff semantics, not the control plane

**Decision**: Each Run uses a temporary Git object store and Revision-scoped index below SmartFlow Data Dir. Git produces Tree/Blob/Diff evidence; Artifact, Sandbox, Review, automatic decision and Publish state machines remain authoritative.

**Rationale**: Git provides stable path, blob, mode and symlink semantics without changing the user's repository state.

**Alternatives considered**: `git worktree add` was rejected because it registers metadata in the user's repository and does not capture the full approved dirty-worktree view.

## Decision 8: Capture one immutable Baseline and chain Revisions

**Decision**: Run Baseline `A` is captured once. Revision 1 produces `B`; Revision 2 consumes `B` and produces `C`. Formal Candidate is cumulative `A → C`; adjacent `B → C` is repair evidence only. Git LFS, `.gitattributes`, and custom filters do not affect capability probing; workspace bytes follow the normal file flow.

**Rationale**: Review/Publish need the complete final result while repair needs the current-round delta. Replacing Baseline would lose earlier changes.

**Alternatives considered**: Re-snapshotting the original project for each repair was rejected because it breaks cumulative Candidate identity.

## Decision 9: Freeze task bytes; use task path only as concurrency identity

**Decision**: `smartflow_execute` canonicalizes the task-file path and freezes approved bytes as an Artifact. One canonical path may have one Active Run; different task files may run concurrently, even when Candidates overlap.

**Rationale**: This supports multiple Host windows without allowing a mutable task file to alter an in-flight Run.

**Alternatives considered**: Code-path reservations were rejected because predicted paths are incomplete and publish-time conflict detection already protects the original project.

## Decision 10: Serialize Publish and remove legacy runtime state

**Decision**: Project Publish remains serialized and conflict-checked. 4.x state removes OpenCode/Claude identity, Broker sessions, effects, managed-process ledgers and Worker tool-decision blocks. Old Active Runs are not migrated into Pi Attempts.

**Rationale**: Keeping dead state would preserve two incompatible recovery models. Publish correctness depends on Candidate/Review/expected-old evidence, not on the removed Worker tool ledger.

**Alternatives considered**: A compatibility adapter was rejected because it would keep Broker/OpenCode code alive and could misrepresent old effects as recoverable Pi sessions.

## Decision 11: MCP configuration directly registers one in-memory Pi model

**Decision**: The SmartFlow MCP server process environment is the sole user configuration source for one model. Required fields are API protocol, Base URL, model ID and direct API Key. The sandbox child loads one bundled SmartFlow Pi Extension, which calls Pi's official `registerProvider()` API with the frozen values. SmartFlow neither generates nor reads `models.json`, and no Provider-selection field is exposed to the user.

**Rationale**: Pi RPC selects a registered model but does not accept a complete custom endpoint/model definition as ordinary prompt input. The official Extension API registers the model in memory while retaining Pi's official RPC, Agent loop and coding tools. This uses the MCP configuration directly, keeps credentials out of files and avoids rebuilding a child Agent protocol or Broker.

**Alternatives considered**: User-maintained or SmartFlow-generated `models.json` was rejected because MCP configuration must be the only source. Running the SDK Agent loop inside Daemon was rejected because it would inherit Daemon filesystem authority. Replacing Pi RPC with a custom child protocol was rejected because it recreates Agent control-plane code.

## Decision 12: Freeze standard API protocol and explicit model metadata

**Decision**: `SMARTFLOW_PI_API` identifies the wire protocol, not a Worker Provider, and accepts `openai-completions`, `openai-responses`, `anthropic-messages` or `google-generative-ai`. Each MCP instance binds exactly one model. Default model metadata is a 1,000,000-token context, 384,000-token maximum output, reasoning enabled and thinking level `high`; context, output, thinking and Attempt deadline remain optional MCP overrides.

**Rationale**: Suppliers may expose more than one compatible protocol, while "OpenAI" alone is ambiguous between Chat Completions and Responses. Exact Pi API identifiers avoid that ambiguity. Explicit overrides handle models with lower limits.

**Alternatives considered**: A supplier-name enum was rejected because supplier and protocol are not equivalent. Automatic model discovery and multi-model profiles were rejected because one MCP instance intentionally binds one model.

## Decision 13: Add one durable composite Review turn while retaining primitives

**Decision**: The preferred Host flow is `smartflow_execute → smartflow_review_turn`. The composite tool exposes exactly four states: `NOT_READY`, `REVIEW_REQUIRED`, `USER_INPUT_REQUIRED`, and terminal-only `DONE`. It durably checkpoints `CLAIMING`, `AWAITING_REVIEW`, or `AWAITING_USER_INPUT`, binds ownership with `hostTurnId + turnToken + revision`, serializes each Run, and performs Project-wide CAS with stable child request IDs. The previous ten primitive tools remain public, yielding exactly eleven tools.

After a valid Review, `planReviewDecision()` produces only `ACCEPT`, `REPAIR`, `PAUSE_INVALID_REVIEW`, or `PAUSE_REPAIR_LIMIT`. Accept requires 100%; repair uses current blocking finding fingerprints and a 15-round allowance; invalid/no-guidance Review pauses with only cancel; `resume_review_decision` grants the next allowance. Worktree path disclosure occurs only after durable claim completion in `REVIEW_REQUIRED`.

**Rationale**: One composite boundary centralizes idempotency, deadline/renewal, CAS and restart recovery while allowing the Host to perform the two non-daemon capabilities. Keeping primitives avoids a breaking API removal and preserves explicit diagnostics/recovery.

**Alternatives considered**: Removing primitive tools was rejected as unnecessary breakage. Returning internal phases directly was rejected because Host callers need a stable four-state protocol, not Daemon implementation details. Treating pauses as `DONE` was rejected because it loses required user input and creates false completion.

## Evidence boundary

The core schemas, deterministic policy, and production-composition flow are implemented. T204/T205 boundary behaviors are closed with regression coverage and final semantic approval: paused ownership cannot transfer through composite or compatibility mutations; lost successful claims reconcile and schedule from the durable lease; `changedPaths` reaches both Reviewer callback paths; and every composite pause embeds canonical result evidence with disjoint mutable, inspection, collection, and confirmation contracts, without primitive `smartflow_result` fallback.

Production-composition and mocked Extension tests also do not prove the actual installed Pi package's export/Extension/RPC compatibility or a real endpoint. Pi is pinned at 0.83.0; T190/T208 require reproducible real-SDK host evidence. T192/T209 require an explicitly authorized, checked-in real-model two-tool E2E transcript or equivalent auditable artifact. A gitignored local `.smartflow-e2e` success does not close either requirement.

## Upstream evidence

- SDK sessions, tools and resource loading: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- JSONL RPC commands/events and process integration: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Agent Core boundary: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- Package engine/dependency metadata: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json
- Pi dynamic Provider registration: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregisterprovidername-config
