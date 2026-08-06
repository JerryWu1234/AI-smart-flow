<!--
同步影响报告
- 版本变更：3.0.0 -> 4.0.0
- 修改原则：
  - CP-003（Provider 与权限策略可冻结）-> Pi 运行配置冻结
  - CP-004（Provider 显式选择且不静默降级）-> Pi Worker 固定且不静默降级
  - CP-005（全部副作用经 Broker）-> 隔离 Workspace 与进程级强制边界
  - CP-010（副作用幂等与可审计）-> Attempt、会话与状态转换可审计
- 保留原则：CP-001、CP-002、CP-006、CP-007、CP-008、CP-009、CP-011
- 新增原则：无
- 删除原则：无
- 模板检查：
  - ✅ .specify/templates/spec-template.md：无需结构变更
  - ✅ .specify/templates/plan-template.md：无需结构变更
  - ✅ .specify/templates/tasks-template.md：无需结构变更
  - ✅ .specify/templates/checklist-template.md：无需结构变更
- 运行设计文档：✅ 已同步 specs/001-smartflow-mvp/ 与 SmartFlow-Spec-Kit-R5.md
- 后续 TODO：无
-->

# SmartFlow Constitution

## Core Principles

### CP-001：Leader-only User Interaction（强制）
- 只有 Leader MAY 直接与用户交互。
- Worker、Reviewer、Pi Agent 与任何工具调用 MUST NOT 直接等待或消费用户输入。
- Worker 遇到阻塞时 MUST 以结构化结果返回 Leader；Leader 决定继续当前 Task、创建新 Revision，或终止 Run。

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
- 运行中的内部 workspace 与状态目录 MUST NOT 通过 MCP Resource、API、日志或 UI 暴露真实路径。
- 对外只能暴露逻辑 ID、相对路径与受控 Artifact 引用。
- Finalize 后的 Candidate、Review、日志和 Pi 会话 Artifact MAY 被列出；内部绝对路径仍 MUST 被隐藏。

### CP-007：Candidate 与 Publish 必须分离（强制）
- Worker 完成后 MUST 先生成不可变 Candidate；Reviewer MUST 只针对该 Candidate 审查。
- 未经 Leader 明确决定，Candidate MUST NOT 写回原始项目。
- Publish MUST 基于已审查的 Candidate、预期 HEAD 与目标分支执行；冲突 MUST 进入显式状态，MUST NOT 静默覆盖。

### CP-008：Review 是发布前门槛（强制）
- Reviewer MUST 输出结构化 Review Artifact，至少包含 verdict、findings 和 Candidate 绑定信息。
- `changes_requested` MUST 回到同一 Task 的新 Revision 或 Repair Attempt；`approved` 只代表可进入 Leader 决策，不等于自动发布。
- SmartFlow 不设置独立的通用 verify/gate 阶段；Pi MAY 在 isolated workspace 中按 Task 需要运行项目命令。

### CP-009：Single-Writer 与并发控制（强制）
- 单个 Project MUST 由唯一有效 writer lease 保护共享运行状态与 Publish。
- 状态变更 MUST 使用 revision/CAS 语义；失去 lease 的进程 MUST 停止写入。
- 并发读 MAY 被允许，但不得破坏 Candidate 不可变性和 Publish 原子性。

### CP-010：Attempt、会话与状态转换可审计（强制）
- 每次 Worker 执行 MUST 有稳定的 `attemptId`、Pi 会话标识、Sandbox containment 标识和输入 Revision 绑定。
- Host 重连且原 Worker 仍存活时 MUST 继续同一 Attempt/Pi session；Worker 或 daemon 崩溃后 MUST 创建新 Attempt/Pi session，并继续使用同一 Revision 与 isolated workspace。
- Run 状态、Attempt、Candidate、Review、Leader 决定和 Publish 结果 MUST 持久化并可追溯；不得以日志替代状态真相。

### CP-011：取消、超时、崩溃必须可恢复（强制）
- 取消 MUST 终止 Pi Worker 及其全部子进程，回收 lease，并将 Run 写入终态或可恢复状态。
- 进程崩溃、主机重启或客户端重连后 MUST 从持久化状态恢复；不得假设旧 Pi session 仍可用。
- 恢复逻辑 MUST 区分“同一 Task 的继续执行”和“新功能的新 Task”，最终分类由 Leader 决定。

## Product and Runtime Boundaries

- Host/Leader 持有 MCP 与全部用户交互能力；Pi Worker 不接收 SmartFlow MCP server。
- 本次迁移不向 Pi 动态注入 Host/global Skills；Pi MAY 发现 isolated workspace 内受控的项目本地资源和 Skills。
- Git 是 Workspace、Snapshot、Candidate、Review 与 Publish 的主要变更基础设施。
- `@earendil-works/pi-coding-agent` 是唯一 Worker SDK；`@earendil-works/pi-agent-core` MAY 作为其传递依赖，但 SmartFlow 不直接重建 Coding Agent 能力。
- 支持平台 MUST 以可验证的 OS sandbox adapter 为前提；没有 containment adapter 的平台 MUST fail closed。

## Development Workflow and Quality Gates

1. 先冻结 Task Revision 与 Pi runtime config hash。
2. 创建/恢复 isolated Git workspace，并验证 Sandbox containment。
3. 在 Sandbox 内启动 Pi Coding Agent SDK Worker；Pi 直接使用官方工具修改 workspace。
4. Worker 完成后清理/排除运行时文件并生成不可变 Candidate。
5. Reviewer 审查 Candidate；Leader 决定 Publish、Repair 或停止。
6. Publish 使用预期 HEAD 和原子 Git 操作写回原始项目。
7. 所有状态转换、Attempt、Artifact 和 Publish 结果 MUST 经过契约测试与恢复测试覆盖。

## Governance

- 本 Constitution 优先于普通设计文档、实现便利性与历史兼容性。
- 修改原则必须同步更新受影响的 spec、plan、contracts、tasks、quickstart 与根设计文档。
- 版本规则：移除或不兼容地重定义原则为 MAJOR；新增原则或实质扩展为 MINOR；措辞澄清为 PATCH。
- 4.0.0 明确废弃 OpenCode/Claude Worker、ToolExecutionBroker、工具效果账本、Worker 工具审批流及其持久化状态；旧状态不保证原地兼容。
- 合并前 MUST 运行 Spec Kit 一致性分析；若 Constitution 与实现计划冲突，以 Constitution 为准并阻止实现。

**Version**: 4.0.0 | **Ratified**: 2026-07-20 | **Last Amended**: 2026-08-04
