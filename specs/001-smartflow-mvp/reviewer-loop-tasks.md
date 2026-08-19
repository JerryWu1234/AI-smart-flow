# Reviewer 会话复用与 Daemon 机械编排核对稿

**状态**：现行设计（SmartFlow 4.1 / Review v2 / 方案 D）
**范围**：Candidate 形成后的复合 Review turn、Reviewer 往返、自动 repair、用户暂停与 Publish
**说明**：本文件是行为核对稿，不替代 `tasks.md`；规范接口见 [contracts/review-turn.md](contracts/review-turn.md)。

## Target Flow

```text
Host: smartflow_execute
  ↓
Host: smartflow_review_turn ── NOT_READY ── bounded poll ──┐
  │                                                        │
  ├─ REVIEW_REQUIRED → Host CREATE/RESUME Reviewer          │
  │                    → submit same turnToken ──────────────┘
  │
  ├─ USER_INPUT_REQUIRED → Host asks user → typed answer ───┘
  │
  └─ DONE → terminal result

Daemon after a valid Review v2:
  every Task 100% with issues=[] → ACCEPT → Publish
  any incomplete Task, rounds < 15 → REPAIR every nested issue → new Revision
  any incomplete Task, rounds >= 15 → PAUSE_REPAIR_LIMIT → AUTOMATIC_REPAIR_LIMIT

Schema/coverage-invalid Review:
  reject before Review/Leader artifact or state write → entire Run unchanged
```

## Public MCP Surface

- 公开 MCP surface 恰好包含 `smartflow_execute`、`smartflow_review_turn`、`smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` 六个工具。
- 唯一公开 Review 编排路径是 `smartflow_execute → smartflow_review_turn*`。
- `smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` 是彼此独立的 Run management APIs，不是另一条 Review continuation 路径。
- Review begin/finalization、deterministic decision、approved-scope repair 与 Publish scheduling 是 Daemon domain operations，不是 wait、claim/renew、Review submission 或 Leader decision callable primitives。
- `HostActionLoop` symbol 与 `smartflow_wait`、`smartflow_claim_action`、`smartflow_renew_action_claim`、`smartflow_submit_review`、`smartflow_submit_leader_decision` 的 public/internal callable symbols、schemas、handlers、registrations、aliases 均不存在。

## Ownership

- Host/Leader 是唯一用户交互者，也是唯一可创建或恢复 Reviewer session 的组件。
- Daemon 是机械编排唯一权威：bounded progress、atomic Review begin/finalize、确定性 accept/repair/pause、同范围 repair Revision 与 Publish 推进。
- Pi Worker 只负责实现，不参与 Review 或用户交互。
- Reviewer 只负责审查并返回结构化结果，不调用 SmartFlow MCP、不宣布 Publish。
- Daemon 不启动、不替换、不模拟 Reviewer；其自动决策不得扩大批准范围。

## Composite Turn Contract

### Initial/poll call

Host 使用稳定 `hostTurnId` 调用 `smartflow_review_turn`，不携带 continuation。Daemon 最长 bounded wait 后返回四态之一：

- `NOT_READY`：只含 phase/progress/`retryAfterMs`，不含 worktree path；
- `REVIEW_REQUIRED`：`REVIEWING + AWAITING_REVIEW` 已在一个 CAS mutation 中 durable 提交，允许 Host 执行 Reviewer；
- `USER_INPUT_REQUIRED`：只能由 Host 向用户取得选项或批准字段；
- `DONE`：只对应 `COMPLETED | CANCELED | FAILED`。

### Review continuation

`REVIEW_REQUIRED` 提供 `turnToken`、`reviewAttemptId`、Task/Candidate Hash、完整 changed paths、`CREATE | RESUME`、Pi session provenance、deadline 和当前 worktree path。绑定 Task manifest 的 `enabledTaskIds` 定义 Reviewer 必须精确覆盖的 Task 集合。Host 提交：

```ts
{
  turnToken,
  review: {
    reviewerSessionId,
    result: ReviewResult
  }
}
```

Daemon 在任何 durable 写入前校验 strict schema、Task coverage、Reviewer/attempt/Revision 和 evidence bindings。当前 token 上格式或 coverage 非法的 payload 被原子拒绝；`stateVersion`、phase、active `hostTurn`/token、`autoRepairRounds`、Review/Leader artifacts 均不变，Host 可在同一有效 turn 上修正后重交。

### Failure/answer continuation

- Reviewer callback 不可用或三次格式修正均失败时，Host 以同一 `turnToken` 提交 `reviewUnavailableReason`；这表示 callback 不可用，不是提交非法 Review 后的状态转换。
- `USER_INPUT_REQUIRED` 只能提交响应中列出的 `answer`；需要新 Revision 用户批准时必须完整提交 `tasksPath + approvedSourceHash + approval`。
- continuation 三者互斥；缺少或过期 token 不产生副作用。

## Reviewer Session Contract

### First round (`CREATE`)

1. Daemon 在一个 CAS mutation 中验证 Candidate，并 durable 写 `REVIEWING + AWAITING_REVIEW + owner/token/revision + reviewAttemptId + deadlineAt`。
2. 只有该 mutation 提交后，`REVIEW_REQUIRED` 才向 owning Host 暴露 worktree path。
3. Host 创建独立 Reviewer session `S1`；`S1` 不得等于 Host 或 Pi Worker session。
4. `S1` 在该 worktree 中重读同步 Task、当前完整文件与 diff，并覆盖累计 changed paths。
5. 提交成功后 Reviewer binding 与 Run 持久绑定。

### Repair rounds (`RESUME`)

1. 安全 repair 在 Review finalize 中直接创建下一 Revision；新 Revision 使用新的 Pi session，生成从 Run baseline 到最新结果的累计 Candidate。
2. 新 Review 必须请求 `RESUME S1`，Host 不得创建 `S2`。
3. `S1` 每轮重新读取同步 Task 和最新完整结果；历史只能辅助理解，不能替代当前检查。
4. 旧 Review attempt、Candidate、turnToken 或迟到结果都不得作用于新 Revision。

### Reviewer output

Reviewer 只返回当前 `ReviewResult`：

```ts
interface ReviewResult {
  tasks: TaskReview[];
}

interface TaskReview {
  id: string;
  completionPercentage: number;
  issues: Issue[];
}

interface Issue {
  path: string;
  message: string;
  suggestedFix?: string;
}
```

约束如下：

- `tasks` 中 ID 唯一，且与 bound `manifest.enabledTaskIds` 精确相等；缺失、重复、额外、未知或 disabled Task 均非法。
- `completionPercentage` 是 0–100 的整数；`completionPercentage === 100` 当且仅当 `issues` 为空，不完整 Task 至少有一个 issue。
- Issue 是 strict object。Schema 只强制 `path` 非空且通过项目相对路径词法检查，`message` 非空，`suggestedFix` 若存在也非空；它不检查文件存在性/类型/symlink，也不分析自然语言具体程度。Reviewer prompt 另行要求 `message` 说明具体函数/行为、触发条件和影响。
- 同一 Task 内 issue 按 `path + message` 唯一。Reviewer 不提供任何额外汇总、评分、路径覆盖或风险字段。
- Review attempt、Revision、`taskSourceHash`、`candidateHash` 与 Reviewer binding 必须是当前值。整体 evidence hashes 保留作完整性绑定，但不作为 no-progress identity。

## Daemon Decision Matrix

只有已通过格式、coverage 与 binding 校验的 Review v2 才进入此表；计划只有三种：

| Review v2 | Durable plan | Host/User role |
|---|---|---|
| 所有 Task 均为 `completionPercentage === 100` 且 `issues: []` | `ACCEPT`，自动进入 Publish | 无机械确认 |
| 至少一个 Task 不完整且 `autoRepairRounds < 15` | `REPAIR`，使用当前全部 `tasks[].issues[]` 创建同范围 repair Revision | 无机械确认；Host 下一轮恢复同一 Reviewer |
| 至少一个 Task 不完整且 `autoRepairRounds >= 15` | `PAUSE_REPAIR_LIMIT`，durable code 为 `AUTOMATIC_REPAIR_LIMIT` | 用户可选 `resume_review_decision` 或其他已允许动作 |

Owning Host 必须把 `resume_review_decision` 作为 `smartflow_review_turn` answer，携带 active `turnToken` 提交。HostTurnCoordinator 校验 durable artifacts 后，以 `repairRounds: 0` 重划 stored v2 Review；若得到 `REPAIR`，持久化 `autoRepairRounds=1`，再由 RepairCoordinator 创建下一 Revision 或进入真实 repair pause。公开 `smartflow_resume` 是独立 paused-Run recovery API，不能代答 active `hostTurn` 或绕过 ownership。

## Repair No-progress

前一轮保存于 `run.recovery.repairRound = { failureIds, tasks, relevantPathHashes }`；hash 来自 Candidate operations 的 `newEntry.sha256` 或 `DELETED`，不重读 Result Snapshot。稳定问题集合是 failure IDs 加唯一 `(task.id, issue.path)`。当前集合是上一轮严格子集，或两轮 Issue path 并集中的任一 relevant hash 改变，才算 progress；否则 `noProgressCount` 加一。首轮初始化为 0，默认阈值为 15，达到时产生 operational `REPAIR_NO_PROGRESS`。`message`、`suggestedFix`、无关路径变化、百分比/顺序和整体 Candidate/evidence hash 都不参与；该 pause 不是第四种 Review decision plan。

## Durable Checkpoint and Recovery

- `AWAITING_REVIEW` 保存 `hostTurnId + turnToken + revision + reviewAttemptId + reviewerSession binding + deadlineAt`；它与 `REVIEWING` 在一次 CAS mutation 中提交。
- `AWAITING_USER_INPUT` 保存 pause code；重启后返回相同类型的用户请求。
- Review 只有一个从 atomic begin 起算的 30 分钟 durable deadline；不存在短 claim lease、renew timer 或 renewal-failure state。
- 同一 Run 的 turn 串行执行；Project state mutation 使用 CAS，每个 operation 总计最多尝试四次（含首次，最多三次重试）并在重试前重读。
- Daemon 重启先恢复 `hostTurn`，随后重读 fresh state；checkpoint 未清除时不得并行启动同一 Run 的一般 Worker/Run recovery。
- stable child request IDs 与 durable state 防止丢失 begin/finalize 响应造成重复 Review、repair、resume 或 Publish。
- Durable Review artifact 使用 `schemaVersion: 2`，内含 revision、claim/attempt、Task/Candidate/session bindings、gate/result 与 `reviewHash`；Leader artifact 只含 revision、reviewHash、decision/reason/decidedAt 与 `decisionHash`，不直接保存 Candidate/task-source binding 或 repair issue 列表。
- Artifact v1 不迁移、不 fallback；strict v2 parse 失败以 `ARTIFACT_SEMANTIC_VALIDATION_FAILED` 暂停或阻塞对应 Run。新 Data Directory 只是部署选择，runtime 没有目录格式 marker/probe；artifact schema 与 Project state schema version 6 相互独立。

## Acceptance Matrix

| 场景 | 预期 |
|---|---|
| Worker 尚未形成 Review | `NOT_READY`，无 worktree path |
| 首轮有效 Candidate | atomic begin 后 `REVIEW_REQUIRED/CREATE` |
| 第二轮 Review | `REVIEW_REQUIRED/RESUME S1` |
| 第二轮新建 `S2` | 拒绝 |
| Reviewer 等于 Pi session | 拒绝 |
| stale Review/answer/failure | 无副作用的 no-path `NOT_READY` |
| atomic begin 响应丢失 | 返回同一 owner/token/attempt/path/deadline，不再次 mutation |
| Daemon 在等待 Reviewer 时重启 | 恢复同一 owner/token/attempt/Reviewer binding/deadline |
| Task IDs 缺失、重复、额外、未知或 disabled | 写 artifact/state 前拒绝；整个 Run 与 active turn 不变 |
| 100% Task 带 issue，或不完整 Task 无 issue | 写 artifact/state 前拒绝；整个 Run 与 active turn 不变 |
| Issue path/message 未通过 strict schema、字段多余或 `path + message` 重复 | 写 artifact/state 前拒绝；整个 Run 与 active turn 不变；message 具体程度只由 Reviewer prompt 约束 |
| v1 Review/Leader artifact | strict v2 parse 失败并暂停/阻塞对应 Run；不转换 artifact，也不声称拒绝整个目录格式 |
| 所有 enabled Task 均 100% | `ACCEPT`，自动 Publish |
| 任一 Task 不完整且低于 15 轮 | `REPAIR` 当前全部 nested issues；RepairCoordinator 随后创建新 Revision或按真实条件暂停 |
| 第 15 轮仍不完整 | `PAUSE_REPAIR_LIMIT` / `AUTOMATIC_REPAIR_LIMIT`，等待用户选择 |
| 同 scope、相关路径 hash 不变，仅 issue 文案或无关文件变化 | no-progress 累加；默认计数达到 15 后 `REPAIR_NO_PROGRESS` |
| scope 严格缩小或相关 Candidate operation hash 改变 | 视为 progress，no-progress 计数清零 |
| Review/Leader evidence | 均为 schemaVersion 2；Review 直接绑定 attempt/Revision/Reviewer/Task/Candidate，Leader 仅经 reviewHash 间接绑定 |
| 30-minute deadline 到期 | durable Host-review-unavailable pause |
| Pause/conflict | `USER_INPUT_REQUIRED`，不是 `DONE` |
| 终态 | `DONE` + canonical result |
| MCP 工具注册 | 恰好六个：`smartflow_execute`、`smartflow_review_turn` 与四个独立 Run management APIs；五个 legacy Review primitive names 的 public/internal callable symbols、schemas、handlers、registrations、aliases 数均为 0 |

## Current Implementation Status

The strict Review v2 schemas, exact six-tool registry, deterministic three-plan policy, Host-owner enforcement, atomic begin/finalize, single-deadline restart recovery, zero-write invalid-payload boundary, complete Reviewer context, direct repair Revision, production-composition repair scenario, and absence of the five legacy callable Review primitives and `HostActionLoop` symbol are implemented. The remaining evidence items are:

- T208/T209: installed Pi host compatibility and an explicitly authorized, checked-in real-model transcript remain open; the gated real-Pi test was intentionally not run.

## Non-goals

- 不让 Daemon 启动 Codex CLI、Claude CLI 或任何 Reviewer。
- 不让 Daemon 解释开放式用户意图、在当前 `tasks[].issues[]` 之外发明问题或扩大 Task/path 批准范围。
- 不让五个 legacy Review primitive names 的 public/internal callable symbols、schemas、handlers、registrations、aliases 或 `HostActionLoop` symbol 存在。
- 不把四个独立 Run management APIs 当作 Review continuation 或第二条 Review 编排路径。
- 不让 Review 通过代表项目验证命令必然成功；SmartFlow 不新增通用 verify/gate。
- 不以 mocked Pi Extension/RPC 测试替代真实 pinned Pi SDK 和 real-model E2E。
- 不修改 Git 历史、远端或原始项目，除非通过受审查的 Publish。
