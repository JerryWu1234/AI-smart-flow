<!-- Authoring artifact only. SmartFlow runtime must not depend on Spec Kit or this file. -->

# SmartFlow MVP Feature Specification

**Feature ID**: `001-smartflow-mvp`
**Feature Branch**: `001-smartflow-mvp`
**Status**: Current
**Version**: 4.1.0
**Created**: 2026-07-20
**Last Updated**: 2026-08-11
**Input**: Preserve the sandboxed Pi Worker and safe Candidate/Publish design while adopting Solution D: Daemon-owned deterministic orchestration behind the sole public `smartflow_review_turn` continuation API, with Host-only Reviewer execution and user interaction.

## Product Decision

SmartFlow 4.1 固定使用 `@earendil-works/pi-coding-agent` SDK 执行 Worker。SmartFlow 不实现文件、搜索、编辑或 Shell Broker；Pi 直接使用官方 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具。

安全边界是整个进程的强制隔离：Pi Worker 及其子进程运行在 OS sandbox 中，项目与用户数据只能访问当前 Run 的 isolated workspace；运行所需 Node.js、系统库和 Pi SDK 路径只读。Pi 可修改该 workspace 内任意项目文件，可执行 Shell 与网络访问，但不能访问原始项目、SmartFlow 状态目录、其他 Run workspace 或宿主用户数据。

Review 主线采用方案 D：

```text
Host: smartflow_execute
→ Daemon: Pi Worker → Candidate → Review Action
→ Host: smartflow_review_turn
   ├─ NOT_READY → bounded poll
   ├─ REVIEW_REQUIRED → Host CREATE/RESUME independent Reviewer
   │                    → submit same turnToken
   │                    → Daemon deterministic policy:
   │                       ├─ 100% valid → accept → Publish
   │                       ├─ actionable incomplete + budget → repair Revision
   │                       ├─ invalid/no guidance → USER_INPUT_REQUIRED
   │                       └─ 15 rounds reached → USER_INPUT_REQUIRED
   ├─ USER_INPUT_REQUIRED → Host asks user and submits typed answer
   └─ DONE → terminal canonical result
```

Host/Leader 保留 MCP、独立 Reviewer 的创建/恢复与全部用户交互；Daemon 在内部承担 bounded poll、原子 Review begin/finalize、确定性 accept/repair/pause、同范围 repair 与 Publish 的机械编排。Daemon 不创建 Reviewer，不解释开放式用户意图，也不得扩大批准范围。Pi Worker 不接收 SmartFlow MCP。当前迁移不动态注入 Host/global Skills，但允许 Pi 使用已进入 isolated workspace 的项目本地资源。

`smartflow_execute → smartflow_review_turn*` 是唯一公开 Review 编排路径，复合 turn 只返回 `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`。公共 MCP surface 恰好六个工具：`smartflow_execute`、`smartflow_review_turn`、`smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result`；后四者是独立 Run management APIs，不是 Review continuation 或第二条 Review 编排路径。公开 `smartflow_resume` 只用于独立 paused-Run recovery；active `hostTurn` 的 `USER_INPUT_REQUIRED` answer 必须由 owning Host 携带相同 `turnToken` 通过 `smartflow_review_turn` 提交，不能借该 API 代答或绕过 ownership。旧 wait/claim/renew/submission/Leader primitive symbols、schemas、handlers、registrations、aliases 均不存在；Review begin 与 Review-plus-decision finalize 各自是一个 Daemon domain operation。Durable `AWAITING_REVIEW` 的 `REVIEW_REQUIRED` 向 owning Host 暴露 Reviewer `worktreePath`；发布相关 `USER_INPUT_REQUIRED` 也可向同一 owner 提供已审核 Candidate worktree，以支持外部人工合并，但不得披露原项目或状态目录路径。

启动 SmartFlow MCP server 时传入的环境变量仍是 Pi 模型配置唯一用户来源。每个 MCP server 实例绑定一个模型和 endpoint；SmartFlow 不生成或读取 `models.json`，而在 Pi 子进程内通过官方 Extension 接口注册模型。

Current decision details are normative in [adr-daemon-owned-review-turn.md](adr-daemon-owned-review-turn.md), [contracts/review-turn.md](contracts/review-turn.md), and [implementation-map.md](implementation-map.md). The historical Host-orchestration ADR is superseded.

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

### User Story 3 — Host 执行 Reviewer，Daemon 自动编排闭环（Priority: P1）

Pi Worker 完成后生成不可变 Candidate。Host 通过 `smartflow_review_turn` 获得已原子绑定的 Review 请求，创建或恢复绑定 Reviewer 并提交结果；Daemon 随后按冻结策略自动 accept/repair/pause，Host 不重建 Daemon-internal Review 状态机。

**Why this priority**: Reviewer 独立性、用户交互边界和机械编排持久性必须同时成立；任一方职责混淆都会造成重复副作用、部分状态或第二个用户 Leader。

**Independent Test**: 只在 Host 高层调用 `smartflow_execute` 与 `smartflow_review_turn`，完成首轮 Review、Daemon restart、一轮自动 repair、Reviewer RESUME 和最终 Publish；确认 Reviewer path 只在 durable `AWAITING_REVIEW` 响应中出现，而发布暂停只向 owning Host 提供已审核 Candidate worktree。

**Acceptance Scenarios**:

1. **Given** Worker 尚未产生当前 Review Action，**When** Host 调用复合 turn，**Then** 返回无 `worktreePath` 的 `NOT_READY` 与 bounded `retryAfterMs`。
2. **Given** 当前 Candidate 已产生，**When** Daemon 在一次 CAS mutation 中验证 context 并持久化 `REVIEWING + AWAITING_REVIEW`，**Then** 返回 `REVIEW_REQUIRED`、稳定 `turnToken`、完整 changed paths、deadline 和首轮 `CREATE`/后续 `RESUME`。
3. **Given** Host 收到 `REVIEW_REQUIRED`，**When** 执行 Reviewer，**Then** Reviewer session 与 Pi session 分离，每轮重读同步 Task、最新完整 Result Workspace 和累计 Candidate。
4. **Given** Review 为 `APPROVE + 100% + no blocker`，**When** Host 用同一 token 提交，**Then** Daemon 自动 accept 并进入 Publish，不存在需要 Host 调用的独立 public decision handler。
5. **Given** Review 不完整且包含 blocking findings，**When** 当前自动 repair 轮次少于 15，**Then** Daemon 只使用当前 finding fingerprints 创建同范围新 Revision，并由新 Pi session 实现、原 Reviewer RESUME。
6. **Given** Review 不完整但没有 actionable blocking finding，**When** Daemon 规划下一步，**Then** durable pause 为 `INVALID_REVIEW`，复合 turn 返回 `USER_INPUT_REQUIRED` 且只允许 cancel。
7. **Given** 当前组已完成 15 个自动 repair 轮次，**When** Review 仍不完整，**Then** 保留 Candidate/Review 并返回 `AUTOMATIC_REPAIR_LIMIT`；owning Host 可携带 active `turnToken`，通过 `smartflow_review_turn` 提交 `resume_review_decision`，由 HostTurnCoordinator 原子重放 stored Review decision 并直接进入下一 repair Revision 或真实 pause。
8. **Given** 旧 token、旧 Candidate 或另一个 `hostTurnId` 提交 continuation，**When** Daemon 校验，**Then** 不产生副作用；stale continuation 只返回无路径当前状态，非 owning Host 被拒绝。

---

### User Story 4 — Daemon 在 Review 门槛后安全发布或暂停（Priority: P1）

只有当前 Review 达到 `APPROVE + 100% + FULL + no blocker` 时，Daemon 的确定性策略才可 accept 并尝试把 Candidate 写回原始项目。发布冲突、能力不足或未知结果必须 durable pause，而不是伪报 `DONE`。

**Why this priority**: Publish Adapter 是 isolated workspace 与用户真实项目之间唯一 SmartFlow-managed 写入通道；自动化不能削弱 Review 门槛、CAS 保护或结果对账。发布暂停后的人工合并是用户外部动作，SmartFlow 只确认目标状态。

**Independent Test**: 分别测试自动 accept 后的无冲突发布、相关路径漂移、adapter 能力不足、人工确认匹配/不匹配以及 PARTIAL/UNKNOWN，确认只有逐路径精确 `COMMITTED` 才完成；Host 仅使用公开 ReviewTurn，decision 与 Publish progression 均为 Daemon-internal mechanics。

**Acceptance Scenarios**:

1. **Given** 当前 Review 满足全部自动 accept 条件，**When** Daemon 发布，**Then** 重新验证 Candidate/Review/decision，使用绑定 Candidate + immutable `REVISION_RESULT` snapshot + Run Git object store 确定性派生 `ApplyOperation[]`/blob refs，获取项目级 lease，并按 expected-old kind/hash/mode 写回。
2. **Given** Candidate 涉及的原始项目路径已漂移，**When** 全路径 preflight，**Then** 在创建 `PREPARED` attempt 和第一笔写入前返回 `PRECHECK_CONFLICT`、完整冲突路径、`publishedCount=0`、`activeWorkspaceChanged=false`，并持久化 `publishPrecheck`。
3. **Given** Adapter 不存在或无法证明 expected-old CAS、batch、stable operation ID、result query，**When** 发布，**Then** 不修改原项目、不创建 publish attempt，并进入 `PUBLISH_ADAPTER_UNAVAILABLE`；owning Host 的 `USER_INPUT_REQUIRED` 提供已审核 Candidate 的 `worktreePath` 以及 `retry_publish | confirm_manual_publish | cancel`。
4. **Given** `PRECHECK_CONFLICT` 或 adapter unavailable 后用户从该 worktree 人工合并已审核结果，**When** owning Host 提交 `confirm_manual_publish`，**Then** Daemon 只读观察全部 Candidate target operations；仅在每条路径 kind/hash/mode 精确匹配时合成 `manual-confirmation-v1` 的 `COMMITTED` attempt/result 并进入 `COMPLETED`。
5. **Given** 人工合并后的任一路径仍不匹配，**When** Daemon 观察目标，**Then** 保持 `PAUSED/MANUAL_PUBLISH_TARGET_MISMATCH`、保存冲突与 `publishPrecheck`，不得把用户确认当作成功。
6. **Given** Publish 返回 PARTIAL、UNKNOWN、不可查询或 identity 不一致，**When** 状态落盘或恢复，**Then** 进入 `PUBLISH_RECOVERY_BLOCKED` 并通过 `USER_INPUT_REQUIRED` 暴露 inspection/cancel，不得伪报 `DONE`，也不得通过人工确认或其他恢复动作绕过。

---

### User Story 5 — 同一 Task 可重连和恢复，新功能创建新 Task（Priority: P1）

用户或 Host 可以在长任务期间离开并重新进入。Leader 根据用户消息是否仍属于同一 Task，决定继续当前 Run/Revision，还是创建新的 Task/Run。

**Why this priority**: Pi session 不是业务事实；用户可恢复的对象必须是 Task、Revision、workspace 和持久化状态。

**Independent Test**: 覆盖 Host 重连、Worker 崩溃、Attempt 超时、repair 新 Revision和新功能，确认 session 创建规则、进程树终止和 workspace 绑定正确。

**Acceptance Scenarios**:

1. **Given** Daemon 和 Pi Worker 仍存活，**When** Host 断开后重连同一 Task，**Then** 继续同一 job、attempt 和 Pi session。
2. **Given** Pi Worker 或 Daemon 崩溃且状态可恢复，**When** 恢复同一 Revision，**Then** 使用同一 job、Revision 和 isolated workspace 创建新的 attempt/Pi session。
3. **Given** Daemon 自动批准同范围 repair，或 Host/用户批准同一 Task 的补充 Revision，**When** Worker 启动，**Then** 从上一 Result Snapshot 创建新的 Pi session。
4. **Given** 用户提出独立新功能，**When** Host/Leader 分类请求，**Then** 创建新的 Task/Run/Pi session，不复用旧 Run。
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

### Daemon decision matrix

复合流程中的 accept/repair/pause 由 Daemon 根据已验证 Review 与 durable `autoRepairRounds` 机械规划；Host 不重复提交 decision。公开 MCP 不提供独立 Review decision 或 repair/Publish progression handler，以下操作均由 ReviewTurn 背后的 Daemon-internal mechanics 执行。

| 当前 Review / counter | 计划 | 结果 |
|---|---|---|
| `APPROVE` + 100% + FULL + 无 blocker | `ACCEPT` | 自动进入安全 Publish |
| 有 blocking findings 且 counter `< 15` | `REPAIR` | 只把当前 finding fingerprints 转为 RepairItems，新 Revision/new Pi session |
| 不完整但无 actionable blocking finding | `PAUSE_INVALID_REVIEW` | durable `INVALID_REVIEW`，只允许 cancel |
| 有 findings 且 counter `>= 15` | `PAUSE_REPAIR_LIMIT` | durable `AUTOMATIC_REPAIR_LIMIT`，等待用户是否继续下一组 |
| Artifact/Hash/session/Host ownership 不匹配 | 无计划 | 拒绝或安全暂停，不得 Publish |

Host 保留两类非机械责任：执行 `CREATE | RESUME` Reviewer，并在 `USER_INPUT_REQUIRED` 时向用户取得合法答案。对于 `resume_review_decision`，owning Host 必须携带 active `turnToken` 通过 `smartflow_review_turn` 提交；HostTurnCoordinator 内部调用 Daemon resume mechanics、重置 counter，并授予下一组最多 15 个自动 repair 轮次。

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
- **FR-020**：Host MUST 使用当前 `turnToken` 提交 Reviewer 结果；Daemon MUST 校验 Action、Revision、Task/Candidate Hash、Reviewer binding 与 changed-path coverage。Host 的职责止于 Reviewer 执行，不得在高层流程重放机械 decision。
- **FR-021**：Daemon 自动 repair MUST 包含至少一个来自当前 blocking finding fingerprint 的 RepairItem，并创建同一批准范围的新 Revision；新 Revision 以上一 Result Snapshot 为输入并创建新的 Pi session，Reviewer binding 保持不变。
- **FR-022**：每组最多自动执行 15 个 repair 轮次；无进展不得在额度耗尽前提前暂停，但无 actionable finding 的无效 Review MUST 立即进入 `INVALID_REVIEW`。额度耗尽后保留 Candidate/Review 并等待用户决定；owning Host MUST 携带 active `turnToken`，将 `resume_review_decision` 作为 `smartflow_review_turn` answer 提交，HostTurnCoordinator MUST 内部调用 Daemon resume mechanics、将 `autoRepairRounds` 重置为 0，并授予下一组最多 15 轮。

#### State, recovery and publish

- **FR-023**：Daemon MUST 承载后台长任务与方案 D 的机械编排；MCP mutation MUST 快速返回，`state.sqlite` MUST 是唯一恢复事实，唯一公开 Review continuation MUST 是 `smartflow_review_turn`。
- **FR-024**：同一规范化任务路径同时最多一个 Active Run；不同任务文件 MAY 并行，但状态与 workspace MUST 按 job 隔离。
- **FR-025**：每次 Worker 执行 MUST 持久化 `attemptId`、Pi session 标识、Sandbox containment 标识、generation 和 Revision 绑定。
- **FR-026**：Host 重连且 Worker 存活时 MUST 继续同一 Pi session；进程崩溃恢复同一 Revision 时 MUST 创建新 attempt/Pi session；新 Revision MUST 创建新 Pi session。
- **FR-027**：取消 MUST 终止 Pi Worker 及全部子进程，对账进程和 Action 后再进入终态。
- **FR-028**：发布 MUST 要求当前 Review 满足 `APPROVE + 100% + FULL + no blocker`，并由 Daemon 的确定性 `ACCEPT` 计划在项目级串行临界区执行；Host 高层不得绕过门槛或重复 accept。
- **FR-029**：Publish MUST 从当前绑定 Candidate、同 Revision 的 immutable `REVISION_RESULT` snapshot 与 Run Git object store 确定性派生 `ApplyOperation[]` 和 blob refs；自动写回 MUST 支持 expected-old kind/hash/mode、稳定 operationId、结果查询和严格 `atomicBatchCas` 或本地 `preflightBatchWrite`。能力不足 MUST 零写入、不得创建 PublishAttempt，并暂停为 `PUBLISH_ADAPTER_UNAVAILABLE`。
- **FR-030**：发布 preflight 冲突 MUST 对全部 Candidate 路径原子零写入，并返回完整冲突路径、`publishedCount=0`、`totalCount` 与 `activeWorkspaceChanged=false`，持久化 `publishPrecheck`。`PUBLISH_ADAPTER_UNAVAILABLE` 与 `PUBLISH_PRECHECK_CONFLICT` 的 owning Host `USER_INPUT_REQUIRED` MUST 提供已审核 Candidate `worktreePath` 及 `retry_publish | confirm_manual_publish | cancel`；用户外部人工合并后，`confirm_manual_publish` MUST 只读观察全部 target operations，只有 kind/hash/mode 精确匹配才 MAY 合成 `manual-confirmation-v1` 的 `COMMITTED` result，不匹配 MUST 保持 `MANUAL_PUBLISH_TARGET_MISMATCH`。
- **FR-031**：PARTIAL、UNKNOWN、不可查询结果或 publish identity 不一致 MUST 进入 `PUBLISH_RECOVERY_BLOCKED`；不得转换为 completed、自动重放、通过 `confirm_manual_publish` 或其他恢复动作绕过。
- **FR-032**：SmartFlow MAY 在自身 Data Dir 中执行 Git object/index/tree 操作，但 MUST NOT 自动 commit、push、merge、reset、clean、checkout、回滚或删除用户改动。
- **FR-033**：Git capability probe MUST NOT 检测或阻断 Git LFS、`.gitattributes` 或自定义 `clean`、`smudge`、`process` filter；workspace 内容 MUST 按普通文件流程读写。
- **FR-034**：终态对账后 MUST 清理临时 workspace、Pi runtime/session 临时内容、index 和 object store，同时保留 Task/Snapshot/Candidate/Review/automatic-decision 的可验证 Artifact references、PublishAttempt/PublishResult、必要的 precheck/recovery facts 与审计记录。
- **FR-035**：运行中的 workspace、SmartFlow 状态和 Pi session 真实绝对路径 MUST NOT 通过 MCP、API、UI 或日志暴露；对外只允许逻辑 ID、项目相对路径与受控 Artifact 引用。例外仅限 owning Host：`REVIEW_REQUIRED` 可披露 Reviewer worktree，发布相关 `USER_INPUT_REQUIRED` 可披露同一已审核 Candidate worktree；二者都不得披露原项目、StateStore 或其他 Run 路径。Finalize 后的 Artifact 仍不得泄露内部绝对路径。
- **FR-036**：每个 Pi Attempt MUST 使用 MCP server 环境配置中冻结的运行时限；超时 MUST 终止 Pi 及全部子进程、持久化 `TIMED_OUT` 并进入可恢复 `PAUSED`，且在进程停止得到证明前不得生成 Candidate 或启动替代 Attempt。

#### MCP Pi model configuration

- **FR-037**：每个 MCP server 实例 MUST 只绑定一个 Pi 模型；必填环境字段 MUST 是 `SMARTFLOW_PI_API`、`SMARTFLOW_PI_BASE_URL`、`SMARTFLOW_PI_MODEL` 和 `SMARTFLOW_PI_API_KEY`。
- **FR-038**：`SMARTFLOW_PI_API` MUST 只接受 `openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai`；供应商只要遵循所选标准协议即可使用，不得把 Worker Provider 与 API 协议混为同一配置字段。
- **FR-039**：`SMARTFLOW_PI_CONTEXT_WINDOW`、`SMARTFLOW_PI_MAX_TOKENS`、`SMARTFLOW_PI_THINKING` 和 `SMARTFLOW_PI_ATTEMPT_DEADLINE_MS` MUST 可选，并分别默认 `1000000`、`384000`、`high` 和 `1800000ms`；`maxTokens` 不得大于 `contextWindow`。
- **FR-040**：SmartFlow MUST 将已校验的 MCP 配置直接传入 isolated Pi 子进程，并通过 Pi 官方运行时扩展接口在内存中注册该模型；MUST NOT 生成、读取或要求用户提供 `models.json`，也不得读取宿主用户级 Pi 模型配置。
- **FR-041**：API Key MUST 只存在于 MCP/Daemon/Pi 子进程内存和子进程环境中，不得进入 argv、runtime config hash、Manifest、Run 状态、session、Artifact、日志或错误文本；Daemon MAY 仅以不可逆摘要检测凭据轮换。

#### Composite Review turn and daemon orchestration

- **FR-042**：批准 Run 的唯一公开 Review orchestration MUST 是一次 `smartflow_execute` 后重复调用 `smartflow_review_turn`（`smartflow_execute → smartflow_review_turn*`）；Review turn MUST 只返回 `NOT_READY | REVIEW_REQUIRED | USER_INPUT_REQUIRED | DONE`，`NOT_READY` MUST 提供 bounded `retryAfterMs`。
- **FR-043**：Daemon MUST 在内部负责 bounded poll、原子 Review begin/finalize、确定性 accept/repair/pause、已批准范围 repair continuation 与 Publish progression；Host MUST 只负责 Reviewer session 的 CREATE/RESUME 和全部用户交互，Daemon MUST NOT 创建、替换或模拟 Reviewer。
- **FR-044**：每个 active Review turn MUST 绑定 `hostTurnId + turnToken + revision`。首轮 Reviewer mode MUST 为 `CREATE`，后续 MUST 为同一 session 的 `RESUME`；同一次 CAS 已持久化 `REVIEWING + AWAITING_REVIEW` 的 `REVIEW_REQUIRED` MAY 暴露 Reviewer `worktreePath`。发布相关 pause 的 owning Host `USER_INPUT_REQUIRED` MAY 暴露已审核 Candidate worktree 以支持人工合并；其他 `NOT_READY`、stale、非发布 pause 和 `DONE` MUST 无路径。Reviewer session MUST 与当前 Pi session 分离。
- **FR-045**：Project state MUST 使用 schema version 6，并在 Run 中 durable 保存 `AWAITING_REVIEW | AWAITING_USER_INPUT`、`autoRepairRounds`、Git publish source bindings、PublishAttempt/Result 与 manual confirmation/precheck recovery facts。启动 MUST 幂等迁移可支持的 legacy v4/v5 state；无法证明 Review 或 Publish identity 的记录 MUST 安全暂停。
- **FR-046**：Daemon restart MUST 先由 Host-turn coordinator 恢复 checkpoint，再重读 fresh state；checkpoint 存在时不得并行启动 ordinary Run recovery。Review deadline MUST 是单一 30 分钟 durable timestamp；MUST NOT 维护短 claim lease 或 renewal loop。
- **FR-047**：所有 mutation MUST 使用 Project-wide stateVersion CAS；Review begin 与 finalize MUST 各自是单一 domain operation，Daemon-internal operation request IDs MUST 从稳定 turn identity 派生。Stale Review/failure/answer continuation MUST 零副作用并只返回无敏感路径的当前 `NOT_READY`。
- **FR-048**：Daemon MUST 只产生四种机械计划：`ACCEPT` 要求 `APPROVE + 100% + no blocking finding`；`REPAIR` 要求当前 blocking findings 且 `autoRepairRounds < 15`，并只使用其 fingerprints；无 actionable finding MUST `PAUSE_INVALID_REVIEW`；额度达到 15 MUST `PAUSE_REPAIR_LIMIT`。Owning Host 选择继续时 MUST 携带 active turn 的相同 `turnToken`，将 `resume_review_decision` 作为 `smartflow_review_turn` answer 提交；HostTurnCoordinator MUST 原子重放 stored Review decision、重置 allowance，并直接进入 repair 或真实 pause。
- **FR-049**：所有非终态且需要用户选择/批准的暂停 MUST 返回 typed `USER_INPUT_REQUIRED`，包含当前合法 options、inspectionOptions、canonical paused result 及必要 answer template；发布相关 pause MUST 按 FR-030/FR-044 提供已审核 Candidate worktree。`INVALID_REVIEW` MUST 只允许 cancel。`DONE` MUST 只对应 `COMPLETED | CANCELED | FAILED` 并直接包含 canonical `ResultOutput`；其形状 MUST 与独立 `smartflow_result` 响应一致，但不得通过调用该公开 API 生成，也不得代表 conflict、pause 或等待。
- **FR-050**：公共 MCP surface MUST 恰好包含六个工具：`smartflow_execute`、`smartflow_review_turn`、`smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result`。唯一公开 Review 编排路径 MUST 是 `smartflow_execute → smartflow_review_turn*`；status/resume/cancel/result MUST 是独立 Run management APIs，而不是 Review continuation 或第二条 Review 编排路径。公开 `smartflow_resume` MUST 仅作为独立 paused-Run recovery API，active `hostTurn` 存在时 MUST NOT 充当 ReviewTurn answer 或绕过 ownership。旧 wait/claim/renew/submission/Leader primitive symbols、schemas、handlers、registrations、aliases MUST NOT exist；Daemon MUST NOT 在内部重建这些 callable primitive 状态机。
- **FR-051**：真实 pinned `@earendil-works/pi-coding-agent@0.83.0` 的 exports、Extension default export/`registerProvider()` host 和 RPC model-resolution 兼容 MUST 由独立、可复现、checked-in 的 installed-package evidence 证明；mocked `registerProvider`、source-tree tests、production-composition E2E 或 gitignored transcript MUST NOT 被视为该兼容证明。

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
| ReviewAction | Daemon 待开始的审查动作 | Review attempt + Candidate + full changed paths |
| ReviewerBinding | 闭环唯一 Reviewer session | Run + first reviewer session ID |
| ReviewDecision | Reviewer 的结构化结果 | Action + synchronized task Hash + Candidate Hash + Reviewer session |
| ReviewTurn | 唯一公开 Review continuation | request/Host owner + `NOT_READY \| REVIEW_REQUIRED \| USER_INPUT_REQUIRED \| DONE` |
| HostTurnCheckpoint | Daemon 可恢复的复合 turn 内部阶段 | `hostTurnId + turnToken + revision + AWAITING_REVIEW/AWAITING_USER_INPUT` |
| AutomaticRepairBudget | 当前组自动 repair 轮次 | `autoRepairRounds`, limit 15, reset by same-token atomic stored-Review replay |
| RepairItem | 自动 repair 的当前 Reviewer finding 输入 | current finding fingerprint；不得扩大批准范围 |
| AutomaticReviewDecision | `ACCEPT \| REPAIR \| PAUSE_INVALID_REVIEW \| PAUSE_REPAIR_LIMIT` | current Review + counter + stable child request ID |
| PublishSource | 从接受证据确定性派生的写回输入 | Candidate + immutable REVISION_RESULT + Run Git object store + ApplyOperation/blobRef |
| PublishAttemptRecord | durable apply identity 与 result journal | revision + stable operationId + operationsHash + adapterId + status/result |
| PublishPrecheck | apply 前零写入冲突事实 | conflicts + publishedCount=0 + totalCount + activeWorkspaceChanged=false |
| ManualPublishConfirmation | 人工合并后的只读目标观察 | owning Host + revision/original pauseCode + exact Candidate target operations |
| PublishResult | Adapter 或 manual observation 的逐路径回执 | operationId + operationsHash + exact path status/hash/mode |
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
- 自动写回返回 PARTIAL、UNKNOWN 或不可查询结果：进入 `PUBLISH_RECOVERY_BLOCKED`，保留 stable operationId 与逐路径事实；不得转入 manual confirmation。
- `PUBLISH_ADAPTER_UNAVAILABLE` 或 `PUBLISH_PRECHECK_CONFLICT` 后用户人工合并：`confirm_manual_publish` 只观察全部 Candidate targets；任一 kind/hash/mode 不匹配都继续 `MANUAL_PUBLISH_TARGET_MISMATCH`。
- `NOT_READY`、stale continuation 或 `DONE` 试图携带 `worktreePath`：协议 Schema 拒绝。`REVIEW_REQUIRED` 只有在原子持久化 `AWAITING_REVIEW` 后可向 owning Host 提供 Reviewer worktree；发布相关 `USER_INPUT_REQUIRED` 可提供已审核 Candidate worktree，其他 pause 无路径。
- Daemon 已提交 Review begin 但响应丢失：相同 Host turn 从 durable checkpoint 重放相同 token、Review attempt、Reviewer mode、路径和 deadline，不再次 mutation。
- Daemon 在 `AWAITING_REVIEW` 时重启：恢复相同 Host owner、turn token、reviewAttempt、Reviewer session binding 和单一 deadline，不创建替代 Reviewer。
- 同一 Run 收到并发 composite turns 或 Project state CAS 冲突：per-Run queue 串行；每次 retry 重读 fresh state，最多四次，不重复副作用。
- 30 分钟 Review deadline 到达：Daemon durable pause，不启动 lease renewal、替代 Reviewer、repair 或 Publish。
- 旧 Review、failure 或 answer 携带曾经有效但当前 stale 的 token：不应用 continuation，不重新暴露 worktree，只返回当前 `NOT_READY`。
- `INVALID_REVIEW` 收到非 cancel answer：拒绝；不得把无 actionable finding 的文本猜成 RepairItem。
- 用户在 `AUTOMATIC_REPAIR_LIMIT` 选择继续：owning Host 携带 active `turnToken`，通过 `smartflow_review_turn` 提交 `resume_review_decision`；HostTurnCoordinator 原子重放 stored Review decision、重置当前组计数，并直接进入 repair 或真实 pause，不经过 transient Leader phase。
- production-composition 两工具 E2E 通过但未加载真实 installed Pi host：只能关闭 orchestration criterion，不能关闭 FR-051/SC-020。

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
- **SC-009**：相关路径发布冲突时 SmartFlow 原始项目写入数为 0，并返回完整冲突路径、`publishedCount=0`、`activeWorkspaceChanged=false`；人工合并后的目标匹配率必须为 100% 才能 `COMMITTED`，任一不匹配仍为 `PAUSED`。
- **SC-010**：取消和崩溃恢复不产生重复 Candidate、Review Action 或 Publish，且每个 Attempt 均可追溯到 Revision、Pi session 和 containment。
- **SC-011**：使用已知绝对路径 canary 扫描 MCP、API、UI payload、日志和 Finalize Artifact，内部 workspace、状态目录和 session 绝对路径泄露数为 0。
- **SC-012**：Pi Attempt 超时后存活的 containment 进程数为 0、持久化的 `TIMED_OUT` Attempt 数为 1，且在 Leader 明确恢复前新 Candidate 和替代 Attempt 数均为 0。
- **SC-013**：四个受支持 API 值分别可将一个 MCP 配置模型注册到 Pi；每个 MCP server 实例可用模型数恰好为 1，Provider/模型 fallback 次数为 0。
- **SC-014**：未提供可选模型参数时，冻结配置中的 context、max output、thinking 和 deadline 分别为 `1000000`、`384000`、`high`、`1800000ms`；合法覆盖值在同一 Revision 内保持不变。
- **SC-015**：运行、恢复、取消和 Finalize 后扫描 workspace、Data Dir、argv、状态、session、Artifact 与日志，`models.json` 生成/读取次数为 0，API Key 明文泄露数为 0。
- **SC-016**：对所有 composite turn 测试，输出种类只属于四态之一；`NOT_READY`、stale continuation、非发布 `USER_INPUT_REQUIRED` 和 `DONE` 的 `worktreePath` 出现次数为 0。已原子提交 `REVIEWING + AWAITING_REVIEW` 的 `REVIEW_REQUIRED` 恰好提供当前 Reviewer path；`PUBLISH_ADAPTER_UNAVAILABLE`、`PUBLISH_PRECHECK_CONFLICT` 与 `MANUAL_PUBLISH_TARGET_MISMATCH` 的 owning Host `USER_INPUT_REQUIRED` 恰好提供已审核 Candidate worktree，且原项目/StateStore path 泄露数为 0。
- **SC-017**：在 atomic Review begin、`AWAITING_REVIEW`、atomic finalize、direct repair decision 与等待用户输入各边界注入 restart/CAS mismatch/重复请求后，重复 Review、repair 和 Publish 次数均为 0；有效单 deadline 恢复率为 100%。
- **SC-018**：MCP Schema 与 handler registry 中工具数恰好为六，名称集合严格等于 `{ smartflow_execute, smartflow_review_turn, smartflow_status, smartflow_resume, smartflow_cancel, smartflow_result }`；`HostActionLoop` symbol 与五个 legacy Review primitive names 的 symbols、schemas、handlers、registrations、aliases 数均为 0，Daemon 内部也不得重建这些 callable primitives。
- **SC-019**：production runtime composition 的 E2E 仅通过 `smartflow_execute → smartflow_review_turn*` 完成至少一轮自动 repair、同一 Reviewer RESUME 和最终 terminal `ResultOutput`；Review loop 中 Host 发出的 status/resume/cancel/result 调用数以及 wait/claim/renew/review/decision handler 调用数均为 0；Review begin/finalize、repair 与 Publish progression 直接通过 Daemon domain operations 完成。
- **SC-020**：真实 installed Pi 0.83.0 的 Extension/RPC compatibility 与经明确授权的 real-model 两工具 E2E 均必须产生 checked-in、可复现、已脱敏证据；在两类证据齐备前，FR-051、T190/T208、T192/T209 完成率不得标为 100%。

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
