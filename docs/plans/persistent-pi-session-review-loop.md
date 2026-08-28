# 不可变 Job 内复用 PI Session 的 Review 返修实现计划

> **状态：已实施。** 本计划保留 Worker → Review → Repair → Worker → Review → Publish 主流程，并在同一个不可变 Job、同一个 workspace 和同一个逻辑 PI session 中完成授权范围内的自动返修。
>
> 后续的 `immutable-job-revision-removal.md` 已移除“一 Job 多份获批任务定义”的业务 Revision 模型；本文原先关于“固定使用 Revision 1”以及保留新 Revision 入口的决策不再有效。本文确立的 durable completed PI session bundle、原始 JSONL 恢复和同 session 返修决策继续有效。
>
> **后续格式决策：** `实现计划.md` 已将所有应用层持久化对象统一为无 `schemaVersion` 的 latest-only 契约；completed PI session bundle 继续保持相同的无版本形状。
>
> PI session JSONL 作为 Daemon 内部 artifact 按原始字节保存和恢复；其中允许出现 workspace、runtime、工具调用等内部路径字符串，不做路径脱敏、替换或归一化。

## 1. 当前产品契约

`smartflow_execute` 每次创建一个新 Job。创建成功后，一个 `jobId` 只绑定：

- 一条 canonical task path；
- 一份按原始字节持久化的 task source 及其 hash；
- 一份 TaskManifest artifact 及其 hash；
- 一个 `providerRuntimeConfigHash`；
- 一个首次捕获后不再改变的 Run baseline；
- 一次初始用户审批身份。

`run.taskSource` 和 `run.taskManifest` 是 Worker、Review、Repair、Recovery 与 Publish 的持久事实来源。Job 内没有替换任务定义、推进业务 Revision 或批准新 Revision 的入口。

同一个 Job 内可以更新：

- phase、`stateVersion` 和 fence；
- Worker `attemptId`、`generation`、进程与 containment identity；
- 最新 completed PI session bundle；
- workspace 的最新执行结果；
- Candidate、Review、leader decision、repair 与 Publish 状态。

以下变化必须结束当前 Job，再通过 `smartflow_execute` 创建新 Job：

- task source、acceptance criteria 或任务范围变化；
- canonical task path 变化；
- Provider runtime config 有意变化；
- Review 所需修复超出原 TaskManifest 的授权范围。

当前 Job 不安装新 TaskManifest，也不自动创建或串联后继 Job。

## 2. 当前生命周期

### 2.1 首轮执行

```text
smartflow_execute
→ PREPARING
→ RUNNING                    Worker Attempt A / PI Session S
→ REVIEW_PENDING
→ REVIEWING
→ READY_TO_PUBLISH
→ PUBLISHING
→ COMPLETED
```

### 2.2 授权范围内的自动返修

```text
Job A / immutable task source + TaskManifest + Provider config
→ RUNNING                    Worker Attempt A / PI Session S
→ REVIEW_PENDING
→ REVIEWING
→ FIXING                     Review REQUEST_CHANGES
→ RepairCoordinator 生成反馈 prompt
→ PREPARING                  任务定义与 workspace 不变
→ RUNNING                    Worker Attempt B / 恢复 PI Session S
→ REVIEW_PENDING
→ REVIEWING
→ READY_TO_PUBLISH
→ PUBLISHING
→ COMPLETED
```

改变的只是 `FIXING → PREPARING` 之间的执行准备：Review feedback 成为同一 PI session 的下一条 user prompt。每轮仍创建新的 attempt、generation 和进程，但不改 task source、TaskManifest、Provider config 或任务授权范围。

### 2.3 超出授权范围的返修

```text
Job A / FIXING
→ 发现修复需要扩展原任务范围
→ 保存 repair draft 和原因
→ PAUSED: NEW_JOB_REQUIRED（或等价状态）
→ 用户取消 Job A
→ 用户修改并批准新的 task source
→ smartflow_execute
→ Job B / PREPARING
```

Repair draft 只供用户准备下一份 task source；它不能晋升为当前 Job 的任务定义。draft 使用当前 `taskSourceHash` 与 TaskManifest hash 绑定来源，不使用已删除的 `parentRevision` 链。

## 3. 必须保持的不变量

整个正常返修循环中：

```text
jobId                              始终相同
canonical task path                始终相同
taskManifest artifact/hash         始终相同
taskSource artifact/hash           始终相同
providerRuntimeConfigHash          始终相同
workspace.relativePath             始终相同
run baseline                       始终相同
所有 Worker attempts 的 piSessionId 始终相同
```

每轮允许创建新的：

```text
attemptId
generation
process/containment identity
RUN_RESULT snapshot
Candidate
reviewAttemptId
Review artifact
leader decision
```

`stateVersion`、project/run fence、phase guard、attempt identity、generation 与内容 hash 继续拒绝 stale mutation。删除业务 Revision 不会删除或替代这些并发保护。

## 4. PI Session 复用方式

### 4.1 复用逻辑 Session，不保活进程

每轮 Worker 仍遵循当前生命周期：

```text
启动 PI 进程
→ 执行一个 prompt
→ agent_end
→ 保存 completed PI session
→ 结束进程并完成 containment reconciliation
→ 捕获 RUN_RESULT 与 Candidate
```

Review 期间不保留 PI 进程。下一轮启动新进程，并通过 PI 支持的：

```text
--session <path|id>
```

加载上一轮 session JSONL。复用成功的判断标准是：

```text
下一轮 get_state.sessionId === 上一轮 piSessionId
```

因此，同 session 返修表示：

- 同一个 `piSessionId`；
- 同一份完整对话和工具调用历史；
- 同一个 workspace；
- 每轮仍使用独立 attempt、generation 与进程；
- containment、deadline、取消与 crash recovery 继续按 attempt 管理。

### 4.2 Completed session bundle

`WorkerRunner.persistCompletedSessionArtifact()` 只为成功完成的 attempt 写入 `workerAttempts[].sessionArtifact`。非 completed attempt 的终止信息仍只保存在 `workerAttempts[]` 中。

当前 bundle 格式为：

```json
{
  "jobId": "job-1",
  "attemptId": "attempt-1",
  "generation": 0,
  "piSessionId": "PI-S1",
  "providerRuntimeConfigHash": "...",
  "terminalStatus": "COMPLETED",
  "sessionFileRelativePath": "sessions/<original-name>.jsonl",
  "sessionJsonlBase64": "..."
}
```

这个 completed PI session bundle 与其他最新应用 artifact 一样保持**无 `schemaVersion`**，也不包含业务 `revision`。它继续依赖 artifact ref 的 path、size 与 SHA-256 做完整性校验。

### 4.3 原样保存 Session JSONL

允许 PI session JSONL 包含内部路径，例如：

```text
<workspace>/src/example.ts
<workspace>/.smartflow-runtime/sessions/<session>.jsonl
Daemon 内部 artifact 路径
工具调用中的 cwd 或文件路径
```

实现要求：

1. 不扫描或删除内部路径字符串；
2. 不把 workspace root 替换成占位符；
3. 不重写或重新序列化 JSONL entry；
4. 使用 base64 保存原始文件 bytes；
5. 恢复时解码成完全相同的 bytes；
6. 恢复到上一轮相同的 runtime-relative session path。

同一 Job 复用同一个 workspace，因此 JSONL 中已有的 workspace 内部路径继续有效。

## 5. Provider 与 WorkerRunner

### 5.1 Provider resume 输入

`WorkerStartInput` 使用最小可选 resume 信息：

```ts
resumeSession?: {
  readonly expectedPiSessionId: string;
  readonly sessionFile: string;
};
```

- 未提供：创建新的 PI session；
- 已提供：PiProvider 通过 `--session` 恢复文件，并校验恢复后的 session ID。

Provider `start()` / `cancel()` 结构、事件流和 sandbox 行为保持不变。PI 在 `agent_end` 后通过 `get_state` 暴露最终 `sessionId` 与 `sessionFile`，`COMPLETED` event 把临时 session file 路径交给 WorkerRunner 持久化。

### 5.2 WorkerRunner 持久化顺序

```text
Provider 返回 COMPLETED
→ persistCompletedSessionArtifact()
→ reconcileContainment()
→ 删除 .smartflow-runtime
→ 捕获 RUN_RESULT 与 Candidate
```

持久化步骤：

1. 读取 `COMPLETED.sessionFile`；
2. 确认文件位于本轮 `.smartflow-runtime` 内；
3. 按原始 bytes 读取，不解析或改写 JSONL；
4. 写入无版本 completed session bundle；
5. 保存原始 `sessionFileRelativePath`；
6. 将 artifact ref 写入当前 attempt 的 `sessionArtifact`。

### 5.3 下一轮恢复

`WorkerRunRequest` 使用 app-internal resume 输入：

```ts
resumeSession?: {
  readonly expectedPiSessionId: string;
  readonly sessionArtifact: ArtifactRef;
};
```

WorkerRunner 在 Provider 启动前：

1. 读取上一 completed attempt 的 `sessionArtifact`；
2. 校验 artifact hash 与 size；
3. 解析 bundle metadata 并核对 Job、attempt、generation、session 与 config 身份；
4. base64 解码原始 JSONL bytes；
5. 在同一 workspace 的 `.smartflow-runtime` 下恢复原 relative path；
6. 将恢复路径和 `expectedPiSessionId` 传给 Provider；
7. 使用新的 attemptId/generation 启动本轮进程。

恢复后若 `get_state.sessionId` 与预期不同，本轮 Worker 失败，不能静默创建另一 session。

## 6. RepairCoordinator

RepairCoordinator 继续：

- 读取 durable Review；
- 验证 leader decision 是 `repair`；
- 提取 task issues；
- 维护 repair round 与 progress 信息；
- 使用 mutation fence、attempt identity 和 phase 条件；
- 读取最新 completed attempt 的 `piSessionId` 与 `sessionArtifact`。

授权范围内的后半流程是：

```text
原 TaskManifest + Review issues
→ 渲染 Worker feedback prompt
→ 清理待替换的执行结果引用
→ phase: FIXING → PREPARING
→ 返回 feedback + resumeSession
→ 同 Job、同 workspace、同 PI session 继续
```

反馈 prompt 示例：

```text
Continue working on the same approved task in the current workspace.

The reviewer found these issues in your latest implementation:

Task T002 — 70% complete
File: src/users.ts
Problem: Email format is not validated.
Suggested fix: Validate email before writing to the database.

Fix all reported issues. Re-check the complete original task.md and stop when the
implementation is ready for another review. Do not modify task.md.
```

Repair 不追加或重写 canonical task source，不编译新的 TaskManifest，也没有业务 Revision 审批路径。需要扩展任务范围时，只生成绑定当前 task hashes 的 repair draft，并要求用户取消后创建新 Job。

## 7. Workspace、Snapshot、Candidate 与 artifact

### 7.1 单一 workspace execution record

Run state 使用 `gitWorkspace.current`，不维护按业务 Revision 分区的 map：

```ts
interface RunRecord {
  readonly jobId: string;
  readonly taskManifest: ArtifactRef;
  readonly taskSource: ArtifactRef;
  readonly gitWorkspace?: {
    readonly repositoryId: string;
    readonly inclusionPolicyHash: string;
    readonly objectDirectory: string;
    readonly runBaselineSnapshot: ArtifactRef;
    readonly current: {
      readonly indexPath: string;
      readonly workspacePath: string;
      readonly inputSnapshot: ArtifactRef;
      readonly resultSnapshot?: ArtifactRef;
      readonly candidate?: ArtifactRef;
    };
  };
}
```

实际字段名以 state schema 为准，但当前语义始终是一份 Job-scoped workspace execution record。

### 7.2 Snapshot 与累计 Candidate

Git snapshot kind 使用：

```text
RUN_BASELINE
RUN_RESULT
```

Snapshot 与 Candidate 的 hash payload 都不包含业务 Revision。Repair workspace 可以从上一轮 result snapshot 恢复，但 Candidate 必须始终比较：

```text
Run baseline → latest RUN_RESULT
```

不能比较 `previous repair result → latest result`，否则 Publish 会遗漏早先 repair round 已产生的累计变化。

### 7.3 扁平 artifact 目录

Job 的业务 artifact 直接位于 `runs/{jobId}` 下：

```text
runs/{jobId}/task-manifest.json
runs/{jobId}/task-source.md
runs/{jobId}/snapshots/
runs/{jobId}/candidates/
runs/{jobId}/reviews/
runs/{jobId}/leader-decisions/
runs/{jobId}/repair-drafts/
```

Attempt session artifact 使用：

```text
runs/{jobId}/attempts/{attemptId}/session-artifact.json
```

所有路径都直接以 Job 为作用域，不再写 `revision-N` 中间目录。每个 artifact 继续使用相对路径、size 和 SHA-256 验证身份与完整性。

## 8. Review 与 Publish

### Review

以下行为保持不变：

- ReviewRunner 直接调用配置的 Reviewer adapter；
- Reviewer 第一轮 `CREATE`，后续 repair round `RESUME`；
- 每轮读取同一份不可变 task source 与 TaskManifest；
- 每轮检查完整 enabled tasks；
- Review result 继续经过 schema、gate 与 decision 校验；
- `reviewHistory` 继续追加；
- 未通过进入 `FIXING`，通过进入 `READY_TO_PUBLISH`。

`workerSession(run)` 读取最新 completed attempt 的 `piSessionId`。由于每轮恢复同一 PI session，该绑定继续成立。

### Publish

Publish 始终使用当前 Job 的累计 Candidate、validated Review 与 leader decision。Publish identity 不包含业务 Revision，使用：

```text
jobId + candidateHash + reviewHash + operationsHash
```

以下保护继续保留：

- `stateVersion`、fence 与 phase guard；
- Worker `attemptId` 与 `generation`；
- Candidate、Review、operations 与 artifact hash；
- publish operation ID；
- file-level expected old hash / mode CAS。

因此 crash reconciliation、重复调用和 stale publish 仍然安全。

## 9. Recovery 与兼容边界

Recovery 只能从 `jobId`、durable artifact refs、fence、attemptId、generation 与 `piSessionId` 恢复，不依赖业务 Revision 字段或目录。

本项目不为旧业务 Revision 状态或旧 artifact 提供：

- migration；
- dual-read；
- compatibility union；
- 旧路径 fallback。

旧本地运行数据需要清理后重新创建 Job。业务 `revision` 与应用层 `schemaVersion` 都已从最新契约删除；以下运行身份继续存在且含义不同：

- state mutation 的 `stateVersion`；
- Worker attempt 的 `generation`；
- repair round counter；
- Review history。

Completed PI session bundle 与其他最新应用 artifact 一致，不携带 `schemaVersion`。

## 10. 对当前流程的实际影响

| 项目 | 当前行为 |
|---|---|
| Job task source / TaskManifest / canonical path / Provider config | 创建后不可变 |
| 自动返修 | 原任务授权范围内，同 Job 继续 |
| 超范围修复 | 保存 repair draft，用户取消并 execute 新 Job |
| workspace | 同一 Job 复用 `gitWorkspace.current` |
| Worker attempt / generation | 每轮新建并独立 fenced |
| PI 进程 | 每轮结束并重启 |
| PI session | 从 completed bundle 恢复同一个 session |
| PI session JSONL | 原始 bytes 保存，内部路径不改写 |
| Snapshot | `RUN_BASELINE` / `RUN_RESULT` |
| Candidate | Run baseline 到最新 result 的累计变化 |
| Reviewer session | `CREATE → RESUME` |
| Publish | 发布当前累计 Candidate，identity 无业务 Revision |
| 旧状态与 artifact | 不兼容、不迁移 |

## 11. 测试计划

### 11.1 PI Provider

验证：

- 首轮 argv 不包含 `--session`；
- 返修轮 argv 包含 `--session <原路径>`；
- 恢复后 `get_state.sessionId` 与预期一致；
- `COMPLETED` 返回最终 session file；
- 第二轮 session 历史包含第一轮消息；
- JSONL 中的内部路径字符串原样保留。

### 11.2 WorkerRunner

验证：

- completed `sessionArtifact` 包含 metadata 与原始 JSONL bytes；
- bundle 不含 `schemaVersion` 或业务 `revision`；
- non-completed attempt 不生成 `sessionArtifact`；
- base64 decode 后与原 session 文件逐字节一致；
- runtime 目录删除后仍能从 artifact 恢复；
- 恢复使用原 `sessionFileRelativePath`；
- 下一轮 attemptId/generation 改变而 `piSessionId` 不变；
- workspace 路径不变。

### 11.3 Review / Repair

验证：

- Review issues 被渲染为同一 session 的下一条 Worker prompt；
- `FIXING → PREPARING` 阶段继续存在；
- jobId、task refs、task hashes 与 config hash 不变；
- `gitWorkspace.current` 与 workspace path 不变；
- Candidate 始终是 baseline 到 latest result；
- Reviewer session 继续 resume；
- scope expansion 只产生 repair draft 与 new-Job requirement。

### 11.4 Publish / Recovery

验证：

- Publish identity 与 artifact 路径不含业务 Revision；
- flat artifact paths 可被恢复和完整性校验；
- crash 后继续对账同一 publish operation；
- stale state/fence/attempt/generation/hash 仍被拒绝；
- daemon 重启后可恢复 repair continuation 和 completed PI session。

## 12. 验收标准

实现完成必须满足：

1. 一个 Job 只持有一份 task source、TaskManifest、canonical task path 与 Provider config；
2. 自动 repair 不创建或安装新任务定义；
3. scope 内 repair 使用同一个 Job、workspace 和逻辑 PI session；
4. scope 外 repair 只生成 draft，并要求用户取消后 execute 新 Job；
5. 每轮仍创建独立 Worker attempt 与 generation；
6. completed PI session JSONL 原始 bytes 可以完整保存和恢复；
7. completed session bundle 无 `schemaVersion` 与业务 `revision`；
8. JSONL 内部路径字符串不被修改；
9. state 使用 `gitWorkspace.current`，artifact 不含 `revision-N` 目录；
10. snapshot 使用 `RUN_BASELINE` / `RUN_RESULT`；
11. Candidate 始终是 Run baseline 到 latest result 的累计变化；
12. Reviewer session、Review gate/decision/history 保持工作；
13. Publish identity 无业务 Revision，CAS 与幂等保护保持工作；
14. 不提供旧状态或旧 artifact 的兼容与迁移；
15. `stateVersion`、attempt generation 和 repair counters 不被误删。

## 13. 验证命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:provider:pi
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm release:check
```

如协议、安全或恢复路径发生机械性类型变化，再补充：

```bash
pnpm test:contract
pnpm test:security
pnpm test:crash
```
