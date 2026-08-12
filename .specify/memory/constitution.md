<!--
同步影响报告
- 版本变更：4.0.0 -> 4.1.0
- 修改原则：
  - CP-001：澄清 Leader-only user interaction 不等于 Host 执行机械状态编排；Host 独占 Reviewer 执行和用户交互，Daemon 可执行冻结的确定性编排。
  - CP-008：Review 仍是发布门槛；满足门槛后的 accept/publish 与不满足时的 repair/pause 由 Daemon 按冻结策略推进。
  - CP-009：扩展为 Project-wide CAS、per-Run serialization、稳定子请求 ID 与 durable Host-turn ownership。
- 保留原则：CP-002–CP-007、CP-010、CP-011
- 新增原则：无
- 删除原则：无
- 模板检查：
  - ✅ .specify/templates/spec-template.md：无需结构变更
  - ✅ .specify/templates/plan-template.md：无需结构变更
  - ✅ .specify/templates/tasks-template.md：无需结构变更
  - ✅ .specify/templates/checklist-template.md：无需结构变更
- 通用 Spec Kit 配置：✅ feature/init/integration、workflow registry/YAML、templates 与 scripts 均不变
- 运行设计文档：✅ 已同步 specs/001-smartflow-mvp/ 与 SmartFlow-Spec-Kit-R5.md
- 后续 TODO：真实 pinned Pi SDK/RPC 兼容与可审计 real-model 两工具 E2E 证据仍保持开放
-->

# SmartFlow Constitution

## Core Principles

### CP-001：Leader-only User Interaction（强制）
- 只有 Host/Leader MAY 直接与用户交互，也只有 Host MAY 创建或恢复独立 Reviewer session 并执行 Reviewer turn。
- Daemon MAY 执行冻结且确定性的机械编排，包括等待、claim/renew、提交后 accept/repair/pause、批准既有范围的 repair Revision 与 Publish；这不构成第二个 Leader。
- Daemon MUST NOT 创建、替换或模拟 Reviewer；Worker、Reviewer、Pi Agent 与工具调用 MUST NOT 直接等待或消费用户输入。
- 需要选择、批准或补充信息时，Daemon MUST 返回结构化 `USER_INPUT_REQUIRED`；Host/Leader 是唯一向用户提问并提交答案的边界。

### CP-002：Task Revision 是执行单元（强制）
- Run MUST 维护不可变的 Task Revision 链；每个 Revision MUST 对应冻结后的 `tasks.md`。
- 同一 Task 的澄清、补充和修复 MAY 形成新 Revision；新功能或独立目标 MUST 使用新的 Task/Run。
- Worker、Reviewer、Candidate、Publish 与恢复决策 MUST 可追溯到唯一的 `runId + revisionId + tasksSha256`。

### CP-003：Pi 运行配置必须冻结（强制）
- Worker Provider MUST 固定为 `@earendil-works/pi-coding-agent` SDK。
- 模型、凭据来源和 Pi 运行参数 MUST 来自 SmartFlow 安装级或项目级配置，不得写入 Task 正文。
- 每个 Task Revision MUST 冻结 `providerRuntimeConfigHash`；同一 Revision 的恢复 MUST 使用相同配置哈希。
- Provider 运行配置缺失、失效或漂移时 MUST 暂停或失败，MUST NOT 静默选择其他 Provider、模型或凭据。

### CP-004：Pi Worker 固定且不静默降级（强制）
- SmartFlow Worker MUST 通过 Pi Coding Agent SDK 执行，不得回退到 OpenCode、Claude Agent SDK 或自建 Agent runtime。
- SmartFlow MAY 对 Pi 事件进行协议归一化，但 MUST NOT 重写 Pi 的文件、搜索、编辑或 Shell 工具实现。
- Worker 能力缺失或 SDK 不兼容时 MUST 以明确状态暴露；MUST NOT 通过遗留 Broker、替代 Provider 或宿主侧隐式执行继续运行。

### CP-005：隔离 Workspace 与进程级强制边界（强制）
- 每个 Run/Revision MUST 在独立的 Git-backed isolated workspace 中执行；Pi Worker 进程及其全部子进程 MUST 被 OS sandbox 包围。
- Pi MAY 使用官方 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具，MAY 修改 isolated workspace 内任意项目文件，MAY 执行任意 Shell 命令并访问网络。
- Pi MUST NOT 访问原始项目根目录、SmartFlow 状态目录、其他 Run 的 workspace 或宿主用户的其他文件。
- Pi 运行时目录、会话文件和临时文件 MUST 位于当前 isolated workspace 的 SmartFlow 专用子目录中；在生成 Candidate 前 MUST 排除或清理这些运行时内容。
- SmartFlow MUST NOT 保留自建文件操作层、ToolExecutionBroker、效果账本或 Broker 工具桥。
- Publish 是唯一 MAY 将 Candidate 写回原始项目根目录的路径；Publish 前原始项目 MUST 保持不变。

### CP-006：运行中目录不可发现（强制）
- 运行中的内部 workspace 与状态目录 MUST NOT 通过普通 MCP Resource、status、日志或 UI 暴露真实路径。
- `worktreePath` MAY 只在 Review Action 已被当前 durable Host turn 成功 claim 后，通过 `REVIEW_REQUIRED` 返回给该 Host；`NOT_READY`、`USER_INPUT_REQUIRED`、`DONE`、错误与 stale continuation MUST NOT 携带该路径。
- 对外其他位置只能暴露逻辑 ID、相对路径与受控 Artifact 引用；Finalize 后的 Artifact 仍 MUST 隐藏内部绝对路径。

### CP-007：Candidate 与 Publish 必须分离（强制）
- Worker 完成后 MUST 先生成不可变 Candidate；Reviewer MUST 只针对该 Candidate 审查。
- Candidate MUST NOT 在 Review 门槛满足前写回原始项目。
- Publish MUST 基于已审查的 Candidate、预期 HEAD 与目标分支执行；冲突 MUST 进入显式状态，MUST NOT 静默覆盖。

### CP-008：Review 是发布前门槛（强制）
- Reviewer MUST 输出结构化 Review Artifact，覆盖每个批准 Task、全部 changed paths、completion percentage、findings 与 Candidate 绑定。
- 只有所有 Task 为 100%、verdict 为 `APPROVE`、路径覆盖完整且无 blocking finding 时，Daemon MAY 按冻结策略自动 accept 并 Publish。
- 存在可执行 blocking finding 时，Daemon MUST 只把当前 finding fingerprints 转换为同一 Task 范围内的 repair；不得要求 Host 重做机械决策。
- 无可执行 finding 的不完整/无效 Review、自动修复额度耗尽、Reviewer 不可用或无法证明安全状态时 MUST durable pause，并通过 `USER_INPUT_REQUIRED` 或终态暴露。
- SmartFlow 不设置独立的通用 verify/gate 阶段；Pi MAY 在 isolated workspace 中按 Task 需要运行项目命令。

### CP-009：Single-Writer、CAS 与 Host-turn Ownership（强制）
- 单个 Project MUST 由唯一有效 writer lease 保护共享运行状态与 Publish；所有 mutation MUST 使用 Project-wide revision/CAS 语义。
- 同一 `projectId + jobId` 的复合 Review turn MUST 串行化；不同 Run MAY 并行，但共享 `state.json` 的每次提交都必须重新校验 stateVersion。
- claim intent、claimed review、等待用户输入和自动修复额度 MUST durable-first 持久化；每个 active Host turn MUST 绑定稳定 `hostTurnId + turnToken + revision`。
- 自动重试 MUST 使用稳定派生的 child request IDs；CAS mismatch、重启或重复请求不得重复 claim、Review 提交、repair 或 Publish。
- 失去 lease、Host-turn ownership 或当前 Revision/Candidate 绑定的进程 MUST 停止写入；stale continuation 只能获得无敏感路径的当前状态。

### CP-010：Attempt、会话与状态转换可审计（强制）
- 每次 Worker 执行 MUST 有稳定的 `attemptId`、Pi 会话标识、Sandbox containment 标识和输入 Revision 绑定。
- Host 重连且原 Worker 仍存活时 MUST 继续同一 Attempt/Pi session；Worker 或 Daemon 崩溃后 MUST 创建新 Attempt/Pi session，并继续使用同一 Revision 与 isolated workspace。
- Run 状态、Attempt、Candidate、Review、自动决定、Host turn、用户答案和 Publish 结果 MUST 持久化并可追溯；不得以日志替代状态真相。

### CP-011：取消、超时、崩溃必须可恢复（强制）
- 取消 MUST 终止 Pi Worker 及其全部子进程，回收 lease，并将 Run 写入终态或可恢复状态。
- 进程崩溃、主机重启或客户端重连后 MUST 从持久化状态恢复；不得假设旧 Pi session 或 Host 请求仍在内存中。
- 存在 durable `hostTurn` 时，Host-turn coordinator MUST 成为该 Run 的唯一 Review-turn 恢复权威；恢复后必须重读 fresh state，避免 legacy recovery 并发推进同一 Run。
- 恢复逻辑 MUST 区分“同一 Task 的继续执行”和“新功能的新 Task”，最终分类由 Host/Leader 根据用户意图完成。

## Product and Runtime Boundaries

- 首选高层调用路径是 `smartflow_execute → smartflow_review_turn`；`smartflow_review_turn` 只返回 `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`。
- Host/Leader 持有 MCP、Reviewer 执行与全部用户交互；Daemon 持有确定性状态编排；Pi Worker 不接收 SmartFlow MCP。
- MCP surface 恰好保留 11 个工具：复合 `smartflow_review_turn` 加原有 10 个 primitive。Primitive 用于兼容、诊断和低层控制，不是高层 Host workflow 的首选路径。
- 本次迁移不向 Pi 动态注入 Host/global Skills；Pi MAY 发现 isolated workspace 内受控的项目本地资源和 Skills。
- Git 是 Workspace、Snapshot、Candidate、Review 与 Publish 的主要变更基础设施。
- `@earendil-works/pi-coding-agent` 是唯一 Worker SDK；`@earendil-works/pi-agent-core` MAY 作为其传递依赖，但 SmartFlow 不直接重建 Coding Agent 能力。
- 支持平台 MUST 以可验证的 OS sandbox adapter 为前提；没有 containment adapter 的平台 MUST fail closed。

## Development Workflow and Quality Gates

1. 冻结 Task Revision 与 Pi runtime config hash，并调用 `smartflow_execute`。
2. Daemon 创建/恢复 isolated Git workspace，在 Sandbox 内执行 Pi，生成不可变 Candidate 与 Review Action。
3. Host 反复调用 `smartflow_review_turn`；`NOT_READY` 按 `retryAfterMs` bounded poll，不自行驱动 primitive 状态机。
4. 收到 `REVIEW_REQUIRED` 后，Host 按 `CREATE` 或 `RESUME` 执行独立 Reviewer，并用相同 `turnToken` 提交 Review；Daemon 负责 claim renewal、确定性 accept/repair/pause 和 Publish。
5. 收到 `USER_INPUT_REQUIRED` 后，只有 Host 与用户交互并提交列出的合法 answer；`DONE` 必须只对应终态 `result`。
6. Publish 使用预期 HEAD 和原子 Git 操作写回原始项目；冲突和恢复阻塞必须 durable pause。
7. 契约测试 MUST 覆盖四公开状态、路径保护、11 工具、Host-turn ownership、restart/CAS/renew/deadline、15 轮额度和两工具 production composition。
8. Mocked Pi Extension/RPC 测试不能替代真实 pinned SDK 兼容和经用户授权的 real-model E2E 证据；未验证项必须保持开放。

## Governance

- 本 Constitution 优先于普通设计文档、实现便利性与历史兼容性。
- 修改原则必须同步更新受影响的 spec、plan、contracts、tasks、quickstart、追踪矩阵与根设计索引。
- 版本规则：移除或不兼容地重定义原则为 MAJOR；新增原则或实质扩展为 MINOR；措辞澄清为 PATCH。
- 4.0.0 明确废弃 OpenCode/Claude Worker、ToolExecutionBroker、工具效果账本、Worker 工具审批流及其持久化状态；旧状态不保证原地兼容。
- 4.1.0 明确采用 Daemon-owned mechanical orchestration 和单一复合 Review turn，同时保留 Host-only Reviewer/user boundary 与 10 个 primitive 兼容工具。
- 合并前 MUST 运行 Spec Kit 一致性分析；若 Constitution 与实现计划冲突，以 Constitution 为准并阻止实现。

**Version**: 4.1.0 | **Ratified**: 2026-07-20 | **Last Amended**: 2026-08-11
