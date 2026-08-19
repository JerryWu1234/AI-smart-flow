# SmartFlow Current Design Index

> 文件名沿用历史名称；本文描述 2026-08-11 起的 SmartFlow 方案 D 主线。SmartFlow 运行时不得依赖本文或 Spec Kit。

| 项目 | 当前决定 |
|---|---|
| 产品范围 | 本地后台 Pi Worker + 独立 Reviewer + Daemon 机械编排 + 安全 Publish |
| 唯一用户 Leader | 当前用户会话中的 Host 强模型；独占用户交互与 Reviewer 执行 |
| 机械编排 | Daemon 内部执行 bounded poll、原子 Review begin/finalize、自动 decision、repair 与 Publish progression，不创建 Reviewer |
| 唯一公开 Review 编排路径 | `smartflow_execute → smartflow_review_turn*` |
| Review turn 四态 | `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE` |
| MCP surface | 恰好 6 个工具；2 个 Review 编排工具 + 4 个独立 Run 管理 API |
| 任务输入 | 纯 Markdown `tasks.md`，按 Revision 冻结 |
| Run 并发键 | 任务文件规范化绝对路径；同路径一个 Active Run |
| Workspace | Run-scoped Git objects + Revision-scoped isolated directory |
| Worker | `@earendil-works/pi-coding-agent` SDK，唯一且不 fallback |
| 模型配置 | MCP server 环境唯一来源；每实例一个 endpoint/模型；Pi Extension 内存注册；无 `models.json` |
| 工具 | Pi 官方 read/bash/edit/write/grep/find/ls；无 SmartFlow Broker |
| 安全边界 | Pi 进程树只能访问当前 isolated workspace 的项目数据；Shell/网络允许 |
| Review | Host 首轮 CREATE、后续 RESUME 同一 Reviewer；`review.result` 仅使用 ReviewResult；原子持久化 `AWAITING_REVIEW` 后才暴露 worktree |
| 状态恢复 | Run-state schema-v6 durable Host turn + legacy migration + Project-wide CAS；与 Review/Leader artifact v2 分属不同版本轴 |
| 自动修复 | 合法且不完整时自动处理全部 Issues；每组最多 15 轮，用户通过 `smartflow_review_turn` 的结构化 answer 授予下一组 |
| 自动写回 | 仅合法 ReviewResult 的每个 Task 均为 100% 后；项目级串行 + conflict-checked batch adapter |
| 运行时 Spec Kit 依赖 | 无 |

## Documentation Map

| 文档 | 用途 |
|---|---|
| [Constitution](.specify/memory/constitution.md) | 不可违背的产品、安全、Host/Daemon 权限原则 |
| [Feature Specification](specs/001-smartflow-mvp/spec.md) | 用户场景、FR-042–FR-051 与 SC-016–SC-020 |
| [Implementation Plan](specs/001-smartflow-mvp/plan.md) | Pi 架构、复合 turn、状态、恢复与测试计划 |
| [Daemon Review Turn ADR](specs/001-smartflow-mvp/adr-daemon-owned-review-turn.md) | 方案 D 决策与取舍 |
| [Composite Review Turn Contract](specs/001-smartflow-mvp/contracts/review-turn.md) | 四态、checkpoint、CAS、deadline、六工具边界 |
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
   │                    → submit same turnToken + reviewerSessionId + ReviewResult
   │                    → Daemon validates before any artifact/state write:
   │                       ├─ illegal payload → reject; Run/checkpoint unchanged
   │                       └─ valid payload → mechanical plan:
   │                          ├─ every Task 100% → ACCEPT → Publish
   │                          ├─ incomplete + rounds < 15 → REPAIR all Issues
   │                          └─ incomplete + rounds >= 15 → PAUSE_REPAIR_LIMIT
   ├─ USER_INPUT_REQUIRED → Host asks user and submits typed answer
   └─ DONE → terminal canonical result
```

唯一公开 Review 编排路径是 `smartflow_execute → smartflow_review_turn*`。公开 MCP surface 恰好六个工具：

- `smartflow_execute` 与 `smartflow_review_turn` 构成唯一 Review 编排 API；
- `smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` 分别是独立的 Run inspection、paused-Run recovery、cancellation、result management API，不是 Review continuation 或第二条 Review 编排路径；active `hostTurn` 的 `USER_INPUT_REQUIRED` answer 必须由 owning Host 携带相同 `turnToken` 通过 `smartflow_review_turn` 提交，公开 `smartflow_resume` 不能代答或绕过 ownership。

Bounded poll、原子 Review begin/finalize、自动 decision 以及 repair/publish progression 由 Daemon 负责。旧 wait/claim/renew/submission/Leader primitive bridge 已删除；对应公开 symbols、schemas、handlers、registrations、aliases 均不存在。

`NOT_READY`、stale continuation 和终态不暴露 worktree path。Durable `AWAITING_REVIEW` 的 `REVIEW_REQUIRED` 向 owning Host 暴露 Reviewer worktree；当 `PUBLISH_ADAPTER_UNAVAILABLE`、`PUBLISH_PRECHECK_CONFLICT` 或后续人工确认不匹配需要用户处理时，owning Host 的 `USER_INPUT_REQUIRED` 也会提供同一已审核 Candidate 的 `worktreePath`，但不会披露原项目或 StateStore 路径。

## Host, Daemon, Reviewer, and Worker Boundary

- **Host/Leader**：批准 Task 意图；持有 SmartFlow MCP；创建/恢复 Reviewer；与用户交互；仅通过 `smartflow_review_turn` 返回 Review 或用户答案，不选择或补充 repair scope。
- **Daemon**：Run 状态机、Pi 生命周期、bounded poll、原子 Review begin/finalize、确定性 decision、repair budget、全部 Issue 的 repair 派生、普通 Run 恢复和 Publish progression。它不创建 Reviewer、不解释开放式用户意图。
- **Reviewer**：独立于 Host 与 Pi，重读同步 Task 和最新完整结果，检查 cumulative changed paths，并在 `review.result` 中逐 Task 返回唯一 ReviewResult；changed paths 是输入义务而非结果字段。
- **Pi Worker**：只实现当前 Revision；不接 SmartFlow MCP，不等待用户，不参与 Review。

Host-only interaction 与 Daemon-owned mechanics 不矛盾：机械策略已由规范冻结，只有 Reviewer 执行和用户选择需要 Host 能力。

## Composite Review Turn and Durable State

公开输出恰好四态；内部 Run-state schema-v6 checkpoint 恰好两阶段：

```text
AWAITING_REVIEW
       ↓
AWAITING_USER_INPUT
```

每个 checkpoint 绑定 `hostTurnId + turnToken + revision`。Review begin 在一次 Project-wide `stateVersion` CAS 中同时落 `REVIEWING + AWAITING_REVIEW`。Review finalize 先严格验证整个 payload、enabled Task 集合、Issue 不变量以及当前 turn/Revision/Candidate/session 绑定；任何失败都在写 artifact/state 前拒绝，Run 与 active checkpoint 不变，也不产生 decision。只有验证成功后，一次 domain operation 才写 schemaVersion 2 Review/Leader evidence 并直接落 `READY_TO_PUBLISH | FIXING | PAUSED`。Review deadline 是单一 30 分钟 durable timestamp，不再有短 lease 或 renew loop。Schema-v4/schema-v5 Run state 在启动时迁移到 schema-v6，无法安全证明的 active Review 会暂停；此迁移不转换 Review/Leader artifact。

Daemon 重启时先由 Host-turn coordinator 恢复 durable checkpoint，再重读 fresh state。只要 `hostTurn` 存在，ordinary Run recovery 不得并行推进该 Run。

## Automatic Review Decision

唯一 Review 数据模型是：

```text
ReviewResult = { tasks: TaskReview[] }
TaskReview = { id, completionPercentage, issues }
Issue = { path, message, suggestedFix? }
```

`ReviewResult.tasks[].id` 必须唯一且精确覆盖 `manifest.enabledTaskIds`。`completionPercentage` 是 0–100 的整数，并满足 `completionPercentage === 100` 当且仅当 `issues` 为空；不完整 Task 至少有一个 Issue。同一 Task 内的 Issue 按 `(path, message)` 唯一。Strict schema 只要求 Issue `path` 非空且通过项目相对路径的词法安全检查，`message` 非空，`suggestedFix` 若存在也非空；它不检查路径是否存在、是否目录/symlink，也不分析 message 的语义。Reviewer prompt 另行要求 `message` 指出具体函数或行为、触发条件与影响。三层对象均不接受额外 Review 数据字段。

| 合法 ReviewResult 与当前轮次 | Daemon 计划 |
|---|---|
| 每个 Task 均为 `100` | `ACCEPT` → Publish |
| 至少一个 Task 不完整且 `autoRepairRounds < 15` | `REPAIR`，确定性处理每个 `tasks[].issues[]` 条目 |
| 至少一个 Task 不完整且 `autoRepairRounds >= 15` | `PAUSE_REPAIR_LIMIT`；等待用户是否授予下一组 |

机械计划严格只有 `ACCEPT | REPAIR | PAUSE_REPAIR_LIMIT`。Host/Leader 不得选择 Issue 子集、追加 repair 条目或提交第二套 repair 数据。每个成功准备的 repair 使用新 Revision/new Pi session，但复用 bound Reviewer。额度耗尽后，owning Host 携带 active `turnToken`，通过当前 `smartflow_review_turn` 的 `USER_INPUT_REQUIRED` answer 提交 `resume_review_decision`；HostTurnCoordinator 以 allowance 基数 `0` 重新规划 stored v2 Review。若计划为 `REPAIR`，持久化的 `autoRepairRounds` 为 `1`，随后 `RepairCoordinator.prepare()` 可能创建下一 Revision，也可能因真实 repair 条件暂停；该路径不会重新执行 `manifest.enabledTaskIds` exact-coverage 校验。

跨合法的不完整轮次，`run.recovery.repairRound` 保存 `{ failureIds, tasks, relevantPathHashes }`。no-progress 的稳定问题集合只包含 failure IDs 与 `(TaskReview.id, Issue.path)`；`relevantPathHashes` 来自 Candidate operations 的 `newEntry.sha256` 或删除标记 `DELETED`。当前问题集合严格小于上一轮，或两轮 Issue path 并集中的任一相关 hash 变化，即为 progress 并清零计数；否则计数加一。首轮用 current/current 与已有计数 `-1` 得到 `0`，默认暂停阈值为 15。`message`、`suggestedFix`、完成百分比和数组顺序都不参与身份；实现不重读 Result Snapshot，也不增加第四种 Review decision。

Durable Review 与 Leader artifacts 均为 `schemaVersion: 2`。Review artifact 内含 `revision/claimId/reviewAttemptId/taskSourceHash/candidateHash/reviewerSessionId/piSessionId/gate/reviewHash`；其中 `gate` 保存 `accepted/allowedLeaderDecisions/result`，`reviewHash` 校验不含自身的 canonical body。Leader artifact 仅含 `revision/reviewHash/decision/reason/decidedAt/decisionHash`，通过 `reviewHash` 间接绑定 Candidate 与 task source，不含独立 repair 列表或直接的 Candidate/task-source 字段。Artifact v1 不升级、不按 v2 解释；strict v2 parse 失败会使对应 Run 以 `ARTIFACT_SEMANTIC_VALIDATION_FAILED` 暂停或阻塞。新部署可在运维上选择新 Data Directory，但当前 runtime 仍使用未版本化的 `<user-data>/smartflow`，没有 format marker/probe。

## Task and Pi Configuration Boundary

`tasks.md` 只表达业务任务、稳定 Task ID、目标路径和验收条件。Provider、模型、凭据、Sandbox 与运行参数不得写入任务正文。

SmartFlow MCP server 环境提供 `SMARTFLOW_PI_API`、`SMARTFLOW_PI_BASE_URL`、`SMARTFLOW_PI_MODEL`、`SMARTFLOW_PI_API_KEY`；每个 Revision 冻结非敏感 `providerRuntimeConfigHash`。支持四种标准协议，context/max output/thinking/rolling deadline 默认 `1000000/384000/high/300000ms`，deadline 覆盖值最低 `60000ms`；Pi child 每 30 秒心跳续期。

Pi child 加载静态 Extension，通过官方 `pi.registerProvider()` 在内存中注册唯一模型。SmartFlow 不生成/读取 `models.json`，不读取宿主用户 Pi 配置，不在 argv、状态、session、Artifact 或日志中保存 API Key。

## Pi Worker and Safety Boundary

- Daemon 通过 `ExecutionSandboxAdapter` 启动 Pi SDK child；Agent loop 不在 Daemon 进程运行。
- Parent/child 使用 SDK JSONL RPC；Daemon 只归一化事件和管理生命周期。
- Pi 直接使用官方 coding tools，可在当前 workspace 修改项目文件、执行 Shell/子进程并访问网络。
- 原始项目、SmartFlow 状态、其他 Run workspace 和宿主用户数据不可访问；必要 bootstrap 只读。
- `.smartflow-runtime/` 在 Candidate 前清理/排除；Publish Adapter 是唯一 SmartFlow-managed 原项目写入路径。发布暂停后用户可从已审核 worktree 人工合并，Daemon 的确认步骤只观察目标状态。
- ToolExecutionBroker、effects、Worker 工具审批和 `smartflow_submit_tool_decision` 已移除。

## Session and Recovery

| 场景 | 结果 |
|---|---|
| Host 重连且 Daemon/Pi 存活 | 继续同 job、Attempt、Pi session |
| Daemon 在 active Host turn 重启 | 恢复同 token/deadline/pause；ordinary Run recovery 不并发推进 |
| Pi/Daemon Worker 崩溃 | 相同 job/Revision/workspace，新 Attempt/Pi session |
| Attempt 超时 | 终止进程树，持久化 `TIMED_OUT`，等待允许的恢复 |
| 自动 repair Revision | 上一 Result Tree 物化，新 Pi session，同一 Reviewer |
| 独立新功能 | Host 根据用户意图创建新 Task/Run |
| Cancel | 完整 containment 对账后落终态 |

## Publish and Evidence Boundary

只有经过完整校验且每个 Task 都为 100% 的 ReviewResult 才能自动 `ACCEPT`/Publish。`PublishCoordinator` 重新验证 Manifest、Candidate、schemaVersion 2 Review/Leader artifacts 与批准源绑定，并确认 `reviewHash` 证据链中的 `candidateHash` 和 `taskSourceHash`，再从当前 Candidate、同 Revision 的 immutable `REVISION_RESULT` snapshot 以及 Run Git object store 确定性派生 `ApplyOperation[]` 和经 path/hash/size 校验的 blob references；当前流程不另造交付 Artifact。

`PublishService` 以 `projectId + jobId + revision + candidateHash + reviewHash + operationsHash` 派生稳定 `operationId`，在项目级 lease 下执行 adapter capability probe 和全路径 expected-old kind/hash/mode preflight。只有预检全部通过才持久化 `PREPARED`、进入 `PUBLISHING`、提交 adapter apply，并把 `SUBMITTED`、逐路径 `PublishResult` 与最终状态写入 result journal。响应丢失或 Daemon 重启时，以相同 operation identity 重建操作并查询 adapter 结果；不会盲目重放。

`PRECHECK_CONFLICT` 保证 `publishedCount=0`、`activeWorkspaceChanged=false` 并持久化 `publishPrecheck`；adapter 缺失或原子 CAS/batch/query 能力不足则暂停为 `PUBLISH_ADAPTER_UNAVAILABLE`。这两类 owning Host 的 `USER_INPUT_REQUIRED` 提供已审核 Candidate 的 `worktreePath` 和 `retry_publish | confirm_manual_publish | cancel`。用户可把已审核结果人工合并到原项目，再提交 `confirm_manual_publish`；Daemon 只读观察所有 Candidate target operations。只有每条目标路径的 kind、hash 与 mode 精确匹配才合成 `manual-confirmation-v1` 的 `COMMITTED` attempt/result 并进入 `COMPLETED`；不匹配继续 `PAUSED/MANUAL_PUBLISH_TARGET_MISMATCH`。

任何 PARTIAL、UNKNOWN、不可查询结果或 identity 不一致都保持 `PUBLISH_RECOVERY_BLOCKED`，保留 operation/result evidence，并且不能通过人工确认、重试声明或其他恢复动作绕过。

Production-composition 的复合编排覆盖已完成。T204 覆盖 paused Host ownership、原子 begin/finalize、lost-response durable replay 与单 deadline restart；T205 覆盖 Reviewer callback 的 `changedPaths` 与 self-contained pause/no primitive result fallback。

真实 installed Pi SDK/model 兼容的开放证据仍是 T190/T208 与 T192/T209。Mocked `registerProvider` 和 gitignored `.smartflow-e2e` transcript 不是可审计 real-model 证据。

## Explicitly Out of Scope

- 自建 coding tools/Broker 或双 Provider compatibility path；
- Daemon 创建/替换 Reviewer，或 Reviewer/Pi 直接与用户交互；
- 为 `HostActionLoop` 或五个 manual Review orchestration MCP names 提供公开 symbols、schemas、handlers、registrations、aliases；
- 动态向 Pi 注入 SmartFlow MCP、Host/global Skills；
- 独立通用 verify/gate 阶段；
- 自动 Git commit/push/PR、自动 merge、路径预占或并行 Publish；
- Linux/Windows Sandbox adapter、分布式调度、外部数据库和 GUI 管理后台。
