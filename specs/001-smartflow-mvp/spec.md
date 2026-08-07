<!-- Authoring artifact only. SmartFlow runtime must not depend on Spec Kit or this file. -->

# SmartFlow MVP Feature Specification

**Feature ID**: `001-smartflow-mvp`  
**Feature Branch**: `001-smartflow-mvp`  
**Status**: Current  
**Version**: 4.0.0  
**Created**: 2026-07-20  
**Last Updated**: 2026-08-05
**Input**: Replace the OpenCode Worker and the custom file-operation Broker with `@earendil-works/pi-coding-agent`, use the MCP process configuration directly for one Pi model without `models.json`, and retain Run-scoped isolated workspaces, Leader-owned MCP/user interaction, Review, and Publish.

## Product Decision

SmartFlow 4.0 固定使用 `@earendil-works/pi-coding-agent` SDK 执行 Worker。SmartFlow 不再实现文件、搜索、编辑或 Shell Broker；Pi 直接使用官方 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具。

安全边界从“逐工具审批”简化为“整个进程强制隔离”：Pi Worker 及其子进程运行在 OS sandbox 中，项目与用户数据只能访问当前 Run 的 isolated workspace；运行所需 Node.js、系统库和 Pi SDK 路径只读。Pi 可修改该 workspace 内任意项目文件，可执行任意 Shell 命令并访问网络，但不能访问原始项目、SmartFlow 状态目录、其他 Run workspace 或宿主用户的其他文件。

Review 主线保持不变：

```text
Task → Pi Worker → Candidate → Review Action → Bound Reviewer → Leader
                                                            ├─ accept → Publish
                                                            ├─ repair → New Revision → New Pi session
                                                            └─ pause
```

Host/Leader 保留 MCP 与全部用户交互；Pi Worker 不接收 SmartFlow MCP。当前迁移不向 Pi 动态注入 Host/global Skills，但允许 Pi 使用随项目一起进入 isolated workspace 的项目本地资源。

启动 SmartFlow MCP server 时传入的环境变量是 Pi 模型配置的唯一用户来源。每个 MCP server 实例只绑定一个模型和一个 endpoint；用户明确选择该 endpoint 遵循的标准 API 协议。SmartFlow 不要求用户维护 Pi 配置文件，也不得生成或读取 `models.json`，而是在 Pi 子进程内通过官方运行时扩展接口直接注册该模型。

## User Scenarios & Testing

### User Story 1 — Leader 冻结任务并启动 Pi Run（Priority: P1）

用户向 Leader 描述目标并批准纯 Markdown `tasks.md`。Leader 启动 Run 后，Daemon 冻结任务内容与 Pi runtime config，并快速返回 `jobId`。

**Why this priority**: 这是唯一受支持的任务入口，决定后续 Worker、Review 和 Publish 是否绑定同一份批准输入。

**Independent Test**: 启动 Run 后修改源 `tasks.md`，确认当前 Run 的 TaskManifest、Pi 输入和 Reviewer 输入保持不变。

**Acceptance Scenarios**:

1. **Given** 用户尚未批准任务，**When** Leader 准备执行，**Then** 不得调用 `smartflow_execute`。
2. **Given** 用户已批准任务，**When** Leader 启动 Run，**Then** Daemon 保存规范化任务路径、不可变任务 Artifact、`tasksSha256` 和 `providerRuntimeConfigHash`。
3. **Given** Run 已启动，**When** 源任务文件发生变化，**Then** 当前 Revision 继续使用启动时冻结的内容。
4. **Given** Pi runtime 配置缺失或哈希漂移，**When** Worker 准备启动或恢复，**Then** Run 明确暂停或失败，不选择其他 Worker、API 或模型。
5. **Given** MCP server 提供一个合法 API、Base URL、模型和 API Key，**When** Daemon 冻结 Worker 配置，**Then** 当前 Revision 只绑定该模型及其非敏感运行参数，凭据明文不进入 Manifest、状态或日志。
6. **Given** MCP 配置未提供上下文、最大输出、思考级别或 Attempt deadline，**When** 配置被解析，**Then** 分别使用 `1000000`、`384000`、`high` 和 `1800000ms`。
7. **Given** 旧 OpenCode/间接凭据字段或 unsupported API 值，**When** MCP server 启动，**Then** 配置被明确拒绝，且不会读取旧字段或回退到其他配置来源。

---

### User Story 2 — Pi 在 isolated workspace 内直接完成任务（Priority: P1）

Pi Coding Agent SDK 在当前 Run 的 isolated workspace 中运行，直接使用官方 coding tools 修改项目。SmartFlow 只负责进程隔离、生命周期和事件归一化，不代理 Pi 的文件操作。

**Why this priority**: 这是替换 OpenCode 和彻底移除 Broker 的核心价值。

**Independent Test**: 让 Pi 执行包含读、写、搜索、删除、Shell 和网络访问的任务；确认 workspace 内操作成功，同时对原始项目、SmartFlow 状态目录和其他 Run workspace 的访问全部失败。

**Acceptance Scenarios**:

1. **Given** Run 已创建 isolated workspace，**When** Pi 读取、编辑、新建或删除其中任意项目文件，**Then** 操作由 Pi 官方工具直接完成，不经过 SmartFlow Broker。
2. **Given** Pi 运行 Shell 命令，**When** 命令访问 workspace 内文件、启动子进程或访问网络，**Then** Sandbox 允许执行。
3. **Given** Pi 或其子进程尝试访问原始项目、SmartFlow 状态目录、其他 Run workspace 或其他宿主用户数据，**When** 系统调用发生，**Then** OS sandbox 拒绝访问；运行所需 Node/系统库/Pi SDK 仅可只读 bootstrap。
4. **Given** Pi 正在修改 isolated workspace，**When** Publish 尚未执行，**Then** 原始项目 Worktree、index 和 refs 保持不变。
5. **Given** Pi 完成或停止，**When** Daemon 生成 Candidate，**Then** Pi 运行时目录和临时会话内容不进入 Candidate。
6. **Given** OpenCode、Claude Provider 或 Broker 代码仍存在于运行组合中，**When** 启动 Pi Run，**Then** 4.0 架构验收失败。
7. **Given** Run 正在执行或已经形成 Artifact，**When** MCP、API、UI 或日志返回状态，**Then** 只暴露逻辑 ID、项目相对路径和受控 Artifact 引用，不暴露 workspace、状态目录或 session 的真实绝对路径。

---

### User Story 3 — Reviewer 审查累计 Candidate，Leader 决定下一步（Priority: P1）

Pi Worker 完成后生成不可变 Candidate。Host 创建或恢复绑定 Reviewer，Reviewer 对当前 Revision 的完整结果和累计变更负责，Leader 最终选择 accept、repair 或 pause。

**Why this priority**: Pi 只负责实现；Review 和用户决策边界不能因 Provider 迁移而改变。

**Independent Test**: 完成首轮和一轮 repair，确认 Reviewer 绑定保持不变、每轮读取最新完整结果，Leader 未 accept 前不发布。

**Acceptance Scenarios**:

1. **Given** 有效 Candidate 已形成，**When** Review Action 创建，**Then** 它绑定当前任务、Revision、Candidate 和全部 changed paths。
2. **Given** 首轮 Review，**When** Host 处理 Action，**Then** 创建独立 Reviewer session；后续 Revision 恢复同一 Reviewer session。
3. **Given** Reviewer 返回 `REQUEST_CHANGES` 或路径覆盖不完整，**When** Leader 提交 accept，**Then** 协议拒绝。
4. **Given** Leader 选择 repair，**When** 修复项有效且范围已批准，**Then** 创建新 Revision，并从上一 Result Snapshot 启动新的 Pi session。
5. **Given** Reviewer 已批准，**When** Leader 仍不满意，**Then** Leader 可提交结构化 RepairItem 开始新 Revision。

---

### User Story 4 — Leader 安全发布或取得交付包（Priority: P1）

只有当前 Review 可接受且 Leader 明确 accept 后，SmartFlow 才尝试把 Candidate 写回原始项目。

**Why this priority**: Publish 是 isolated workspace 与用户真实项目之间唯一允许的写入通道。

**Independent Test**: 分别测试无冲突发布、相关路径漂移和写回能力不足，确认结果为 committed、零写入 conflict 或 DeliveryBundle。

**Acceptance Scenarios**:

1. **Given** 当前 Review 可接受且 Leader accept，**When** 发布前 Hash 与 expected HEAD 均匹配，**Then** Candidate 通过项目级串行临界区写回。
2. **Given** Candidate 涉及的原始项目路径已漂移，**When** 发布，**Then** 返回 `PRECHECK_CONFLICT`、冲突路径和 `0/N`，且零写入。
3. **Given** Adapter 无法证明原子批量写回，**When** 发布，**Then** 生成 Patch/DeliveryBundle，不修改原始项目。
4. **Given** Publish 返回 PARTIAL 或 UNKNOWN，**When** 状态落盘，**Then** 进入 `PUBLISH_RECOVERY_BLOCKED`，不得伪报 completed。

---

### User Story 5 — 同一 Task 可重连和恢复，新功能创建新 Task（Priority: P1）

用户或 Host 可以在长任务期间离开并重新进入。Leader 根据用户消息是否仍属于同一 Task，决定继续当前 Run/Revision，还是创建新的 Task/Run。

**Why this priority**: Pi session 不是业务事实；用户可恢复的对象必须是 Task、Revision、workspace 和持久化状态。

**Independent Test**: 覆盖 Host 重连、Worker 崩溃、Attempt 超时、repair 新 Revision和新功能，确认 session 创建规则、进程树终止和 workspace 绑定正确。

**Acceptance Scenarios**:

1. **Given** Daemon 和 Pi Worker 仍存活，**When** Host 断开后重连同一 Task，**Then** 继续同一 job、attempt 和 Pi session。
2. **Given** Pi Worker 或 Daemon 崩溃且状态可恢复，**When** 恢复同一 Revision，**Then** 使用同一 job、Revision 和 isolated workspace 创建新的 attempt/Pi session。
3. **Given** Leader批准同一 Task 的 repair 或补充并创建新 Revision，**When** Worker 启动，**Then** 从上一 Result Snapshot 创建新的 Pi session。
4. **Given** 用户提出独立新功能，**When** Leader 分类请求，**Then** 创建新的 Task/Run/Pi session，不复用旧 Run。
5. **Given** 用户取消 Run，**When** Daemon 执行取消，**Then** Pi Worker 及全部子进程被终止，状态和 lease 完成对账。
6. **Given** Pi Attempt 超过冻结的运行时限，**When** deadline 到达，**Then** Daemon 终止完整进程树，将 Attempt 持久化为 `TIMED_OUT`，并把 Run 置为可由 Leader 重试、创建新 Revision 或取消的 `PAUSED`；停止事实不可证明时保持恢复阻塞。

## Review and Repair Rules

### Reviewer submission

```ts
interface ReviewSubmission {
  verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCKED";
  completionPercentage: number;
  convergeFindings: Finding[];
  adversarialFindings: Finding[];
  pathCoverage: Record<string, "FULL" | "MISSING">;
  residualRisks: string[];
}
```

Finding fingerprint 由 Daemon 根据稳定字段重算。自然语言摘要不参与 fingerprint。

### Repair item

```ts
type RepairItem =
  | { source: "reviewer"; findingFingerprint: string }
  | {
      source: "leader";
      code: string;
      taskId: string;
      path: string | null;
      reason: string;
    };
```

Reviewer 来源必须指向当前 Review finding。Leader 来源必须绑定当前任务范围；空原因、未知任务和越界路径必须拒绝。

### Leader decision matrix

| 当前 Review | `accept` | `repair` | `pause` |
|---|---:|---:|---:|
| `APPROVE` + FULL + 无 blocker | 允许 | 允许 | 允许 |
| `REQUEST_CHANGES` | 禁止 | 允许 | 允许 |
| `BLOCKED` | 禁止 | 允许 | 允许 |
| 任一路径 MISSING | 禁止 | 允许 | 允许 |
| Artifact/Hash/session 不匹配 | 禁止 | 禁止 | 系统暂停 |

## Requirements

### Functional Requirements

#### Task and configuration

- **FR-001**：当前 Host 强模型 MUST 是唯一 Leader；用户审批和结果交互 MUST 只经过 Leader。
- **FR-002**：Daemon MUST 规范化批准任务文件路径并冻结不可变 TaskSourceArtifact；运行后不得从源文件重新读取任务内容。
- **FR-003**：TaskManifest MUST 绑定 `runId`、`revisionId`、`tasksSha256`、任务 Artifact 和 `providerRuntimeConfigHash`。
- **FR-004**：Worker Provider MUST 固定为 `@earendil-works/pi-coding-agent` SDK；不得 fallback 到 OpenCode、Claude Agent SDK 或其他 Provider。
- **FR-005**：Pi 模型、API、Base URL、凭据和 runtime 参数 MUST 只来自启动 SmartFlow MCP server 时传入的环境配置，不得写入 Task 正文、从用户级 Pi 配置发现或从其他来源回退。

#### Pi Worker and containment

- **FR-006**：每个 Revision MUST 使用从 Git Tree 物化的独立 workspace；不得使用用户仓库的 index、refs 或 `git worktree add`。
- **FR-007**：Pi Worker 进程及其子进程 MUST 在 fail-closed OS sandbox 中运行；缺少支持的 Sandbox adapter 时不得启动 Worker。
- **FR-008**：Sandbox MUST 允许 Pi 在当前 isolated workspace 内读写任意项目文件、运行任意 Shell 命令和访问网络。
- **FR-009**：Sandbox MUST 拒绝 Pi 访问原始项目、SmartFlow 状态目录、其他 Run workspace 和其他宿主用户数据；运行所需 Node/系统库/Pi SDK 仅可只读 bootstrap。
- **FR-010**：Pi MUST 直接使用官方 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具；SmartFlow MUST NOT 实现 ToolExecutionBroker、自建文件操作、效果账本或逐工具审批。
- **FR-011**：SmartFlow MUST 通过 Pi SDK 的可编程会话/RPC 能力驱动 Worker，并将 SDK 事件归一化为现有 Worker 生命周期事件。
- **FR-012**：Host/Leader MUST 保留 SmartFlow MCP；Pi Worker MUST NOT 接收该 MCP server，也不得直接等待用户输入。
- **FR-013**：当前迁移 MUST NOT 动态注入 Host/global Skills；项目本地资源只有在已包含于 isolated workspace 时才可被 Pi 使用。
- **FR-014**：Pi runtime/session 临时内容 MUST 位于 Run workspace 的专用区域，并在 Candidate 快照前清理或排除。

#### Candidate, review and repair

- **FR-015**：正式 Candidate MUST 表示 Run Baseline 到当前 Result Snapshot 的累计差异，并绑定 Revision、TaskManifest、baseline/input/result Snapshot、规范化操作、全部 changed paths 和 evidence Artifact Hash。
- **FR-016**：Candidate 为空时，只有任务明确允许 no-change 才可继续。
- **FR-017**：有效 Candidate MUST 直接产生绑定当前 Hash 与全部 changed paths 的 Review Action。
- **FR-018**：首轮 MUST 创建独立 Reviewer session；后续 Revision MUST 恢复同一 Reviewer session。
- **FR-019**：Reviewer 每轮 MUST 重读冻结任务与最新完整 Result Workspace；最终 verdict MUST 覆盖累计 Candidate。
- **FR-020**：Reviewer 结果 MUST 返回 Leader；Reviewer 未通过或路径覆盖不完整时 Leader MUST NOT accept。
- **FR-021**：Leader repair MUST 包含至少一个合法 RepairItem，并创建新 Revision；新 Revision 以上一 Result Snapshot 为输入并创建新的 Pi session。
- **FR-022**：无进展观测 MUST NOT 在 15 个自动返工轮次额度耗尽前提前暂停；额度耗尽后 MUST 保留 Candidate 并暂停等待用户决定是否继续下一组 15 轮。

#### State, recovery and publish

- **FR-023**：Daemon MUST 承载后台长任务；MCP mutation MUST 快速返回，`state.json` MUST 是唯一恢复事实。
- **FR-024**：同一规范化任务路径同时最多一个 Active Run；不同任务文件 MAY 并行，但状态与 workspace MUST 按 job 隔离。
- **FR-025**：每次 Worker 执行 MUST 持久化 `attemptId`、Pi session 标识、Sandbox containment 标识、generation 和 Revision 绑定。
- **FR-026**：Host 重连且 Worker 存活时 MUST 继续同一 Pi session；进程崩溃恢复同一 Revision 时 MUST 创建新 attempt/Pi session；新 Revision MUST 创建新 Pi session。
- **FR-027**：取消 MUST 终止 Pi Worker 及全部子进程，对账进程和 Action 后再进入终态。
- **FR-028**：发布 MUST 要求当前 Review 可接受且 Leader 明确 accept，并在项目级串行临界区执行。
- **FR-029**：自动写回 MUST 支持 expected-old-hash、稳定 operationId、结果查询和严格 `atomicBatchCas` 或本地 `preflightBatchWrite`；否则只能生成 DeliveryBundle。
- **FR-030**：发布冲突 MUST 对全部 Candidate 路径原子零写入，并返回冲突路径、`0/N`、`activeWorkspaceChanged=false` 和 Patch/DeliveryBundle。
- **FR-031**：PARTIAL 或 UNKNOWN MUST 进入 `PUBLISH_RECOVERY_BLOCKED`；不得转换为 completed 或自动重试。
- **FR-032**：SmartFlow MAY 在自身 Data Dir 中执行 Git object/index/tree 操作，但 MUST NOT 自动 commit、push、merge、reset、clean、checkout、回滚或删除用户改动。
- **FR-033**：Git capability probe MUST NOT 检测或阻断 Git LFS、`.gitattributes` 或自定义 `clean`、`smudge`、`process` filter；workspace 内容 MUST 按普通文件流程读写。
- **FR-034**：终态对账后 MUST 清理临时 workspace、Pi runtime/session 临时内容、index 和 object store，同时保留可验证的审计 Artifact、Patch/DeliveryBundle 和结果事实。
- **FR-035**：运行中的 workspace、SmartFlow 状态和 Pi session 真实绝对路径 MUST NOT 通过 MCP、API、UI 或日志暴露；对外只允许逻辑 ID、项目相对路径与受控 Artifact 引用，Finalize 后的 Artifact 仍不得泄露内部绝对路径。
- **FR-036**：每个 Pi Attempt MUST 使用 MCP server 环境配置中冻结的运行时限；超时 MUST 终止 Pi 及全部子进程、持久化 `TIMED_OUT` 并进入可恢复 `PAUSED`，且在进程停止得到证明前不得生成 Candidate 或启动替代 Attempt。

#### MCP Pi model configuration

- **FR-037**：每个 MCP server 实例 MUST 只绑定一个 Pi 模型；必填环境字段 MUST 是 `SMARTFLOW_PI_API`、`SMARTFLOW_PI_BASE_URL`、`SMARTFLOW_PI_MODEL` 和 `SMARTFLOW_PI_API_KEY`。
- **FR-038**：`SMARTFLOW_PI_API` MUST 只接受 `openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai`；供应商只要遵循所选标准协议即可使用，不得把 Worker Provider 与 API 协议混为同一配置字段。
- **FR-039**：`SMARTFLOW_PI_CONTEXT_WINDOW`、`SMARTFLOW_PI_MAX_TOKENS`、`SMARTFLOW_PI_THINKING` 和 `SMARTFLOW_PI_ATTEMPT_DEADLINE_MS` MUST 可选，并分别默认 `1000000`、`384000`、`high` 和 `1800000ms`；`maxTokens` 不得大于 `contextWindow`。
- **FR-040**：SmartFlow MUST 将已校验的 MCP 配置直接传入 isolated Pi 子进程，并通过 Pi 官方运行时扩展接口在内存中注册该模型；MUST NOT 生成、读取或要求用户提供 `models.json`，也不得读取宿主用户级 Pi 模型配置。
- **FR-041**：API Key MUST 只存在于 MCP/Daemon/Pi 子进程内存和子进程环境中，不得进入 argv、runtime config hash、Manifest、Run 状态、session、Artifact、日志或错误文本；Daemon MAY 仅以不可逆摘要检测凭据轮换。

### Key Entities

| 实体 | 作用 | 核心绑定 |
|---|---|---|
| TaskSourceArtifact | 启动时冻结的任务文件内容 | canonical task path + source Hash |
| TaskManifest | 当前任务与 Pi 运行配置快照 | Run + Revision + task/config Hash |
| PiRuntimeConfiguration | MCP server 冻结的单模型非敏感运行参数 | API + Base URL + model + context/output/thinking/deadline |
| RunBaselineSnapshot | Run 启动时不变的项目快照 | Project + Tree/Artifact Hash |
| RevisionSnapshot | 某轮输入或结果的不可变 Tree | Run + Revision + Tree/Artifact Hash |
| PiWorkerAttempt | 一次 Sandbox 内 Pi 执行 | Revision + attempt + Pi session + containment |
| PiSessionArtifact | 完成或中断后保留的会话证据 | attempt + session metadata/artifact Hash |
| Candidate | Baseline 到当前结果的累计差异 | Revision + snapshots + canonical ops + evidence Hash |
| RevisionPatch | 相邻 Revision 的修复证据 | previous result + current result |
| ReviewAction | Host 待处理审查动作 | Review attempt + Candidate |
| ReviewerBinding | 闭环唯一 Reviewer session | Run + first reviewer session ID |
| ReviewDecision | Reviewer 的结构化结果 | Action + ReviewBundle + Reviewer session |
| RepairItem | Reviewer 或 Leader 的修复输入 | current finding 或 code/task/path/reason |
| LeaderDecision | accept / repair / pause | current Review |
| PublishResult | CAS 写回或 Bundle 事实 | Candidate + Review + LeaderDecision |
| ActiveTaskBinding | 防止同一任务文件重复启动 | canonical task path + jobId + terminal state |

## Edge Cases

- 同一任务文件通过相对路径、绝对路径或符号链接重复启动：规范化为同一 key，返回 `TASK_ALREADY_ACTIVE`。
- 不同任务文件并发修改同一路径：允许执行；先发布者成功，后发布者在 Publish 临界区内零写入冲突。
- Pi 修改 `tasks.md`、`.specify` 或其他项目内受限文件：只要路径位于 isolated workspace 即允许；修改不改变已冻结的 TaskManifest。
- Pi 尝试使用绝对路径、符号链接、子进程或 Shell 绕出 workspace：OS sandbox 拒绝。
- Pi Shell 运行项目 test、lint、build：允许；结果可供 Pi 使用，但 SmartFlow 不新增独立 verify/gate 阶段。
- Pi、SDK error、stack trace 或 Shell 输出包含 workspace/runtime 绝对路径：对外返回和持久化日志必须替换为逻辑 ID 或项目相对路径。
- Pi session 无法恢复：废弃旧 attempt；同一 Revision 和 workspace 创建新 attempt/session，不切换 Worker、API 或模型。
- Pi 或其子进程超过 Attempt deadline：终止整个 containment，持久化 `TIMED_OUT`；无法证明进程已停止时不得重试。
- MCP 配置选择的 API 与 endpoint 实际协议不一致：Pi 启动或首个请求明确失败，不尝试其他协议。
- MCP 未覆盖模型能力参数：按 1M context、384K max output、推理 `high` 注册；目标模型限制更低时，用户必须在同一 MCP 配置中显式覆盖。
- MCP 配置仍包含 `SMARTFLOW_WORKER`、`SMARTFLOW_MODEL_*`、`SMARTFLOW_PI_PROVIDER` 或 `SMARTFLOW_PI_CREDENTIAL_ENV`：不得作为有效配置读取。
- Pi 或宿主用户目录存在 `models.json`：当前 Run 不得读取；Run workspace 内也不得生成该文件。
- Host 无法恢复绑定 Reviewer：进入 `HOST_REVIEW_UNAVAILABLE`。
- 旧 Review 或迟到提交作用于新 Revision：协议拒绝。
- Artifact 缺失或 Hash 错误：进入 `INTEGRITY_BLOCKED`。
- 无法证明 Pi 进程树已停止：保持暂停，不生成 Candidate 或进入终态。
- 自动写回返回 PARTIAL 或 UNKNOWN：进入 `PUBLISH_RECOVERY_BLOCKED`，保留逐路径事实。

## Success Criteria

### Measurable Outcomes

- **SC-001**：一条纯 Markdown Task 可完成 Leader → Pi Worker → Candidate → Review → Leader → Publish 闭环。
- **SC-002**：验收矩阵中的 read、search、add、modify、delete、Shell、network 七类操作在 isolated workspace 内全部成功（7/7），经 SmartFlow Broker 处理的操作数为 0。
- **SC-003**：Pi 或任一子进程对原始项目、SmartFlow 状态目录、其他 Run workspace 的成功访问数为 0。
- **SC-004**：Publish 前原始项目 Worktree、index 和 refs 的变更数为 0。
- **SC-005**：Worker 运行组合中的 OpenCode、Claude Worker、ToolExecutionBroker 和效果账本引用数为 0。
- **SC-006**：Host 重连且 Worker 存活时新增 Pi session 数为 0；崩溃恢复或新 Revision 时恰好创建一个新 attempt/Pi session。
- **SC-007**：同一任务文件 Active Run 的重复启动成功数为 0；不同任务文件可并行进入 Active 状态。
- **SC-008**：Reviewer 未通过或路径覆盖不完整时 accept 成功数为 0；每个修复闭环只绑定一个 Reviewer session。
- **SC-009**：相关路径发布冲突时原始项目写入数为 0，并返回完整冲突路径和 `0/N`。
- **SC-010**：取消和崩溃恢复不产生重复 Candidate、Review Action 或 Publish，且每个 Attempt 均可追溯到 Revision、Pi session 和 containment。
- **SC-011**：使用已知绝对路径 canary 扫描 MCP、API、UI payload、日志和 Finalize Artifact，内部 workspace、状态目录和 session 绝对路径泄露数为 0。
- **SC-012**：Pi Attempt 超时后存活的 containment 进程数为 0、持久化的 `TIMED_OUT` Attempt 数为 1，且在 Leader 明确恢复前新 Candidate 和替代 Attempt 数均为 0。
- **SC-013**：四个受支持 API 值分别可将一个 MCP 配置模型注册到 Pi；每个 MCP server 实例可用模型数恰好为 1，Provider/模型 fallback 次数为 0。
- **SC-014**：未提供可选模型参数时，冻结配置中的 context、max output、thinking 和 deadline 分别为 `1000000`、`384000`、`high`、`1800000ms`；合法覆盖值在同一 Revision 内保持不变。
- **SC-015**：运行、恢复、取消和 Finalize 后扫描 workspace、Data Dir、argv、状态、session、Artifact 与日志，`models.json` 生成/读取次数为 0，API Key 明文泄露数为 0。

## Assumptions

- 首个支持平台为 macOS，沿用项目现有 Darwin `ExecutionSandboxAdapter`；没有等价 adapter 的平台 fail closed。
- Pi Coding Agent SDK 的依赖版本在实现时固定到已验证的 published version；运行环境满足该版本的 Node.js 要求。
- MCP server 环境配置是唯一模型配置来源；每个实例只使用一个 API endpoint、一个模型和 API Key 认证，不由 Task 文件或 Worker 向用户索取。
- 自定义 endpoint 必须遵循所选的四种标准 API 协议之一；OAuth、云厂商专用身份链和非标准流式协议不在本次范围。
- 未显式覆盖时，模型按 1M context、384K max output、支持推理且默认 `high` 注册；限制更低的模型由 MCP 配置覆盖能力值。
- Pi Attempt 运行时限来自 MCP server 环境配置，并计入 `providerRuntimeConfigHash`；Task 正文不能修改该时限。
- Git-backed Snapshot、Review 和 Publish 的现有契约继续有效，除非本规范明确修改。
- 项目本地 Skills/资源是否启用由 Pi 自身资源加载规则决定；动态 Host/global Skill 注入不属于本次迁移。

## Out of Scope

- 自建文件/Shell/搜索 Broker、工具效果审批、工具效果账本和 Worker 人工 tool-decision 流程；
- OpenCode、Claude Agent SDK、多模型 profile、模型/API fallback 或跨模型会话迁移；
- OAuth、订阅登录、AWS Bedrock、Google ADC、Azure 专用身份链和不兼容四种标准 API 的自定义协议；
- 用户维护、SmartFlow 生成或 Pi 从宿主/Run 目录读取 `models.json`；
- 把 SmartFlow Host MCP 或运行时动态 Skills 注入 Pi Worker；
- 新增独立 test/lint/build verify/gate 阶段；
- 第二个 Leader、Worker 自审、Reviewer 或 Pi 直接与用户交互；
- 自动 Git commit/push/PR、回滚或删除用户改动；
- 分布式调度、跨机器任务锁、路径预占、自动合并和并行 Publish；
- Linux/Windows Sandbox adapter、外部数据库和 GUI 管理后台。
