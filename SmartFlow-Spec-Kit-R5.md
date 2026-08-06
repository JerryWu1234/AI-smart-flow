# SmartFlow Current Design Index

> 文件名为历史兼容名称；本文只描述 2026-08-05 起的 SmartFlow 4.0 Pi Worker 主线。SmartFlow 运行时不得依赖本文或 Spec Kit。

| 项目 | 当前决定 |
|---|---|
| 产品范围 | 本地后台 Pi Worker + 独立 Review + Leader repair + 安全 Publish |
| 唯一 Leader | 当前用户会话中的 Host 强模型 |
| 任务输入 | 纯 Markdown `tasks.md` |
| Run 并发键 | 任务文件规范化绝对路径；同路径一个 Active Run |
| Workspace | Run-scoped Git objects + Revision-scoped isolated directory |
| Worker | `@earendil-works/pi-coding-agent` SDK，唯一且不 fallback |
| 模型配置 | MCP server 环境唯一来源；每个实例一个 API endpoint/模型；Pi Extension 内存注册；无 `models.json` |
| 工具 | Pi 官方 read/bash/edit/write/grep/find/ls；无 SmartFlow Broker |
| 安全边界 | Pi 整个进程树只能访问当前 isolated workspace 的项目数据；Shell/网络允许 |
| MCP/Skills | MCP 和用户交互仅在 Host；Pi 不接 SmartFlow MCP，不动态注入 Host/global Skills |
| Review | Host 首轮创建、后续恢复同一 Reviewer session |
| 最终决策 | Leader `accept | repair | pause` |
| 自动写回 | 项目级串行 + conflict-checked batch adapter |
| 运行时 Spec Kit 依赖 | 无 |

## Documentation Map

| 文档 | 用途 |
|---|---|
| [Constitution](.specify/memory/constitution.md) | 不可违背的产品与安全原则 |
| [Feature Specification](specs/001-smartflow-mvp/spec.md) | 用户场景、功能要求和成功标准 |
| [Implementation Plan](specs/001-smartflow-mvp/plan.md) | Pi 架构、Sandbox、状态、迁移与测试计划 |
| [Pi Worker Contract](specs/001-smartflow-mvp/contracts/pi-worker.md) | SDK、官方工具、进程隔离、MCP/Skill 与 session 边界 |
| [Git Workspace Contract](specs/001-smartflow-mvp/contracts/git-workspace.md) | Git Snapshot、Candidate 与发布预检 |
| [Run Concurrency Contract](specs/001-smartflow-mvp/contracts/run-concurrency.md) | task path、多 Run、Pi session 与串行 Publish |
| [Reviewer Loop Checklist](specs/001-smartflow-mvp/reviewer-loop-tasks.md) | Reviewer session 复用与 Leader repair |
| [Implementation Tasks](specs/001-smartflow-mvp/tasks.md) | 当前 4.0 实施清单 |

冲突顺序：

```text
Constitution → Feature Specification → Implementation Plan → Contracts → Tasks → implementation
```

运行时业务任务只来自用户批准的 Task Revision；设计文档不构成隐藏任务。

## Current Flow

```text
Leader freezes tasks.md
→ Daemon creates isolated Git workspace
→ Sandbox launches Pi Coding Agent SDK child
→ Pi directly edits workspace with official tools
→ Candidate + Review Action
→ Host binds independent Reviewer
→ Review returns to Leader
   ├─ accept → Publish
   ├─ repair → new Revision + new Pi session → same Reviewer
   └─ pause
```

SmartFlow 不新增通用 verify/gate 阶段；Pi 可以在 isolated workspace 内按 Task 需要运行 test、lint、build 或其他 Shell 命令。

## Task and Pi Configuration Boundary

`tasks.md` 只表达业务任务、稳定 Task ID、目标路径和验收条件。Provider、模型、凭据、Sandbox 与运行参数不得写入任务正文。

SmartFlow MCP server 环境配置提供 Pi 模型、endpoint、凭据和资源参数。每个 Revision 冻结 `providerRuntimeConfigHash`；配置漂移时暂停或失败，不切换 API/模型。

具体配置只来自 MCP server 进程环境：`SMARTFLOW_PI_API`、`SMARTFLOW_PI_BASE_URL`、`SMARTFLOW_PI_MODEL`、`SMARTFLOW_PI_API_KEY`。API 只接受 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI 对应的 Pi 标准标识。每个 MCP 实例只绑定一个模型；context/max output/thinking/deadline 默认 `1000000/384000/high/1800000ms` 并允许同一 MCP 配置覆盖。

Pi child 加载随 SmartFlow 发布的静态 Extension，通过官方 `pi.registerProvider()` 直接在内存中注册该模型。SmartFlow 不生成或读取 `models.json`，不读取宿主用户 Pi 配置，不在 argv、状态、session、Artifact 或日志中保存 API Key。

Worker Provider 固定为 Pi Coding Agent SDK。SmartFlow 不直接使用 Agent Core 重建 coding tools，也不保留 OpenCode、Claude Agent SDK 或 Broker fallback。

## Pi Worker and Safety Boundary

- Daemon 通过 `ExecutionSandboxAdapter` 启动 Pi SDK child；SDK Agent loop 不在 Daemon 进程内运行。
- Parent/child 使用 SDK JSONL RPC；Daemon只归一化事件和管理生命周期。
- Pi 直接使用官方 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- Pi 可修改当前 isolated workspace 内任意项目文件，可执行任意 Shell/子进程并访问网络。
- Pi 不能访问原始项目、SmartFlow 状态、其他 Run workspace 或宿主用户数据；所需 Node/系统库/Pi SDK 仅只读 bootstrap。
- Pi 内部可知道 cwd，但 MCP/API/UI/日志/Finalize Artifact 只暴露逻辑 ID、项目相对路径或受控 Artifact，不暴露内部绝对路径。
- `.smartflow-runtime/` 在 Candidate 前清理或排除。
- Publish 是唯一允许写回原始项目的路径。

ToolExecutionBroker、workspace dispatcher、effectId/effectHash/receipt、Worker 工具审批和 `smartflow_submit_tool_decision` 全部移除。

## MCP, Skills and Interaction

Host/Leader 保留 SmartFlow MCP、Reviewer orchestration 和全部用户交互。Pi Worker 不接收 SmartFlow MCP，也不能等待用户回答。

本次迁移不动态传入 Host/global Skills。Pi 可以按官方 ResourceLoader 规则使用 already-present workspace-local resources，但 user/global discovery 必须限制到 Run-local agent directory，不能读宿主 Skill 目录。

## Session and Recovery

| 场景 | 结果 |
|---|---|
| Host 重连且 Daemon/Pi 存活 | 继续同 job、Attempt、Pi session |
| Pi/Daemon 崩溃 | 相同 job/Revision/workspace，新 Attempt/Pi session |
| Attempt 超时 | 终止完整进程树，持久化 `TIMED_OUT`，等待 Leader 恢复决定 |
| 同一 Task repair 新 Revision | 上一 Result Tree 物化，新 Pi session |
| 独立新功能 | Leader 创建新 Task/Run/Pi session |
| Cancel | 终止完整 containment process tree 后落终态 |

Leader 判断用户消息是否仍属于同一 Task。恢复事实来自 `state.json`、Task Artifact、Revision Snapshot 和 Review history，不依赖旧 Pi session 必然存在。

## Review and Publish

Reviewer 与 Leader、所有 Pi Worker session 分离。首轮创建 Reviewer session，repair 后恢复同一 Reviewer；每轮审查最新完整 Result Workspace 和累计 Candidate。

只有 `APPROVE + FULL + no blocker` 且 Leader accept 才能 Publish。Publish 使用项目级串行临界区、expected-old-hash、稳定 operationId、结果查询和受支持 batch mode。冲突全部路径零写入并返回 `0/N` 与 DeliveryBundle；PARTIAL/UNKNOWN 进入 `PUBLISH_RECOVERY_BLOCKED`。

SmartFlow 不自动 commit、push、merge、reset、clean、checkout、回滚或删除用户改动。

## Migration Note

4.0 是不兼容运行状态升级：

- 删除 `packages/execution-broker`、`packages/provider-opencode`、`packages/provider-claude-agent` 及相关 tests/dependencies/build entries；
- 删除 `brokerSession`、`effectExecutions`、`managedProcesses`、`workerBlock` 和 tool-decision 协议；
- 新增 PiWorkerAttempt、Pi session Artifact 与 Sandbox containment identity；
- 旧 Active Run 不原地转换成 Pi session，也不得继续 Publish；旧终态 Artifact 只可保留为审计历史。

## Explicitly Out of Scope

- 自建 coding tools/Broker 或双 Provider compatibility path；
- 动态向 Pi 注入 SmartFlow MCP、Host/global Skills；
- 独立通用 verify/gate 阶段；
- 第二个 Leader、Worker 自审或 Reviewer/Pi 直接与用户交互；
- 自动 Git commit/push/PR、自动 merge、路径预占或并行 Publish；
- Linux/Windows Sandbox adapter、分布式调度、外部数据库和 GUI 管理后台。
