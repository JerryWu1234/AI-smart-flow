# Reviewer 会话复用与 Daemon 机械编排核对稿

**状态**：现行设计（SmartFlow 4.1 / 方案 D）
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

Daemon after Review:
  100% valid Review → automatic accept → Publish
  actionable incomplete Review, rounds < 15 → automatic repair → new Revision
  invalid/no-guidance Review → durable INVALID_REVIEW pause
  rounds >= 15 → durable AUTOMATIC_REPAIR_LIMIT pause
```

## Public MCP Surface

- 公开 MCP surface 恰好包含 `smartflow_execute`、`smartflow_review_turn`、`smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` 六个工具。
- 唯一公开 Review 编排路径是 `smartflow_execute → smartflow_review_turn*`。
- `smartflow_status`、`smartflow_resume`、`smartflow_cancel`、`smartflow_result` 是彼此独立的 Run management APIs，不是另一条 Review continuation 路径。
- wait、Action claim/renew、Review submission 与 Leader decision 只属于 Daemon 内部机制。
- `HostActionLoop` symbol 与 `smartflow_wait`、`smartflow_claim_action`、`smartflow_renew_action_claim`、`smartflow_submit_review`、`smartflow_submit_leader_decision` 的公开 symbols、schemas、handlers、registrations、aliases 均不存在；对应 Review mechanics 仅为 Daemon internal。

## Ownership

- Host/Leader 是唯一用户交互者，也是唯一可创建或恢复 Reviewer session 的组件。
- Daemon 是机械编排唯一权威：等待、Action claim/renew、Review 提交、确定性 accept/repair/pause、同范围 repair Revision 与 Publish 推进。
- Pi Worker 只负责实现，不参与 Review 或用户交互。
- Reviewer 只负责审查并返回结构化结果，不调用 SmartFlow MCP、不宣布 Publish。
- Daemon 不启动、不替换、不模拟 Reviewer；其自动决策不得扩大批准范围。

## Composite Turn Contract

### Initial/poll call

Host 使用稳定 `hostTurnId` 调用 `smartflow_review_turn`，不携带 continuation。Daemon 最长 bounded wait 后返回四态之一：

- `NOT_READY`：只含 phase/progress/`retryAfterMs`，不含 worktree path；
- `REVIEW_REQUIRED`：claim 已 durable 完成，允许 Host 执行 Reviewer；
- `USER_INPUT_REQUIRED`：只能由 Host 向用户取得选项或批准字段；
- `DONE`：只对应 `COMPLETED | CANCELED | FAILED`。

### Review continuation

`REVIEW_REQUIRED` 提供 `turnToken`、`reviewAttemptId`、Task/Candidate Hash、完整 changed paths、`CREATE | RESUME`、Pi session provenance、deadline 和已 claim 的 worktree path。Host 提交：

```ts
{
  turnToken,
  review: {
    reviewerSessionId,
    result
  }
}
```

### Failure/answer continuation

- Reviewer callback 不可用或三次格式修正均失败时，Host 以同一 `turnToken` 提交 `reviewUnavailableReason`。
- `USER_INPUT_REQUIRED` 只能提交响应中列出的 `answer`；需要新 Revision 用户批准时必须完整提交 `tasksPath + approvedSourceHash + approval`。
- continuation 三者互斥；缺少或过期 token 不产生副作用。

## Reviewer Session Contract

### First round (`CREATE`)

1. Daemon 先 durable 写 `CLAIMING`，再 claim Review Action，最后 durable 写 `AWAITING_REVIEW`。
2. 只有此时 `REVIEW_REQUIRED` 才暴露 claimed worktree path。
3. Host 创建独立 Reviewer session `S1`；`S1` 不得等于 Host 或 Pi Worker session。
4. `S1` 在该 worktree 中重读同步 Task、当前完整文件与 diff，并覆盖累计 changed paths。
5. 提交成功后 Reviewer binding 与 Run 持久绑定。

### Repair rounds (`RESUME`)

1. 新 Revision 使用新的 Pi session，生成从 Run baseline 到最新结果的累计 Candidate。
2. 新 Review Action 必须请求 `RESUME S1`，Host 不得创建 `S2`。
3. `S1` 每轮重新读取同步 Task 和最新完整结果；历史只能辅助理解，不能替代当前检查。
4. 旧 Action、claim、Candidate、turnToken 或迟到结果都不得作用于新 Revision。

### Reviewer output

Reviewer 必须逐 Task 给出 0–100 分；总分是算术平均后四舍五入。Daemon 归一化/校验为：

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

所有 changed paths 都必须被覆盖；finding fingerprint 由稳定字段重算；Action、Revision、Task Hash、Candidate Hash 与 Reviewer binding 必须是当前值。

## Daemon Decision Matrix

| Review | Durable plan | Host/User role |
|---|---|---|
| `APPROVE` + 100% + no blocking finding | `ACCEPT`，自动进入 Publish | 无机械确认 |
| 有 blocking findings 且 `autoRepairRounds < 15` | `REPAIR`，仅引用当前 finding fingerprints | 无机械确认；Host 下一轮恢复 Reviewer |
| 不完整但无 actionable blocking finding | `PAUSE_INVALID_REVIEW` | `USER_INPUT_REQUIRED`; 仅 `cancel` |
| 有 findings 且 `autoRepairRounds >= 15` | `PAUSE_REPAIR_LIMIT` | 用户可选 `resume_review_decision` 或其他已允许动作 |

Owning Host 必须把 `resume_review_decision` 作为 `smartflow_review_turn` answer，携带 active `turnToken` 提交。HostTurnCoordinator 随后在内部调用 Daemon resume mechanics、清除 checkpoint 并将 automatic repair counter 重置为 0，授予下一组最多 15 轮；公开 `smartflow_resume` 是独立 paused-Run recovery API，不能代答 active `hostTurn` 或绕过 ownership。无进展观测不提前终止额度，但也不得绕过无 actionable finding 的 invalid Review 保护。

## Durable Checkpoint and Recovery

- `CLAIMING` 保存 `hostTurnId + turnToken + revision + actionId + deadlineAt`；claim response 丢失时从 durable pending Action 对账。
- `AWAITING_REVIEW` 增加 `claimId + reviewAttemptId`；Daemon 每 60 秒或 lease 到期前 30 秒续租。
- `AWAITING_USER_INPUT` 保存 pause code；重启后返回相同类型的用户请求。
- Review 总 deadline 为 30 分钟；续租失败重试间隔 1 秒，连续三次失败进入 durable pause。
- 同一 Run 的 turn 串行执行；Project state mutation 使用 CAS，每个 operation 总计最多尝试四次（含首次，最多三次重试）并在重试前重读。
- Daemon 重启先恢复 `hostTurn`，随后重读 fresh state；checkpoint 未清除时不得并行启动同一 Run 的一般 Worker/Run recovery。
- stable child request IDs 防止重复 claim、Review 提交、repair、resume 或 Publish。

## Acceptance Matrix

| 场景 | 预期 |
|---|---|
| Worker 尚未形成 Review | `NOT_READY`，无 worktree path |
| 首轮有效 Action | durable claim 后 `REVIEW_REQUIRED/CREATE` |
| 第二轮 Review | `REVIEW_REQUIRED/RESUME S1` |
| 第二轮新建 `S2` | 拒绝 |
| Reviewer 等于 Pi session | 拒绝 |
| stale Review/answer/failure | 无副作用的 no-path `NOT_READY` |
| Daemon 在 claim intent 后崩溃 | 重启对账同一 Action，不重复 claim |
| Daemon 在等待 Reviewer 时重启 | 恢复同一 token/action/attempt 并续租 |
| 100% 有效 Review | 自动 accept/Publish |
| 不完整且有 findings，低于 15 轮 | 自动 repair，新 Pi session，同一 Reviewer |
| 不完整且无 findings | `INVALID_REVIEW`，只允许 cancel |
| 第 15 轮仍不完整 | `AUTOMATIC_REPAIR_LIMIT`，等待用户选择 |
| deadline 或三次 renew failure | durable Host-review-unavailable pause |
| Pause/conflict | `USER_INPUT_REQUIRED`，不是 `DONE` |
| 终态 | `DONE` + canonical result |
| MCP 工具注册 | 恰好六个：`smartflow_execute`、`smartflow_review_turn` 与四个独立 Run management APIs；五个 named Review mechanics 的公开 symbols、schemas、handlers、registrations、aliases 数均为 0 |

## Current Implementation Status

The schemas, exact six-tool registry, deterministic decision policy, Host-owner enforcement, claim/renew/restart recovery, self-contained pause protocol, complete Reviewer context, production-composition repair scenario, and absence of the five named public Review symbols/schemas/handlers/registrations/aliases and `HostActionLoop` symbol are implemented. Final semantic review found no actionable P0/P1/P2 and approved T204/T205. The remaining evidence items are:

- T208/T209: installed Pi host compatibility and an explicitly authorized, checked-in real-model transcript remain open; the gated real-Pi test was intentionally not run.

## Non-goals

- 不让 Daemon 启动 Codex CLI、Claude CLI 或任何 Reviewer。
- 不让 Daemon 解释开放式用户意图、发明 RepairItem 或扩大批准范围。
- 不让五个 named Review mechanics 的公开 symbols、schemas、handlers、registrations、aliases 或 `HostActionLoop` symbol 存在；对应 mechanics 仅为 Daemon internal。
- 不把四个独立 Run management APIs 当作 Review continuation 或第二条 Review 编排路径。
- 不让 Review 通过代表项目验证命令必然成功；SmartFlow 不新增通用 verify/gate。
- 不以 mocked Pi Extension/RPC 测试替代真实 pinned Pi SDK 和 real-model E2E。
- 不修改 Git 历史、远端或原始项目，除非通过受审查的 Publish。
