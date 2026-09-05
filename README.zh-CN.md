# SmartFlow 中文文档

[English documentation](README.md)

SmartFlow 是一个基于 MCP 的代码执行工作流。它把经过确认的任务文件转换为一次隔离、可审查的实现任务：在独立的 Git 工作区中运行 Pi coding agent，将状态持久化到 SQLite，可选地运行 Reviewer，执行范围内的自动返修，并在结果经过校验后发布改动。

> SmartFlow 目前仍处于早期阶段。公开包名称为 `@jerrywu1234/smartflow`。

## 项目能力

- 每个 MCP 会话使用一份规范化的 Markdown 任务文件。
- 执行前必须向用户展示完整任务文件并取得明确确认。
- 每次执行创建一个绑定 TaskManifest 和原始任务内容的不可变 Job。
- 在隔离的 Git 工作区中运行 Pi，并使用滚动执行时限。
- 由 Daemon 统一负责执行、Review、返修、取消、恢复和发布状态流转。
- 支持 Codex 和 Claude Code Reviewer 适配器。
- 通过 `@smartflow/observability` 统一输出结构化 JSON 日志。
- 使用 SQLite 持久化状态，并通过租约、fence 和原子更新保护写入。

原始项目只会在 Publish 阶段被修改。Worker 可以在隔离工作区内读取、搜索、编辑、写入文件并执行 Shell 命令；源项目和 MCP 会话任务目录不会进入该工作区。

## 环境要求

- Node.js 22.19.0 或更高版本
- 开发时使用 pnpm 10.14.0 或更高版本
- Pi Worker 所需的模型端点和凭据
- 开启 Review 时，需要在 Daemon 环境中安装并完成认证的 `codex` 或 `claude` 命令

## 安装

当 npm 包可用时：

```sh
npm install --global @jerrywu1234/smartflow
smartflow doctor --json
```

从源码运行：

```sh
git clone https://github.com/JerryWu1234/AI-smart-flow.git
cd AI-smart-flow
pnpm install
pnpm build
node dist/smartflow.mjs doctor --json
```

如果需要重置本地开发数据，可以执行 `pnpm clean:daemon-data` 删除本地 Daemon 数据和项目运行目录。

## 配置

Worker 使用环境变量配置，`WORK_BASE_URL`、`WORK_MODEL` 和 `WORK_API_KEY` 为必填项。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WORK_API` | `openai-responses` | API 格式：`openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai` |
| `WORK_BASE_URL` | — | 模型端点基础 URL |
| `WORK_MODEL` | — | 模型标识 |
| `WORK_API_KEY` | — | 模型凭据 |
| `WORK_CONTEXT_WINDOW` | `1000000` | 上下文窗口大小 |
| `WORK_MAX_TOKENS` | `384000` | 最大输出 token 数，不能超过上下文窗口 |
| `WORK_EFFORT` | `high` | 可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `WORK_ATTEMPT_DEADLINE_MS` | `300000` | Worker 滚动执行时限，最小值为 `60000` |

除非设置 `REVIEW_ENABLED=false`，否则默认开启 Review。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REVIEW_ENABLED` | 开启 | 设置为 `false` 后直接发布 Worker Candidate |
| `REVIEW_ADAPTER` | `codex` | `codex`、`codex-desktop`、`claude-code` 或 `claude-code-desktop` |
| `REVIEW_MODEL` | 适配器默认值 | 传给 Reviewer 的模型 |
| `REVIEW_EFFORT` | 适配器默认值 | 传给 Reviewer 的推理强度 |

Daemon 只在启动时读取 Review 配置。修改 `REVIEW_*` 后请重启 Daemon。选中的 Reviewer 命令必须在 Daemon 环境中安装并完成认证。

## CLI 命令

```text
smartflow doctor [--json] [--project PATH]
smartflow daemon [--data-dir PATH]
smartflow mcp [--data-dir PATH]
smartflow health [--data-dir PATH]
smartflow version
```

`doctor` 检查配置、数据目录、执行沙箱、Pi Provider 和可选的发布适配器。`daemon` 启动本地服务。`mcp` 启动 stdio MCP Server，并启动或连接 Daemon。`health` 读取 Daemon 健康状态。

## MCP 配置

SmartFlow 使用 stdio MCP Server。在 MCP Host 配置中加入类似内容：

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

从源码运行时，可把 `command` 和 `args` 换成绝对路径的 Node.js 入口，例如：

```json
{
  "command": "node",
  "args": ["/absolute/path/AI-smart-flow/dist/smartflow.mjs", "mcp"]
}
```

请将凭据放在 Host 环境变量或 Secret Manager 中，不要提交到任务文件或仓库配置。

## 任务文件格式

每个 MCP 会话都会暴露一条规范路径：

```text
<projectRoot>/.smartflow/tasks/<sessionId>/tasks.md
```

任务文件使用 Markdown 模块标题、唯一任务 ID、可选模块标签、至少一个用反引号包裹的目标路径，以及明确的 `Acceptance:` 验收条件：

```md
# Tasks

## M01 User authentication

- [ ] T001 [M01] Implement login validation in `src/auth/login.ts` — Acceptance: valid users can log in and invalid passwords return an explicit error
- [ ] T002 [M01] Add login coverage in `src/auth/login.test.ts` — Acceptance: success and failure cases pass
```

Host 应从磁盘重新读取文件，向用户展示路径和完整内容，并请求确认。用户最初提出实现需求只代表允许准备任务草稿；只有明确确认后才能调用 `smartflow_execute({})`。

## MCP 工作流

1. 把用户请求准备或规范化为会话任务文件。
2. 向用户展示路径和完整内容并取得确认。
3. 调用一次 `smartflow_execute({})`。
4. 使用新的请求 ID 轮询 `smartflow_review_turn`，直到返回 `DONE`。
5. 返回 `NOT_READY` 时等待 `retryAfterMs` 后再次轮询。
6. 返回 `USER_INPUT_REQUIRED` 时展示暂停消息，并使用不变的 `turnToken` 提交一个可选答案。
7. 使用 `smartflow_status`、`smartflow_resume`、`smartflow_cancel` 和 `smartflow_result` 进行查看、恢复、取消和读取结果。

公开 MCP 接口提供六个工具：

- `smartflow_execute`
- `smartflow_review_turn`
- `smartflow_status`
- `smartflow_resume`
- `smartflow_cancel`
- `smartflow_result`

Daemon 负责持久状态流转、Review 决策、返修调度、时限和发布调度。Job 不可变；任务内容或 Worker 配置变化时，需要创建新的 Job。

## 日志和数据

所有应用日志都通过 `StructuredLogger` 生成，并以脱敏后的 JSON 记录输出到 stderr。SmartFlow 不创建独立的 Daemon 日志文件。Daemon 状态和运行产物位于 SmartFlow 数据目录下，与源项目分离。

`.smartflow/tasks/**` 属于控制面数据，不会进入运行基线、Candidate 或 Publish。每个运行会在配置的数据目录下保存不可变任务和 manifest 产物，路径形如 `projects/<projectId>/runs/<jobId>/`。

## 开发

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

各 `apps/*` 和 `packages/*` workspace 包为私有包，最终会打包到根 CLI 包中。发布 CLI 改动时使用 Changesets，发布流程见 `RELEASING.md`。

## 许可证

MIT
