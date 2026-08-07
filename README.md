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
