# SmartFlow

[Chinese documentation](README.zh-CN.md)

SmartFlow is an MCP-based coding workflow that turns an approved task file into an isolated, reviewable implementation run. It starts the Pi coding agent in a per-run Git workspace, persists state in SQLite, runs an optional reviewer, performs in-scope repair rounds, and publishes changes only after the workflow has produced a validated result.

> SmartFlow is currently an early-stage project. The public package is `@jerrywu1234/smartflow`.

## What it does

- Accepts one canonical Markdown task file per MCP session.
- Requires the Host to show the complete task file and obtain explicit confirmation before execution.
- Creates an immutable Job with a TaskManifest and exact task source.
- Runs Pi in an isolated Git workspace with a rolling attempt deadline.
- Keeps execution, review, repair, cancellation, recovery, and publish transitions inside the Daemon.
- Supports Codex and Claude Code reviewer adapters.
- Uses structured JSON logging through `@smartflow/observability`.
- Stores durable state in SQLite and protects writes with leases, fences, and atomic updates.

The original project is changed only by the Publish stage. The Worker can read, search, edit, write, and run shell commands inside its isolated workspace; the source project and the MCP session task directory are excluded from that workspace.

## Requirements

- Node.js 22.19.0 or newer
- pnpm 10.14.0 or newer for development
- A model endpoint and credential for the Pi Worker
- A local `codex` or `claude` executable when Review is enabled

## Install

When the package is available from npm:

```sh
npm install --global @jerrywu1234/smartflow
smartflow doctor --json
```

To run from a checkout:

```sh
git clone https://github.com/JerryWu1234/AI-smart-flow.git
cd AI-smart-flow
pnpm install
pnpm build
node dist/smartflow.mjs doctor --json
```

Use `pnpm clean:daemon-data` to remove local development Daemon data when you intentionally reset a project run directory.

## Configuration

The Worker reads its configuration from environment variables. `WORK_BASE_URL`, `WORK_MODEL`, and `WORK_API_KEY` are required.

| Variable | Default | Description |
| --- | --- | --- |
| `WORK_API` | `openai-responses` | API format: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai` |
| `WORK_BASE_URL` | — | Model endpoint base URL |
| `WORK_MODEL` | — | Model identifier |
| `WORK_API_KEY` | — | Model credential |
| `WORK_CONTEXT_WINDOW` | `1000000` | Context window size |
| `WORK_MAX_TOKENS` | `384000` | Maximum output tokens; cannot exceed the context window |
| `WORK_EFFORT` | `high` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `WORK_ATTEMPT_DEADLINE_MS` | `300000` | Rolling Worker deadline; minimum `60000` |

Review is enabled unless `REVIEW_ENABLED=false`.

| Variable | Default | Description |
| --- | --- | --- |
| `REVIEW_ENABLED` | enabled | Set to `false` to publish the Worker Candidate directly |
| `REVIEW_ADAPTER` | `codex` | `codex`, `codex-desktop`, `claude-code`, or `claude-code-desktop` |
| `REVIEW_MODEL` | adapter default | Model passed to the selected reviewer |
| `REVIEW_EFFORT` | adapter default | Reasoning effort passed to the selected reviewer |

The Daemon reads Review settings at startup. Restart it after changing any `REVIEW_*` variable. The selected reviewer CLI must be installed and authenticated in the Daemon environment.

## CLI commands

```text
smartflow doctor [--json] [--project PATH]
smartflow daemon [--data-dir PATH]
smartflow mcp [--data-dir PATH]
smartflow health [--data-dir PATH]
smartflow version
```

`doctor` checks configuration, the data directory, the execution sandbox, the Pi provider, and the optional publish adapter. `daemon` starts the local service. `mcp` starts the stdio MCP server and launches or connects to the Daemon. `health` reads the Daemon health response.

## MCP setup

SmartFlow uses a stdio MCP server. Add an entry like this to your MCP Host configuration:

```json
{
  "mcpServers": {
    "smartflow": {
      "command": "smartflow",
      "args": ["mcp"],
      "env": {
        "WORK_BASE_URL": "https://api.example.com/v1",
        "WORK_MODEL": "your-model",
        "WORK_API_KEY": "your-api-key",
        "REVIEW_ADAPTER": "codex"
      }
    }
  }
}
```

For a checkout, replace `command` and `args` with an absolute Node.js entry point, for example:

```json
{
  "command": "node",
  "args": ["/absolute/path/AI-smart-flow/dist/smartflow.mjs", "mcp"]
}
```

Keep credentials in the Host environment or a secret manager. Do not commit them to task files or repository configuration.

## Task file format

Each MCP session exposes one canonical path:

```text
<projectRoot>/.smartflow/tasks/<sessionId>/tasks.md
```

A task document uses Markdown module headings, unique task IDs, an optional module tag, at least one backtick-wrapped target path, and an explicit `Acceptance:` criterion:

```md
# Tasks

## M01 User authentication

- [ ] T001 [M01] Implement login validation in `src/auth/login.ts` — Acceptance: valid users can log in and invalid passwords return an explicit error
- [ ] T002 [M01] Add login coverage in `src/auth/login.test.ts` — Acceptance: success and failure cases pass
```

The Host should re-read the file from disk, show its complete contents, and ask for confirmation. The initial request to implement something authorizes task preparation; only an explicit confirmation authorizes `smartflow_execute({})`.

## MCP workflow

1. Prepare or normalize the requested work into the session task file.
2. Show the path and complete contents to the user and receive confirmation.
3. Call `smartflow_execute({})` once.
4. Poll `smartflow_review_turn` with a new request ID until it returns `DONE`.
5. On `NOT_READY`, wait for `retryAfterMs` and poll again.
6. On `USER_INPUT_REQUIRED`, present the pause message and submit one listed answer with the unchanged `turnToken`.
7. Use `smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` for explicit inspection, recovery, cancellation, and result retrieval.

The public MCP surface exposes six tools:

- `smartflow_execute`
- `smartflow_review_turn`
- `smartflow_status`
- `smartflow_resume`
- `smartflow_cancel`
- `smartflow_result`

The Daemon owns durable state transitions, review decisions, repair scheduling, deadlines, and publish scheduling. A Job is immutable: changing the task source or Worker configuration requires a new Job.

## Logging and data

All application logs use `StructuredLogger` and are emitted as redacted JSON records to stderr. SmartFlow does not create a separate daemon log file. Daemon state and run artifacts live below the configured SmartFlow data directory, outside the source project.

The `.smartflow/tasks/**` directory is control-plane data. It is excluded from run baselines, candidates, and publish operations. Each run keeps immutable task and manifest artifacts under `projects/<projectId>/runs/<jobId>/`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:security
pnpm test:crash
pnpm test:e2e
pnpm test:provider:pi
pnpm test:installed
```

Workspace packages are private and bundled into the root CLI package. Published CLI changes use Changesets; see `RELEASING.md` for the release flow.

## License

MIT
