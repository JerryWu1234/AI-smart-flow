<!--
同步影响报告
- 版本变更：4.1.0 -> 5.0.0
- 修改原则：
  - CP-001：保留 Leader-only user interaction，并明确 Host 只通过复合 Review turn 返回 Reviewer 结果或用户答案；wait、claim/renew、Review submission、Leader decision 与 repair/publish progression 是 Daemon 内部 mechanics。
  - CP-008：将发布门槛迁移为唯一 ReviewResult/TaskReview/Issue 模型、enabled Task 精确覆盖、三态机械计划、全量 Issue repair、no-progress 身份与 schemaVersion 2 Review/Leader evidence。
  - CP-009：Review payload 的 schema/binding 校验前移到任何 artifact/state mutation 之前；拒绝不改变 Run，也不产生额外 decision。
  - CP-011：保留 Host-turn coordinator 与 ordinary Run recovery 的互斥恢复契约。
- 保留原则：CP-002–CP-007、CP-010
- 新增原则：无
- 删除原则：无
- 不兼容性：Review/Leader artifact v1 不升级、不按 v2 解释；严格 v2 解析失败时对应 Run 安全暂停或阻塞。新部署可在运维上选择新的 Data Directory，但当前 runtime 没有目录格式版本 marker/probe。
- 公开面事实：`HostActionLoop` symbol 与五个 manual Review orchestration MCP names 的公开 symbols、schemas、handlers、registrations、aliases 均不存在；对应 Review mechanics 仅存在于 Daemon 内部。
- 模板检查：
  - ✅ .specify/templates/spec-template.md：无需结构变更
  - ✅ .specify/templates/plan-template.md：无需结构变更
  - ✅ .specify/templates/tasks-template.md：无需结构变更
  - ✅ .specify/templates/checklist-template.md：无需结构变更
- 通用 Spec Kit 配置：✅ feature/init/integration、workflow registry/YAML、templates 与 scripts 均不变
- 运行设计文档：✅ 已同步 SmartFlow-Spec-Kit-R5.md、current/historical Review ADR、research 与 glossary
- 后续 TODO：真实 pinned Pi SDK/RPC 兼容与可审计 real-model 两工具 E2E 证据仍保持开放
-->

# SmartFlow Constitution

## Core Principles

### CP-001：Leader-only User Interaction（强制）
- 只有 Host/Leader MAY 直接与用户交互，也只有 Host MAY 创建或恢复独立 Reviewer session 并执行 Reviewer turn。
- Host MUST 只通过 `smartflow_review_turn` 返回 Reviewer 结果或结构化用户答案；不得通过独立 Run 管理 API 手动编排 Review 状态。
- Daemon MAY 执行冻结且确定性的机械编排，包括 wait、claim/renew、Review submission、Leader decision、批准既有范围的 repair Revision 与 Publish progression；这不构成第二个 Leader。
- Daemon MUST NOT 创建、替换或模拟 Reviewer；Worker、Reviewer、Pi Agent 与工具调用 MUST NOT 直接等待或消费用户输入。
- 需要选择、批准或补充信息时，Daemon MUST 返回结构化 `USER_INPUT_REQUIRED`；Host/Leader 是唯一向用户提问并通过同一 Review turn 提交答案的边界。

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
- Reviewer MUST 在 `review.result` 中仅输出 `ReviewResult = { tasks: TaskReview[] }`；`TaskReview` MUST 严格为 `{ id, completionPercentage, issues }`，Issue MUST 严格为 `{ path, message, suggestedFix? }`，不得存在第二套 Review 数据。
- Review Task IDs MUST 唯一且精确覆盖 `manifest.enabledTaskIds`。`completionPercentage` MUST 为 0–100 的整数，且 `completionPercentage === 100` 当且仅当 `issues` 为空；不完整 Task MUST 至少包含一个 Issue，同一 Task 的 Issue MUST 按 `(path, message)` 唯一。
- Issue schema MUST 只强制 `path` trim 后非空、不得以 `/` 开头、不得包含反斜杠或空/`.`/`..` slash-delimited segment，以及 `message` 与可选 `suggestedFix` 非空；它不另行识别 drive-qualified 形式，也不检查文件存在性、文件类型或 message 的自然语言具体程度。Reviewer prompt MUST 要求 `message` 描述具体函数或行为、触发条件和影响。Reviewer MUST 检查全部 cumulative changed paths，但该列表只是 Review 输入义务，不是 ReviewResult 属性或额外接受谓词。
- `planReviewDecision()` MUST 只产生 `ACCEPT | REPAIR | PAUSE_REPAIR_LIMIT`：每个 Task 均为 100% 时 MUST `ACCEPT`；否则 `autoRepairRounds < 15` 时 MUST `REPAIR`；否则 MUST `PAUSE_REPAIR_LIMIT`。
- `REPAIR` MUST 由 Daemon 从每个不完整 Task 的全部 `issues` 确定性派生；Host/Leader MUST NOT 选择子集、追加 repair 条目或提交独立 repair 数据。
- no-progress 比较 MUST 使用 `run.recovery.repairRound = { failureIds, tasks, relevantPathHashes }`：稳定问题集合仅由 failure IDs 与 `(TaskReview.id, Issue.path)` 组成；相关 Issue path 的 Candidate operation hash 变化（删除为 `DELETED`）或当前问题集合严格缩小 MUST 视为 progress。`message` 与 `suggestedFix` MUST NOT 参与身份。默认 `noProgressCount` 暂停阈值 MUST 为 15，且该 operational pause 不增加第四种 Review decision。
- Durable Review 与 Leader artifacts MUST 均使用 `schemaVersion: 2`。Review artifact MUST 内含 `reviewHash`，并直接保存 `candidateHash`、`taskSourceHash` 与 `gate.result`；Leader artifact MUST 仅通过 `reviewHash` 绑定 Review，且不得直接保存 Candidate/task-source binding 或独立 repair 列表。Artifact v1 MUST NOT 升级或按 v2 解释；strict v2 parse 失败 MUST 使对应 Run 安全暂停或阻塞。
- Reviewer 不可用、deadline、Publish conflict 或无法证明安全恢复的状态 MAY 作为 operational durable pause 暴露，但 MUST NOT 成为额外 Review decision。
- SmartFlow 不设置独立的通用 verify/gate 阶段；Pi MAY 在 isolated workspace 中按 Task 需要运行项目命令。

### CP-009：Single-Writer、CAS 与 Host-turn Ownership（强制）
- 单个 Project MUST 由唯一有效 writer lease 保护共享运行状态与 Publish；所有 mutation MUST 使用 Project-wide revision/CAS 语义。
- 同一 `projectId + jobId` 的复合 Review turn MUST 串行化；不同 Run MAY 并行，但共享 `state.sqlite` 的每次提交都必须重新校验 stateVersion。
- Daemon MUST 在任何 Review/Leader artifact 或 Run-state mutation 之前完成整个 payload 的 strict schema、enabled Task 覆盖以及 Reviewer/turn/Revision/Candidate/session binding 校验。Reviewer prompt 的 message 内容规范不得被描述为 runtime 自然语言校验。任何校验失败 MUST 拒绝提交、保持 Run 与 active checkpoint 不变，并且不得生成 Review decision。
- claim intent、claimed review、等待用户输入和自动修复额度 MUST durable-first 持久化；每个 active Host turn MUST 绑定稳定 `hostTurnId + turnToken + revision`。
- 自动重试 MUST 使用稳定派生的 child request IDs；CAS mismatch、重启或重复请求不得重复 claim、Review submission、repair 或 Publish。
- 失去 lease、Host-turn ownership 或当前 Revision/Candidate 绑定的进程 MUST 停止写入；stale continuation 只能获得无敏感路径的当前状态。

### CP-010：Attempt、会话与状态转换可审计（强制）
- 每次 Worker 执行 MUST 有稳定的 `attemptId`、Pi 会话标识、Sandbox containment 标识和输入 Revision 绑定。
- Host 重连且原 Worker 仍存活时 MUST 继续同一 Attempt/Pi session；Worker 或 Daemon 崩溃后 MUST 创建新 Attempt/Pi session，并继续使用同一 Revision 与 isolated workspace。
- Run 状态、Attempt、Candidate、Review、自动决定、Host turn、用户答案和 Publish 结果 MUST 持久化并可追溯；不得以日志替代状态真相。

### CP-011：取消、超时、崩溃必须可恢复（强制）
- 取消 MUST 终止 Pi Worker 及其全部子进程，回收 lease，并将 Run 写入终态或可恢复状态。
- 进程崩溃、主机重启或客户端重连后 MUST 从持久化状态恢复；不得假设旧 Pi session 或 Host 请求仍在内存中。
- 存在 durable `hostTurn` 时，Host-turn coordinator MUST 成为该 Run 的唯一 Review-turn 恢复权威；恢复后必须重读 fresh state，ordinary Run recovery 不得并发推进同一 Run。
- 恢复逻辑 MUST 区分“同一 Task 的继续执行”和“新功能的新 Task”，最终分类由 Host/Leader 根据用户意图完成。

## Product and Runtime Boundaries

- 唯一公开 Review 编排路径是 `smartflow_execute → smartflow_review_turn*`；`smartflow_review_turn` 只返回 `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`。
- 公开 MCP surface MUST 恰好包含六个工具：`smartflow_execute`、`smartflow_review_turn`、`smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result`。
- `smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` MUST 分别作为独立的 Run inspection、paused-Run recovery、cancellation、result management API；MUST NOT 作为 Review continuation 或第二条 Review 编排路径。公开 `smartflow_resume` 在 active `hostTurn` 存在时 MUST NOT 充当 `USER_INPUT_REQUIRED` answer 或绕过 ownership；该 answer MUST 由 owning Host 携带相同 `turnToken` 通过 `smartflow_review_turn` 提交。
- Wait、Review claim/renew、Review submission、Leader decision、repair/publish progression MUST 仅为 Daemon 内部 mechanics；`HostActionLoop` symbol 与 `smartflow_wait`、`smartflow_claim_action`、`smartflow_renew_action_claim`、`smartflow_submit_review`、`smartflow_submit_leader_decision` 的公开 symbols、schemas、handlers、registrations、aliases MUST NOT 存在。
- Host/Leader 持有 MCP、Reviewer 执行与全部用户交互；Daemon 持有确定性状态编排；Pi Worker 不接收 SmartFlow MCP。
- 本次迁移不向 Pi 动态注入 Host/global Skills；Pi MAY 发现 isolated workspace 内受控的项目本地资源和 Skills。
- Git 是 Workspace、Snapshot、Candidate、Review 与 Publish 的主要变更基础设施。
- `@earendil-works/pi-coding-agent` 是唯一 Worker SDK；`@earendil-works/pi-agent-core` MAY 作为其传递依赖，但 SmartFlow 不直接重建 Coding Agent 能力。
- 支持平台 MUST 以可验证的 OS sandbox adapter 为前提；没有 containment adapter 的平台 MUST fail closed。

## Development Workflow and Quality Gates

1. 冻结 Task Revision 与 Pi runtime config hash，并调用 `smartflow_execute`。
2. Daemon 创建/恢复 isolated Git workspace，在 Sandbox 内执行 Pi，生成不可变 Candidate 与 Review Action。
3. Host 反复调用 `smartflow_review_turn`；`NOT_READY` 按 `retryAfterMs` bounded poll，任何其他公开 Run API 都不得充当 Review continuation。
4. 收到 `REVIEW_REQUIRED` 后，Host 按 `CREATE` 或 `RESUME` 执行独立 Reviewer，并用相同 `turnToken` 通过 `smartflow_review_turn` 返回 Reviewer session 与唯一 `review.result`；Daemon 先完成无副作用校验，再原子写入 schemaVersion 2 Review/Leader evidence，并按三态计划推进全部 Issue repair、额度暂停或 Publish。
5. 收到 repair-limit 或 operational `USER_INPUT_REQUIRED` 后，只有 Host 与用户交互，并用相同 `turnToken` 通过 `smartflow_review_turn` 提交列出的合法 answer；Review payload 校验失败不进入该状态，`DONE` 必须只对应终态 `result`。
6. Publish 使用预期 HEAD 和原子 Git 操作写回原始项目；冲突和恢复阻塞必须 durable pause。
7. 契约测试 MUST 覆盖唯一 ReviewResult 模型、enabled Task 精确覆盖、三态决策、全量 Issue repair、预写入拒绝、四公开状态、路径保护、恰好六个公开工具、Host-turn ownership、restart/CAS/renew/deadline、15 轮额度和两工具 production composition。
8. Mocked Pi Extension/RPC 测试不能替代真实 pinned SDK 兼容和经用户授权的 real-model E2E 证据；未验证项必须保持开放。

## Governance

- 本 Constitution 优先于普通设计文档、实现便利性与历史兼容性。
- 修改原则必须同步更新受影响的 spec、plan、contracts、tasks、quickstart、追踪矩阵与根设计索引。
- 版本规则：移除或不兼容地重定义原则为 MAJOR；新增原则或实质扩展为 MINOR；措辞澄清为 PATCH。
- 4.0.0 明确废弃 OpenCode/Claude Worker、ToolExecutionBroker、工具效果账本、Worker 工具审批流及其持久化状态；旧状态不保证原地兼容。
- 4.1.0 明确采用 Daemon-owned mechanical orchestration、单一复合 Review turn、Host-only Reviewer/user boundary 与 durable Host-turn ownership。
- 5.0.0 的公开 MCP surface 恰好为六个工具；`HostActionLoop` symbol 与五个 manual Review orchestration MCP names 的公开 symbols、schemas、handlers、registrations、aliases 均不存在，对应 Review mechanics 仅为 Daemon internal；唯一 ReviewResult 与 schemaVersion 2 Review/Leader artifacts 作为同一现行契约维护，不另行虚构 Data Directory format。
- 合并前 MUST 运行 Spec Kit 一致性分析；若 Constitution 与实现计划冲突，以 Constitution 为准并阻止实现。

**Version**: 5.0.0 | **Ratified**: 2026-07-20 | **Last Amended**: 2026-08-12
