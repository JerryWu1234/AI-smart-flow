# SmartFlow 4.0 Acceptance Walkthrough

This walkthrough validates the Pi migration, removal of Broker/OpenCode and retention of isolated Git Workspace, Review and Publish behavior.

## 1. Freeze task and Pi configuration

1. Start the MCP server with exactly one configured model: `SMARTFLOW_PI_API`, `SMARTFLOW_PI_BASE_URL`, `SMARTFLOW_PI_MODEL` and `SMARTFLOW_PI_API_KEY`.
2. Omit optional model values and confirm the frozen configuration uses context `1000000`, max output `384000`, thinking `high` and Attempt deadline `1800000ms`; repeat with legal overrides.
3. Start a Run from `tasks-a.md`; record canonical path, Task Artifact, `tasksSha256` and `providerRuntimeConfigHash` while confirming the API Key is absent from all recorded values.
4. Confirm the canonical task file is mirrored to the Run worktree before Worker execution and the Reviewer reads that same worktree copy.
5. Change effective Pi runtime config; confirm the active Revision pauses/fails instead of changing model or API.
6. Start through a path alias; expect `TASK_ALREADY_ACTIVE` and no new Pi Attempt/workspace.
7. Repeat configuration parsing with each supported API: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.

## 2. Start sandboxed Pi

1. Confirm `ExecutionSandboxAdapter` launches the Pi SDK child and records Attempt, Pi session and containment identity.
2. Confirm the child loads only the bundled SmartFlow model Extension and registers exactly one MCP-configured model through Pi's official runtime API.
3. Confirm JSONL RPC ready/prompt/events/terminal flow over stdin/stdout.
4. Confirm the child uses the frozen Task and never asks the user directly.
5. Confirm Pi receives no SmartFlow MCP server or Host/global Skill directory.
6. Place `models.json` canaries in the host Pi directory and workspace, then confirm neither is read and no new `models.json` is created anywhere in the Run.

## 3. Exercise Pi official tools

1. Ask Pi to read, search, add, modify and delete project files, including `tasks.md` or `.specify` content inside the isolated workspace.
2. Run Shell commands that create child processes, execute project test/lint/build and access a network fixture.
3. Confirm these operations succeed without Broker receipts, effects or tool-decision Actions.
4. Confirm Result Snapshot and Candidate contain project changes, not `.smartflow-runtime/` files.

## 4. Prove filesystem isolation

1. Attempt direct, absolute-path, symlink and subprocess access to the original project root; expect denial.
2. Repeat for SmartFlow state, another Run workspace and a host-user sensitive directory; expect denial.
3. Confirm required Node/system/Pi SDK bootstrap files are read-only and do not expose user data.
4. Confirm Publish has not run and original project Worktree/index/refs are unchanged.
5. Put known absolute path canaries in SDK error, stack, Shell output and status data; confirm MCP/API/UI payloads, logs and finalized Artifacts expose only logical IDs or project-relative paths.
6. Use the configured API Key as a canary; confirm it is absent from argv, runtime hash, TaskManifest, Run state, Pi session files, Artifacts, diagnostics and errors.

## 5. Validate session and recovery rules

1. Disconnect/reconnect Host while Pi child lives; confirm job, Attempt and Pi session are unchanged.
2. Crash Pi child; confirm old Attempt is reconciled and one new Attempt/session starts on the same Revision/workspace.
3. Restart Daemon; confirm recovery uses `state.json`, not an assumed live Pi session.
4. Approve a repair Revision; confirm a new Pi session starts from previous Result Tree.
5. Submit an independent feature; confirm Leader creates a new Task/Run/session.
6. Cancel a Run; confirm the full Pi process tree exits before CANCELED becomes durable.
7. Force an Attempt deadline; confirm the full Pi process tree exits, exactly one `TIMED_OUT` Attempt is durable, Run is `PAUSED`, and no replacement Attempt/Candidate appears before Leader recovery.

## 6. Validate multi-Revision Candidate and Review

1. Record Run Baseline `A`.
2. Complete Revision 1 as `A → B` and Review it with Reviewer `S1`.
3. Complete repair Revision 2 as `B → C` using a new Pi session.
4. Confirm formal Candidate is `A → C`, repair evidence is `B → C`, and Revision 1 evidence is immutable.
5. Confirm Host resumes Reviewer `S1`; Pi session identity is not reused as Reviewer identity.

## 7. Publish safely

1. With accepted Review, acquire Project Publish lease and publish a non-conflicting Candidate.
2. Confirm all `N/N` paths are COMMITTED before COMPLETED.
3. For two Runs touching the same path, publish the first and expect the second to return `PRECHECK_CONFLICT`, conflict paths, `0/N` and DeliveryBundle.
4. Disable required batch capability; confirm only DeliveryBundle is produced.
5. Simulate PARTIAL/UNKNOWN; confirm `PUBLISH_RECOVERY_BLOCKED`, never false COMPLETED.

## 8. Verify legacy removal

1. Confirm workspace packages and published dependencies contain no OpenCode binary/SDK, Claude Provider placeholder or execution-broker package.
2. Confirm runtime/protocol/state have no Broker session, effects, managed-process ledger, workerBlock or `smartflow_submit_tool_decision`.
3. Confirm deleted implementation tests are removed and replacement Pi containment/session tests pass.
4. Reconcile a terminal Run; confirm temporary Workspace/runtime/index/object store are deleted while Task/Candidate/Review/Publish/session audit Artifacts remain verifiable.
5. Confirm runtime code and CLI help contain none of `SMARTFLOW_WORKER`, `SMARTFLOW_MODEL_*`, `SMARTFLOW_PI_PROVIDER` or `SMARTFLOW_PI_CREDENTIAL_ENV`.

The installed real-model acceptance is intentionally opt-in because it sends the fixture task and project files to the configured model endpoint. Run it only after explicit approval with `SMARTFLOW_RUN_REAL_PI_E2E=1`, the four required `SMARTFLOW_PI_*` variables, and any optional capability overrides.
