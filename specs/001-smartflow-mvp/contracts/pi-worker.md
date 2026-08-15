# Pi Worker Contract

## Worker identity

1. Worker is always implemented with `@earendil-works/pi-coding-agent`; SmartFlow exposes and persists no Worker Provider-selection field.
2. OpenCode, Claude Agent SDK and custom Agent Core integrations are not fallback paths.
3. Each Revision binds a `providerRuntimeConfigHash`; mismatch pauses/fails before prompt execution.

## MCP model configuration

1. The SmartFlow MCP server process environment is the sole user configuration source, and one MCP instance binds exactly one endpoint/model.
2. Required fields are `SMARTFLOW_PI_API`, `SMARTFLOW_PI_BASE_URL`, `SMARTFLOW_PI_MODEL` and `SMARTFLOW_PI_API_KEY`.
3. `SMARTFLOW_PI_API` accepts only `openai-completions`, `openai-responses`, `anthropic-messages` and `google-generative-ai`. It identifies the wire protocol, not a Worker Provider or supplier name.
4. Optional `SMARTFLOW_PI_CONTEXT_WINDOW`, `SMARTFLOW_PI_MAX_TOKENS`, `SMARTFLOW_PI_THINKING` and `SMARTFLOW_PI_ATTEMPT_DEADLINE_MS` default to `1000000`, `384000`, `high` and `1800000`; all numeric values are positive integers and max tokens cannot exceed context.
5. Model capability is registered as reasoning-capable and text-input by default. `SMARTFLOW_PI_THINKING=off` disables reasoning for the session without changing model identity.
6. `SMARTFLOW_WORKER`, `SMARTFLOW_MODEL_API_FORMAT`, `SMARTFLOW_MODEL_API_KEY`, `SMARTFLOW_MODEL_BASE_URL`, `SMARTFLOW_MODEL`, `SMARTFLOW_PI_PROVIDER` and `SMARTFLOW_PI_CREDENTIAL_ENV` are unsupported and are not fallback sources.
7. API Key is kept outside runtime configuration/state. It may be present only in MCP/Daemon/Pi process memory and the Pi child environment; it cannot enter argv, hashes, manifests, state, sessions, Artifacts, diagnostics or errors.

## In-memory model registration

1. The sandbox child loads one bundled SmartFlow Pi Extension and uses Pi's official `pi.registerProvider()` API to register the frozen endpoint/model in memory.
2. The Pi-internal registration ID is fixed by SmartFlow and cannot be supplied by MCP, Task Markdown or restored state. It is not serialized as a SmartFlow Provider field.
3. SmartFlow and Pi must not generate, read or require `models.json` in the host user directory, isolated workspace or Run runtime directory.
4. The child selects the single registered model through official Pi RPC startup options. No custom Agent loop, file tools or child control protocol is introduced.
5. A selected endpoint must conform to its declared standard API. Protocol/authentication mismatch fails explicitly and does not trigger API/model fallback.

## Process boundary

1. Pi SDK Agent loop and bundled model Extension run in a child process created by `ExecutionSandboxAdapter`, never inside Daemon.
2. Parent and child use SDK JSONL RPC over stdin/stdout; stderr is diagnostic only.
3. The sandbox handle exposes stable containment/process identity, bidirectional streams, exit reconciliation and full process-tree termination.
4. Unexpected child exit, malformed RPC or lost containment ends the current Attempt. Host code must not continue the Agent loop outside the sandbox.
5. The frozen Attempt deadline applies to the child and all descendants. Expiry terminates the containment tree, persists `TIMED_OUT`, and pauses the Run; unproven termination blocks replacement execution.

## Tool ownership

1. Pi directly owns and invokes official `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` tools.
2. SmartFlow must not intercept these calls through ToolExecutionBroker, a workspace dispatcher, MCP bridge, effect ledger or per-tool user decision.
3. Pi may edit, add or delete any project file inside the current isolated workspace, including task/spec files present there.
4. Pi may execute arbitrary Shell commands, launch subprocesses and access the network.

## Filesystem containment

1. Project-data read/write access is limited to the current Revision workspace.
2. Original project root, SmartFlow project Data Dir outside the Pi-visible runtime area, other Run workspaces and host-user data are denied.
3. Node.js, required system libraries and installed Pi SDK may be exposed read-only only as bootstrap dependencies.
4. Absolute paths, symlinks and child processes cannot expand project-data authority beyond the workspace.
5. Sandbox capability is fail closed; unsupported platforms cannot start Pi Worker.

## External path non-disclosure

1. Pi may know its own workspace cwd internally, but MCP, API, UI payloads and logs must not expose that absolute path.
2. Workspace, SmartFlow state, Run runtime and session paths are serialized externally as logical IDs, project-relative paths or controlled Artifact references.
3. SDK errors, stack traces and Shell output are redacted before external return or durable log storage.
4. Finalized Candidate/Review/log/session Artifacts may be listed, but their content and metadata must not reveal internal absolute paths.

## Prompt and resource boundary

1. Prompt input comes only from frozen Task/Revision Artifacts and current structured RepairItems.
2. Pi receives no SmartFlow MCP server and cannot wait for user input.
3. Host/global Skills are not dynamically injected. Resource discovery is rooted at the isolated workspace and Run-local agent directory; user-level discovery outside containment is disabled, including user-level Pi model configuration.
4. If Pi cannot continue, it terminates with a structured blocked/failed result for Leader handling.

## Session rules

| Event | Required session behavior |
|---|---|
| Host reconnect while child lives | continue same Attempt/session |
| Pi child or Daemon crash | reconcile old containment; create new Attempt/session on same Revision/workspace |
| Attempt deadline expires | terminate containment; persist `TIMED_OUT`; wait for Leader recovery decision |
| Approved repair/new Revision | create new Attempt/session from prior Result Snapshot |
| Independent new feature | Leader creates new Task/Run/session |
| Cancel | terminate entire containment tree and persist CANCELED |

Pi session files are supporting evidence. `state.sqlite`, frozen Task, Revision and Git snapshots remain authoritative.

## Candidate handoff

1. Active Pi runtime/session files live below `.smartflow-runtime/` in the Revision workspace.
2. After Pi terminates, Daemon persists required session evidence outside the sandbox as an Artifact.
3. `.smartflow-runtime/` is excluded or removed before Result Snapshot and Candidate generation.
4. Candidate generation starts only after the process tree is reconciled; if termination cannot be proven, the Run pauses.

## Pinned Pi SDK compatibility evidence

1. The implementation dependency is pinned to `@earendil-works/pi-coding-agent@0.83.0`; compatibility is a runtime gate, not an assumption derived only from TypeScript mocks.
2. A complete gate must load the actual installed package and prove the required exports, Extension default-export loading, official `registerProvider()` host behavior, and RPC selection/resolution of the one registered model without sending a model request.
3. Mocked `pi.registerProvider`, source-tree-only tests, production-composition Review E2E, and a manually successful gitignored `.smartflow-e2e` run do not independently prove the installed package contract.
4. Missing or incompatible real exports/Extension/RPC behavior must fail closed in Provider probing and CLI doctor; it must not report hard-coded support or fall back to another model path.
5. Real-model acceptance transmits fixture content to the configured endpoint and therefore runs only after explicit authorization. Its evidence must be redacted, durable, and reviewable without credentials or internal absolute paths.
6. T190/T208 track real installed SDK compatibility. T192/T209 track authorized real-model two-tool E2E. Both pairs remain open until their checked-in evidence exists.
