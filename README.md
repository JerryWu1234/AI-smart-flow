# SmartFlow

```sh
npm install --global @jerrywu1234/smartflow
smartflow doctor --json
```

SmartFlow runs `@earendil-works/pi-coding-agent` in an isolated per-Run Git workspace. Pi uses its official read, search, edit, write and Shell tools directly; SmartFlow does not provide a custom file Broker or pass its MCP/Host Skills into Pi.

Shell commands and network access are allowed inside the sandbox. Project and user data are readable and writable only through the isolated workspace; Node, system and Pi SDK bootstrap paths are read-only. The original project is changed only by the reviewed Publish stage.

Each Revision has a durable Pi Attempt/session. A live Host reconnect keeps that session; a stopped process, Daemon crash or new Revision starts a new session after containment reconciliation. Attempt deadlines pause without automatic replacement, and cancellation must prove the full process tree is gone.

Each MCP server instance binds one model directly from `SMARTFLOW_PI_API`, `SMARTFLOW_PI_BASE_URL`, `SMARTFLOW_PI_MODEL` and `SMARTFLOW_PI_API_KEY`. Supported APIs are `openai-completions`, `openai-responses`, `anthropic-messages` and `google-generative-ai`. Optional context, output, thinking and Attempt deadline fields default to `1000000`, `384000`, `high` and `1800000ms`. SmartFlow registers the model in memory through a bundled Pi Extension and does not use `models.json`.

Run `smartflow doctor --json` to verify Node, Pi, sandbox, model registration, signing and publish capabilities.

## MCP workflow

The public MCP surface contains exactly six tools. The only public Review orchestration path is to call `smartflow_execute` once for an approved task source and then call `smartflow_review_turn` until it returns `DONE`. The turn API returns one of four states:

- `NOT_READY`: wait for `retryAfterMs` and call it again.
- `REVIEW_REQUIRED`: create or resume the specified independent Reviewer session in `worktreePath`, then return every task's completion score with the unchanged `turnToken`.
- `USER_INPUT_REQUIRED`: present the message and available actions to the user, then return the selected action with the unchanged `turnToken`.
- `DONE`: the run reached a terminal result.

`smartflow_status`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result` are separate APIs for Run inspection, paused-Run recovery, cancellation, and result management; they are not Review continuations or a second Review orchestration path. While an active `hostTurn` owns `USER_INPUT_REQUIRED`, the owning Host must submit the answer through `smartflow_review_turn` with the same `turnToken`; the public `smartflow_resume` API cannot answer or bypass that checkpoint.

Waiting, atomic Review begin/finalize, automatic decisions, and repair/publish progression are Daemon-owned mechanics. The old claim/renew bridge is removed: the `HostActionLoop` symbol and public symbols, schemas, handlers, registrations, and aliases for `smartflow_wait`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, and `smartflow_submit_leader_decision` do not exist.