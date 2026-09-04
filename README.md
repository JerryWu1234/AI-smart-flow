# SmartFlow

```sh
npm install --global @jerrywu1234/smartflow
smartflow doctor --json
```

SmartFlow runs `@earendil-works/pi-coding-agent` in an isolated per-Run Git workspace. Pi uses its official read, search, edit, write and Shell tools directly; SmartFlow does not provide a custom file Broker or pass its MCP/Host Skills into Pi.

Shell commands and network access are allowed inside the sandbox. Project and user data are readable and writable only through the isolated workspace; Node, system and Pi SDK bootstrap paths are read-only. The original project is changed only by the Publish stage.

Each `smartflow_execute` call creates an immutable Job bound to one canonical task path, exact task source and TaskManifest, and Provider configuration. In-scope automatic Review repair starts a new fenced Worker Attempt in the same workspace and restores the same logical Pi session from its completed bundle; process restarts and Daemon crashes restore that session after containment reconciliation too. To change the task or configuration, or to act on an out-of-scope repair draft, cancel the current Job and execute the new task source as a new Job. Each Attempt starts with its configured rolling deadline, five minutes by default, which the Pi child renews with independent heartbeats; expiry pauses without automatic replacement, and cancellation must prove the full process tree is gone.

Every Worker setting lives in the `WORK_` environment namespace, and the same names carry from the MCP server to the Worker without translation. Each MCP server instance binds one model directly from `WORK_BASE_URL`, `WORK_MODEL` and `WORK_API_KEY`. The optional `WORK_API` setting defaults to `openai-responses`; explicit supported values are `openai-completions`, `openai-responses`, `anthropic-messages` and `google-generative-ai`. SmartFlow does not probe endpoints or switch formats after a request fails. Optional variables `WORK_CONTEXT_WINDOW`, `WORK_MAX_TOKENS`, `WORK_EFFORT` and `WORK_ATTEMPT_DEADLINE_MS` configure context, output, reasoning effort and the rolling Attempt deadline, defaulting to `1000000`, `384000`, `high` and `300000ms`; `WORK_EFFORT` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, and deadline overrides must be at least `60000ms`. SmartFlow registers the model in memory through a bundled Pi Extension and does not use `models.json`.

Reviewer configuration uses the MCP server environment variables `REVIEW_ENABLED`, `REVIEW_ADAPTER`, `REVIEW_MODEL` and `REVIEW_EFFORT`. Review is enabled unless `REVIEW_ENABLED` is exactly `false`; when disabled, SmartFlow skips Reviewer executable checks and publishes the Worker Candidate directly. `REVIEW_ADAPTER` accepts `codex`, `codex-desktop`, `claude-code` or `claude-code-desktop`, while model and effort are passed through to the selected Reviewer. When Review is enabled, SmartFlow checks the explicitly selected local Agent before the MCP server or Daemon becomes ready: both Codex strategies require `codex` on `PATH`, and both Claude strategies require `claude`. Reviewer configuration is read when the Daemon starts, so restart the Daemon after changing any `REVIEW_*` value.

Run `smartflow doctor --json` to verify Node, Pi, sandbox, model registration, signing and publish capabilities.

## MCP workflow

### Review Agent selection

When `REVIEW_ADAPTER` is omitted, the Daemon uses the MCP Host's unauthenticated
`clientInfo.name` only as a coarse default. An exact registered strategy name selects itself;
missing or unrecognized names fall back to `codex`. An explicit `REVIEW_ADAPTER` always wins.
Host identity never grants permissions.

`claude-code` and `claude-code-desktop` are separate durable strategy identities, but both
start a standalone local `claude -p` process. The Desktop strategy is a compatibility module
for Desktop-host configuration; Claude Desktop exposes no headless reviewer transport, so
SmartFlow does not attach to, resume, or control the Desktop conversation, embedded CLI, or
GUI. The standalone Claude Code CLI must be installed and authenticated in the Daemon
environment for either strategy.

### Host task preparation and approval

Before `smartflow_execute`, the MCP Host must distinguish implementation intent from ordinary conversation. It must not create task files or execute SmartFlow for casual chat, explanations, evaluations, discussions, or planning-only requests. If an implementation request is missing a critical goal, scope, target, or acceptance criterion, the Host asks the user for that information instead of inventing it.

For every new implementation request—even a later request in the same Host conversation—the Host creates a fresh filesystem-safe `requestId` and writes exactly one canonical file inside the user project:

```text
<projectRoot>/.smartflow/tasks/<requestId>/tasks.md
```

Chat context, one existing task file, or multiple existing task/spec files are preparation inputs; they are always normalized into that one canonical file for the current request. The Host never overwrites a previous request directory. For example, two sequential requests use independent paths:

```text
.smartflow/tasks/550e8400-e29b-41d4-a716-446655440000/tasks.md
.smartflow/tasks/6ba7b810-9dad-41d1-80b4-00c04fd430c8/tasks.md
```

Canonical task syntax follows the SmartFlow parser contract:

```md
## M01 User authentication

- [ ] T001 [M01] Implement login validation in `src/auth/login.ts` — 验收：valid users can log in and invalid passwords return an explicit error
- [ ] T002 [M01] Add login coverage in `src/auth/login.test.ts` — 验收：success and failure cases pass
```

After writing the file, the Host re-reads it from disk, presents its project-relative path and complete contents, and explicitly asks the user whether to execute it. The initial request to implement something authorizes draft preparation, not execution. Only after explicit confirmation does the Host compute SHA-256 over the exact confirmed disk bytes and call `smartflow_execute` with the same `requestId` in both the input and `.smartflow/tasks/<requestId>/tasks.md` path.

The task file is created by the Host's native filesystem capabilities at request time; it is not stored in the npm package or `node_modules`. `.smartflow/tasks/**` is SmartFlow control-plane data: tracked, untracked, and ignored files under that prefix are excluded from Run baselines, RUN_RESULT snapshots, Candidates, and Publish. The Worker workspace receives only the current Job's immutable task source from the Daemon artifact; historical request directories are not materialized. Daemon artifacts remain under `projects/<projectId>/runs/<jobId>/task-source.md` and `task-manifest.json` in the configured SmartFlow data directory.

This approval flow is a trusted Host policy. `approvedSourceHash` binds execute to exact bytes, but it is not a server-verifiable proof that a human confirmed them.

### Execution and Review loop

The public MCP surface contains exactly six tools. For each newly confirmed request, call `smartflow_execute` once with its canonical task source, then call `smartflow_review_turn` until it returns `DONE`. Review runs inside the Daemon; the Host only polls and answers explicit user-input checkpoints. The turn API returns one of three states:

- `NOT_READY`: wait for `retryAfterMs` and call it again. This includes Daemon-owned Review and repair work.
- `USER_INPUT_REQUIRED`: present the message and available actions to the user, then return the selected action with the unchanged `turnToken`.
- `DONE`: the run reached a terminal result; the latest validated Review is available in `result.review` when one was recorded.

`smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` are separate APIs for Run inspection, paused-Run recovery, cancellation, and result management; they are not Review continuations or a second Review orchestration path. While an active `hostTurn` owns `USER_INPUT_REQUIRED`, the owning Host must submit the answer through `smartflow_review_turn` with the same `turnToken`; the public `smartflow_resume` API cannot answer or bypass that checkpoint.

Waiting, atomic Review begin/finalize, automatic decisions, and repair/publish progression are Daemon-owned mechanics. The public MCP surface has no Host-owned claim/renew bridge or manual Review-submission path.