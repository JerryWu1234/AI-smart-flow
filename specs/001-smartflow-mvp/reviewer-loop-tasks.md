# Reviewer 会话复用与 Leader 修复核对稿

**状态**：现行设计
**范围**：Candidate 形成后的 Review、Leader 决策和 repair 循环
**说明**：本文件是行为核对稿，不替代 `tasks.md`。

## Target Flow

```text
Task
→ Pi Worker
→ Candidate + Review Action
→ Host 绑定 Reviewer
→ Reviewer 读取当前 Revision 的冻结任务 Artifact 与最新完整 Result Workspace
→ Review 返回 Leader
   ├─ accept → Publish
   ├─ repair → FIXING → PAUSED → 批准新 Revision
   │                              ↓
   │                         Pi Worker → 恢复同一 Reviewer
   └─ pause  → PAUSED
```

## Ownership

- Leader 是唯一业务决策者。
- Pi Worker 只负责实现，不参与审查或用户交互。
- Reviewer 只负责返回结构化审查结果，不宣布完成。
- Host 负责创建或恢复 Reviewer session，并提交其结果。
- Daemon 负责 Action、状态、Hash 和 session 绑定，不启动 Reviewer 进程。
- 用户只与 Leader 交互。

## Reviewer Session Contract

### First round

1. Daemon 为当前 Candidate 创建新的 Review Action。
2. Action 的 session mode 为 `CREATE`。
3. Host claim Action，并创建独立 Reviewer session `S1`。
4. `S1` 不能等于 Leader session 或任何 Pi Worker session。
5. `S1` 直接读取启动时冻结的任务 Artifact、当前完整 Result Workspace 和累计 Candidate。
6. Host 提交 Review 后，Daemon 将 `S1` 持久绑定到本闭环。

### Repair rounds

1. 每轮生成新的 Review Action、claim 和 reviewAttemptId。
2. Action 的 session mode 为 `RESUME`，并携带绑定的 `S1`。
3. Host 只能恢复 `S1`，不得创建 `S2`。
4. `S1` 每轮重新读取当前 Revision 的不可变任务 Artifact、最新完整 Result Workspace 和累计 Candidate。
5. 相邻 Revision Patch 与旧会话记忆只用于聚焦修复，不能替代审查最新完整结果。

### Failure behavior

- CREATE 成功但提交前中断：只允许恢复已创建的 session。
- Reviewer 句柄丢失或 Host 无法恢复：`HOST_REVIEW_UNAVAILABLE`。
- claim 过期：Action 回到 pending；迟到提交被拒绝。
- Daemon 重启：从 `state.json` 的 `reviewHistory` 恢复 Reviewer session 绑定，不创建替代 session。

## Review Requirements

Reviewer 每轮完成两个视角：

1. **Converge**：逐条检查任务、完成条件和实现差异。
2. **Adversarial**：检查安全、并发、恢复、数据丢失和虚假成功风险。

提交至少包含：

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

Daemon 必须校验：

- Action、claim、Revision 和 ReviewBundle 都是当前值；
- reviewerSessionId 符合首轮 CREATE 或后续 RESUME 规则；
- 全部 changed paths 都有覆盖记录；
- finding fingerprint 可由稳定字段重算；
- 提交没有引用旧 Candidate 或旧 Revision。

## Leader Decision

Review 结果必须完整返回 Leader。Leader 只能选择：

```ts
type LeaderDecision =
  | { decision: "accept"; reason: string }
  | { decision: "repair"; repairItems: RepairItem[]; reason: string }
  | { decision: "pause"; reason: string };
```

### Accept

必须同时满足：

- verdict 为 `APPROVE`；
- 所有 changed paths 为 `FULL`；
- 没有 blocking finding；
- Review、Candidate 和 Revision Hash 均为当前值。

任一条件不满足，协议必须拒绝 `accept`。Leader 不能覆盖 Reviewer 的阻塞结果。

### Repair

Leader 至少提交一个 RepairItem：

```ts
type RepairItem =
  | {
      source: "reviewer";
      findingFingerprint: string;
    }
  | {
      source: "leader";
      code: string;
      taskId: string;
      path: string | null;
      reason: string;
    };
```

Reviewer 来源绑定当前 Review finding。Leader 来源用于“Reviewer 已批准，但 Leader 发现具体问题”等场景。

Leader RepairItem 必须：

- 包含稳定且非空的问题 code；
- 原因具体且非空；
- 关联当前 Task；
- path 为空时回落到该 Task 的首个目标路径；
- 显式 path 安全且位于项目内；
- 不隐式扩大产品范围或权限。

无法形成具体修复项时，Leader 应选择 `pause`，不能让 Worker 猜测。

### Pause

暂停必须持久化机器可读 code、原因和允许的恢复动作。需要用户选择、Reviewer 不可用、修复越界或无法安全判断时均可暂停。

## Repair Revision

Leader 选择 repair 后：

1. Daemon 将 RepairItems 转换为具体修复任务草稿，进入 `FIXING`。
2. 草稿持久化后进入 `PAUSED`，Host 校验并批准新的不可变 Revision 任务 Artifact；不改写启动用任务文件。
3. 仅纠正已批准范围时可批准 `LEADER_REPAIR` Revision；扩大产品范围时重新取得用户批准。
4. 批准后进入 `PREPARING`，创建新 Revision 并失效旧 Candidate、ReviewBundle、ReviewDecision、LeaderDecision 和 PublishResult。
5. Pi Worker 从上一 Revision Result Tree 创建新的 Pi session 继续执行，并生成 Run Baseline 到最新 Result Tree 的累计 Candidate；相邻 Tree Patch 只作为本轮证据。
6. Daemon 创建新 Review Action。
7. Host 恢复原 Reviewer `S1` 完成复审。

`reviewHistory` 中的 Reviewer session 绑定在同一闭环跨 Revision 保留；其他结果不得跨 Revision 继承。

## Repair-round Stop

系统可以比较相邻修复轮次的：

- blocking finding fingerprint 集合；
- RepairItem 对应路径的 Candidate Hash；
- 问题是否实际减少。

这些观测只用于记录进展，不得在额度耗尽前提前结束循环。初始编码后的 Review 不计入额度；后续自动返工最多执行 15 轮。第 15 轮复审仍未达到所有任务 100% 时，保留 Candidate 和 Review 信息并暂停，由用户决定是否继续。每次继续增加 15 轮额度。

## Acceptance Matrix

| 场景 | 预期 |
|---|---|
| 首轮 Review | 创建一个独立 Reviewer session |
| 第二轮 Review | 恢复首轮 session |
| 第二轮新建另一 session | 拒绝 |
| Reviewer 等于 Worker | 拒绝 |
| Reviewer 未重读当前任务/实现 | 不能通过 |
| Reviewer 未通过，Leader accept | 拒绝 |
| Reviewer 批准，Leader 创建合法 RepairItem | 新 Revision |
| RepairItem 空泛或越界 | 拒绝或暂停 |
| 旧 Action/claim/Review 迟到 | 拒绝 |
| Reviewer session 丢失 | `HOST_REVIEW_UNAVAILABLE` |
| 15 个返工轮次后仍未全部 100% | 保留 Candidate 并暂停等待用户决定 |
| Reviewer 只审本轮增量，未覆盖最新完整结果 | 不能通过 |
| Leader accept 且审查条件满足 | 进入 Publish |

## Non-goals

- 不让 Daemon 启动 Codex CLI、Claude CLI 或其他 Reviewer。
- 不引入第二个 Leader或 Worker 自审。
- 不让 Review 通过代表项目已经运行成功。
- 不新增独立的通用 test/lint/build verify/gate 阶段；Pi 可在 isolated workspace 中按 Task 需要运行项目命令。
- 不修改 Git index、历史或远端。
