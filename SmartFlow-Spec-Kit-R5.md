# SmartFlow Current Design Index

> 文件名为历史兼容名称；本文描述 2026-08-11 起的 SmartFlow 4.1 方案 D 主线。SmartFlow 运行时不得依赖本文或 Spec Kit。

| 项目 | 当前决定 |
|---|---|
| 产品范围 | 本地后台 Pi Worker + 独立 Reviewer + Daemon 机械编排 + 安全 Publish |
| 唯一用户 Leader | 当前用户会话中的 Host 强模型；独占用户交互与 Reviewer 执行 |
| 机械编排 | Daemon 确定性 wait/claim/renew/accept/repair/pause/Publish，不创建 Reviewer |
| 首选 Host API | `smartflow_execute → smartflow_review_turn` |
| Review turn 四态 | `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE` |
| MCP surface | 恰好 11 个工具；复合 turn 首选，旧 10 primitive 兼容保留 |
| 任务输入 | 纯 Markdown `tasks.md`，按 Revision 冻结 |
| Run 并发键 | 任务文件规范化绝对路径；同路径一个 Active Run |
| Workspace | Run-scoped Git objects + Revision-scoped isolated directory |
| Worker | `@earendil-works/pi-coding-agent` SDK，唯一且不 fallback |
| 模型配置 | MCP server 环境唯一来源；每实例一个 endpoint/模型；Pi Extension 内存注册；无 `models.json` |
| 工具 | Pi 官方 read/bash/edit/write/grep/find/ls；无 SmartFlow Broker |
| 安全边界 | Pi 进程树只能访问当前 isolated workspace 的项目数据；Shell/网络允许 |
| Review | Host 首轮 CREATE、后续 RESUME 同一 Reviewer；Daemon claim 后才暴露 worktree |
| 状态恢复 | schema-v4 durable Host turn + per-Run serialization + Project-wide CAS |
| 自动修复 | 每组最多 15 轮；用户通过 `resume_review_decision` 授予下一组 |
| 自动写回 | 仅 100% 有效 Review 后；项目级串行 + conflict-checked batch adapter |
| 运行时 Spec Kit 依赖 | 无 |

## Documentation Map

| 文档 | 用途 |
|---|---|
| [Constitution](.specify/memory/constitution.md) | 不可违背的产品、安全、Host/Daemon 权限原则 |
| [Feature Specification](specs/001-smartflow-mvp/spec.md) | 用户场景、FR-042–FR-051 与 SC-016–SC-020 |
| [Implementation Plan](specs/001-smartflow-mvp/plan.md) | Pi 架构、复合 turn、状态、恢复与测试计划 |
| [Daemon Review Turn ADR](specs/001-smartflow-mvp/adr-daemon-owned-review-turn.md) | 方案 D 决策与取舍 |
| [Composite Review Turn Contract](specs/001-smartflow-mvp/contracts/review-turn.md) | 四态、checkpoint、CAS、deadline、11 工具 |
| [Pi Worker Contract](specs/001-smartflow-mvp/contracts/pi-worker.md) | SDK、官方工具、进程隔离、模型与 session 边界 |
| [Git Workspace Contract](specs/001-smartflow-mvp/contracts/git-workspace.md) | Git Snapshot、Candidate 与发布预检 |
| [Run Concurrency Contract](specs/001-smartflow-mvp/contracts/run-concurrency.md) | per-Run queue、Project CAS、Host/Pi session 与恢复 |
| [Reviewer Loop Checklist](specs/001-smartflow-mvp/reviewer-loop-tasks.md) | Reviewer session 复用与 Daemon 自动决策 |
| [Implementation Map](specs/001-smartflow-mvp/implementation-map.md) | 需求→任务→代码→测试/证据追踪 |
| [Implementation Tasks](specs/001-smartflow-mvp/tasks.md) | 4.1 Phase 12 与未关闭真实 Pi 证据项 |

冲突顺序：

```text
Constitution → Feature Specification → Current ADR → Implementation Plan
→ Contracts → Tasks → Implementation Map → implementation
```

历史 ADR 只记录演进，不覆盖 current ADR。运行时业务任务只来自用户批准的 Task Revision；设计文档不构成隐藏任务。

## Current Flow

```text
Host freezes tasks.md
→ smartflow_execute
→ Daemon runs Pi in isolated Git workspace
→ Candidate + Review Action
→ smartflow_review_turn
   ├─ NOT_READY → bounded poll
   ├─ REVIEW_REQUIRED → Host CREATE/RESUME independent Reviewer
   │                    → submit same turnToken
   │                    → Daemon automatically:
   │                       ├─ 100% valid → accept → Publish
   │                       ├─ actionable incomplete + budget → repair Revision
   │                       ├─ invalid/no guidance → USER_INPUT_REQUIRED
   │                       └─ 15 rounds reached → USER_INPUT_REQUIRED
   ├─ USER_INPUT_REQUIRED → Host asks user and submits typed answer
   └─ DONE → terminal canonical result
```

`NOT_READY`、stale continuation、用户暂停和终态不暴露 worktree path；只有已 durable claim 的 `REVIEW_REQUIRED` 可以向 owning Host 暴露。

## Host, Daemon, Reviewer, and Worker Boundary

- **Host/Leader**：批准 Task 意图；持有 SmartFlow MCP；创建/恢复 Reviewer；与用户交互。
- **Daemon**：Run 状态机、Pi 生命周期、Review claim/renew、确定性 Review decision、repair budget、恢复和 Publish。它不创建 Reviewer、不解释开放式用户意图。
- **Reviewer**：独立于 Host 与 Pi，重读同步 Task 和最新完整结果，逐 Task 评分并覆盖 cumulative changed paths。
- **Pi Worker**：只实现当前 Revision；不接 SmartFlow MCP，不等待用户，不参与 Review。

Host-only interaction 与 Daemon-owned mechanics 不矛盾：机械策略已由规范冻结，只有 Reviewer 执行和用户选择需要 Host 能力。

## Composite Review Turn and Durable State

公开输出恰好四态；内部 schema-v4 checkpoint 恰好三阶段：

```text
CLAIMING → AWAITING_REVIEW
                    ↓
             AWAITING_USER_INPUT
```

每个 checkpoint 绑定 `hostTurnId + turnToken + revision`。同一 Run 的 composite turn 串行；每次 mutation 走 Project-wide `stateVersion` CAS，稳定 child request ID 使重试幂等。Review deadline 为 30 分钟；每 60 秒或 lease 到期前 30 秒续租，1 秒失败重试，连续三次失败 durable pause；每个 CAS operation 总计最多尝试四次（含首次，最多三次重试）。

Daemon 重启时先由 Host-turn coordinator 恢复 durable checkpoint，再重读 fresh state。只要 `hostTurn` 存在，legacy pipeline recovery 不得并行推进该 Run。

## Automatic Review Decision

| 当前有效 Review | Daemon 计划 |
|---|---|
| `APPROVE` + 100% + no blockers | `ACCEPT` → Publish |
| 有 actionable blockers 且当前组 `< 15` | `REPAIR`，只引用 current finding fingerprints |
| 不完整但无 actionable blockers | `PAUSE_INVALID_REVIEW`；仅 cancel |
| 当前组已达 15 | `PAUSE_REPAIR_LIMIT`；等待用户是否继续下一组 |

Host 不重复提交这些机械决策。每个 repair 使用新 Revision/new Pi session，但复用 bound Reviewer。`resume_review_decision` 重置 `autoRepairRounds` 并授予下一组最多 15 轮。

## Task and Pi Configuration Boundary

`tasks.md` 只表达业务任务、稳定 Task ID、目标路径和验收条件。Provider、模型、凭据、Sandbox 与运行参数不得写入任务正文。

SmartFlow MCP server 环境提供 `SMARTFLOW_PI_API`、`SMARTFLOW_PI_BASE_URL`、`SMARTFLOW_PI_MODEL`、`SMARTFLOW_PI_API_KEY`；每个 Revision 冻结非敏感 `providerRuntimeConfigHash`。支持四种标准协议，context/max output/thinking/deadline 默认 `1000000/384000/high/1800000ms`。

Pi child 加载静态 Extension，通过官方 `pi.registerProvider()` 在内存中注册唯一模型。SmartFlow 不生成/读取 `models.json`，不读取宿主用户 Pi 配置，不在 argv、状态、session、Artifact 或日志中保存 API Key。

## Pi Worker and Safety Boundary

- Daemon 通过 `ExecutionSandboxAdapter` 启动 Pi SDK child；Agent loop 不在 Daemon 进程运行。
- Parent/child 使用 SDK JSONL RPC；Daemon 只归一化事件和管理生命周期。
- Pi 直接使用官方 coding tools，可在当前 workspace 修改项目文件、执行 Shell/子进程并访问网络。
- 原始项目、SmartFlow 状态、其他 Run workspace 和宿主用户数据不可访问；必要 bootstrap 只读。
- `.smartflow-runtime/` 在 Candidate 前清理/排除；Publish 是唯一原项目写入路径。
- ToolExecutionBroker、effects、Worker 工具审批和 `smartflow_submit_tool_decision` 已移除。

## Session and Recovery

| 场景 | 结果 |
|---|---|
| Host 重连且 Daemon/Pi 存活 | 继续同 job、Attempt、Pi session |
| Daemon 在 active Host turn 重启 | 恢复同 token/claim/pause；不并发 legacy recovery |
| Pi/Daemon Worker 崩溃 | 相同 job/Revision/workspace，新 Attempt/Pi session |
| Attempt 超时 | 终止进程树，持久化 `TIMED_OUT`，等待允许的恢复 |
| 自动 repair Revision | 上一 Result Tree 物化，新 Pi session，同一 Reviewer |
| 独立新功能 | Host 根据用户意图创建新 Task/Run |
| Cancel | 完整 containment 对账后落终态 |

## Publish and Evidence Boundary

只有 100% 有效 Review 才能自动 accept/Publish。Publish 使用项目级串行、expected-old-hash、稳定 operationId 和支持的 batch mode；冲突全路径零写入并返回 `0/N` 与 DeliveryBundle；PARTIAL/UNKNOWN durable block。

Production-composition 的覆盖场景已验证复合编排，但当前实现仍有两个明确开放任务：T204（paused Host ownership 与 lost-claim lease wake）和 T205（Reviewer callback 的 `changedPaths` 与 self-contained pause/no primitive result fallback）。因此严格的全状态两工具闭环尚未完成，详见 implementation map。

即使 T204/T205 完成，production-composition 也不等于真实 installed Pi SDK/model 兼容。Mocked `registerProvider` 和 gitignored `.smartflow-e2e` transcript 不是可审计 real-model 证据；T190/T208 与 T192/T209 保持开放。

## Explicitly Out of Scope

- 自建 coding tools/Broker 或双 Provider compatibility path；
- Daemon 创建/替换 Reviewer，或 Reviewer/Pi 直接与用户交互；
- 删除旧 10 个 primitive MCP 工具；
- 动态向 Pi 注入 SmartFlow MCP、Host/global Skills；
- 独立通用 verify/gate 阶段；
- 自动 Git commit/push/PR、自动 merge、路径预占或并行 Publish；
- Linux/Windows Sandbox adapter、分布式调度、外部数据库和 GUI 管理后台。
