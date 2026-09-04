# 不可变 Job 与业务 Revision 移除计划

> **状态：待实施。**
>
> **后续格式决策：** `实现计划.md` 在不可变 Job 落地后进一步删除全部应用层 `schemaVersion`；本文关于“保留 schemaVersion”的范围说明仅记录本计划当时的边界，不再代表当前持久化契约。
>
> 本计划确认一个 `jobId` 从创建到终态只绑定一份不可变任务：Task source、TaskManifest、canonical task path 和 Provider runtime config 不在该 Job 内更新。自动返修只更新执行结果，不修改任务定义；任何任务或配置变化都必须结束当前 Job，再创建新 Job。
>
> 本计划取代 `persistent-pi-session-review-loop.md` 中“保留 `approved-revision.ts` 新 Revision 能力”的决策，但保留该计划已经确立的同 workspace、同 PI session 自动返修方式。

## 1. 决策与目标

当前系统曾同时存在两个不同的版本概念：

- `schemaVersion`：JSON / artifact 的格式版本；
- `revision`：同一 Job 内第几份获批任务定义。

本计划只负责移除第二种业务 `revision`；后续 latest-only 断代再独立删除所有应用层 `schemaVersion`。

目标模型是：

```text
一个 jobId
├── 一份不可变 task source
├── 一份不可变 TaskManifest
├── 一个不可变 providerRuntimeConfigHash
├── 一个 run baseline
├── 多个 Worker attempt / generation
├── 多轮 Candidate / Review / Repair
└── 最终一次 Publish 或终止结果
```

任务定义发生变化时，不再执行：

```text
Job A / Revision 1 → Job A / Revision 2
```

而是执行：

```text
Job A 结束 → 使用新任务创建 Job B
```

项目尚未发布，本计划不增加旧 revision state、artifact 或协议输入的迁移和兼容分支。实现完成后，旧本地运行数据需要清理并重新创建。

## 2. Job 不可变性

### 2.1 创建后不可改变的内容

`execute` 成功创建 Job 后，以下内容必须保持不变：

- `jobId`；
- canonical task path；
- Task source 原始字节及 source hash；
- TaskManifest artifact 及 manifest hash；
- `providerRuntimeConfigHash`；
- 首次捕获后的 Run baseline snapshot；
- 初始用户审批身份。

`run.taskSource` 和 `run.taskManifest` 是该 Job 的持久事实来源。后续 Worker、Review、Repair、Recovery 和 Publish 都只能引用它们，不能替换它们。

### 2.2 Job 内允许变化的内容

以下内容属于同一不可变任务的执行过程，可以持续更新：

- phase；
- state version 和 fence；
- Worker `attemptId`、`generation`、进程和 containment identity；
- PI session 的最新 completed bundle；
- workspace 的最新执行结果；
- Candidate；
- review attempt、review decision 和 leader decision；
- repair round、no-progress counter 和 continuation；
- publish attempt 和结果；
- 错误、暂停和恢复状态。

### 2.3 必须创建新 Job 的情况

以下变化不能在当前 Job 内完成：

- Task source 内容改变；
- acceptance criteria 或任务范围改变；
- canonical task path 改变；
- Provider runtime config 有意更换；
- Review 发现修复需要超出原 TaskManifest 授权范围；
- 用户希望采用新的任务定义重新执行。

处理方式统一为：

```text
暂停或取消当前 Job
→ 输出必要的诊断或 repair draft
→ 用户确认新的任务文件
→ 调用 execute 创建新的 jobId
```

本计划不新增 Job supersede、parentJobId 或自动串联 Job 的能力。

## 3. 为什么 Revision 可以移除

当前普通流程和自动返修已经不会推进 Revision：

```text
execute
→ Worker
→ Review
→ 自动 Repair
→ Worker
→ Review
→ Publish
```

其中重试和返修只会增加：

```text
attemptId
generation
reviewAttemptId
autoRepairRounds
```

当前唯一真正执行 `N → N+1` 的路径是：

```text
approve_new_manifest_revision
→ createApprovedRevision()
→ run.revision + 1
```

在“一 Job 一份不可变任务”的产品约束下，这条能力应被删除。删除后，`revision` 不再表达任何可变化的业务状态，只会成为恒为 `1` 的冗余字段和目录层级。

## 4. 目标生命周期

### 4.1 正常成功流程

```text
execute
→ PREPARING
→ RUNNING
→ REVIEW_PENDING
→ REVIEWING
→ READY_TO_PUBLISH
→ PUBLISHING
→ COMPLETED
```

### 4.2 自动返修流程

```text
execute
→ PREPARING
→ RUNNING                    Attempt A / PI Session S
→ REVIEW_PENDING
→ REVIEWING
→ FIXING
→ RepairCoordinator 生成反馈 prompt
→ PREPARING                  Task source / manifest 不变
→ RUNNING                    Attempt B / 恢复 PI Session S
→ REVIEW_PENDING
→ REVIEWING
→ READY_TO_PUBLISH
→ PUBLISHING
→ COMPLETED
```

自动返修必须保持：

- 同一个 `jobId`；
- 同一份 Task source 和 TaskManifest；
- 同一个 Provider config hash；
- 同一个逻辑 PI session；
- 同一个任务授权范围；
- Candidate 始终表示 Run baseline 到最新结果的累计变化。

### 4.3 需要改变任务定义的流程

```text
Job A / FIXING
→ 发现修复超出原任务范围
→ PAUSED: NEW_JOB_REQUIRED
→ 保存 repair draft 和原因
→ 用户取消 Job A
→ 修改并批准任务文件
→ execute
→ Job B / PREPARING
```

当前 Job 不接收新 TaskManifest，也不把 draft 晋升为当前 Job 的任务定义。

## 5. Revision 职责的替代身份

删除 revision 不能削弱现有身份绑定和并发保护。各用途替换如下：

| 当前 Revision 用途 | 删除后的替代身份 |
| --- | --- |
| 当前任务版本 | `jobId + taskSourceHash + taskManifest hash` |
| Mutation stale check | `stateVersion + fence + phase` |
| Worker 身份 | `jobId + attemptId + generation` |
| PI session 归属 | `jobId + attemptId + generation + piSessionId` |
| Workspace / snapshot 归属 | `jobId + repositoryId + snapshotHash` |
| Candidate 归属 | `jobId + candidateHash + resultSnapshotHash` |
| Review 上下文 | `jobId + taskSourceHash + candidateHash + reviewAttemptId` |
| Recovery 上下文 | `jobId + fence + attemptId + generation` |
| Publish identity | `jobId + candidateHash + reviewHash + operationsHash` |
| Artifact 目录 | `runs/{jobId}/...` |

必须保留：

- `stateVersion`；
- project/run fence；
- `attemptId`；
- `generation`；
- phase guard；
- content hash；
- publish operation ID 和 file-level CAS。

`expectedRevision` 删除后，不能把这些保护一起弱化。

## 6. 目标持久化结构

### 6.1 Run state

当前结构：

```ts
interface RunRecord {
  revision: number;
  gitWorkspace?: {
    revisions: Record<string, GitRevisionWorkspace>;
  };
}
```

目标结构示意：

```ts
interface RunRecord {
  jobId: string;
  taskManifest: ArtifactRef;
  taskSource: ArtifactRef;
  gitWorkspace?: {
    repositoryId: string;
    inclusionPolicyHash: string;
    objectDirectory: string;
    runBaselineSnapshot: ArtifactRef;
    current: {
      indexPath: string;
      workspacePath: string;
      inputSnapshot: ArtifactRef;
      resultSnapshot?: ArtifactRef;
      candidate?: ArtifactRef;
    };
  };
}
```

最终字段名可以在实现时按现有命名规范确定，但必须从 revision map 收敛成单个 workspace execution record。

### 6.2 Artifact 目录

当前结构：

```text
runs/{jobId}/revision-1/task-manifest.json
runs/{jobId}/revision-1/task-source.md
runs/{jobId}/revision-1/snapshots/...
runs/{jobId}/revision-1/candidates/...
runs/{jobId}/revision-1/reviews/...
runs/{jobId}/revision-2/repair-drafts/...
```

目标结构：

```text
runs/{jobId}/task-manifest.json
runs/{jobId}/task-source.md
runs/{jobId}/snapshots/...
runs/{jobId}/candidates/...
runs/{jobId}/reviews/...
runs/{jobId}/publish/...
runs/{jobId}/repair-drafts/...
runs/{jobId}/attempts/{attemptId}/session-artifact.json
```

所有 artifact 继续依靠相对路径、size 和 SHA-256 完整性校验，不用 revision 充当内容身份。

### 6.3 Git snapshot 和 Candidate

- 从 Git snapshot 删除业务 `revision`；
- 将 `REVISION_RESULT` 改为 `RUN_RESULT`；
- snapshot hash 不再包含 revision；
- 从 Candidate 删除 revision；
- Candidate hash 不再包含 revision；
- 删除 Revision 1、2、3 的连续 snapshot 链校验；
- 保留 baseline、result、repository 和 inclusion policy 的一致性校验。

自动返修可能从上一轮 result snapshot 重建 workspace，但 Candidate 的比较基准必须始终是：

```text
Run baseline → latest run result
```

不能错误地变成：

```text
previous repair result → latest repair result
```

否则 Publish 会遗漏前几轮已经产生的累计变更。

## 7. 分阶段实施

### 阶段一：先建立单 Job 不可变行为

这一阶段先保留内部 `revision: 1`，只删除所有推进 revision 的能力，证明业务上不再需要它。

#### 7.1 删除新 Revision 入口

- 从 MCP protocol 删除 `approve_new_manifest_revision`；
- 从 resume action schema 和 public action projection 删除该动作；
- 仅从 resume input 删除 revision approval payload：`tasksPath`、source approval 和 `approval.parentRevision` 等字段；Daemon/internal execute 创建新 Job 只保留 `projectRoot`、`tasksPath` 和 `requestId`，并在 ingest 时单次读取和固化 task source；public MCP `smartflow_execute` 不暴露这些内部字段；
- 删除 `ProjectRuntime.resume()` 中创建新 Revision 的分支；
- 删除 `apps/daemon/src/approved-revision.ts`；
- 删除所有 `createApprovedRevision()` 调用。

#### 7.2 Provider config drift

当前有意更换 Provider config 时不能修改当前 Job 的 manifest：

- 若原 config 暂时不可用，允许恢复原 config 后重试；
- 若用户希望采用新 config，当前 Job 只能取消；
- 使用新 config 再次 `execute`，创建新 Job。

暂停动作不再暴露 `approve_new_manifest_revision`，只保留实际可执行的 retry / cancel 动作。

#### 7.3 强制 Task source 不可变

Worker workspace 中的 canonical task 文件必须从：

```text
run.taskSource artifact
```

物化，而不是从项目目录中的 live task 文件重新读取。

项目目录中的 task 文件仍可用于：

- 创建新 Job；
- 检测用户是否改变了当前批准源；
- 提示 restore、cancel 或创建新 Job。

但其变化不能改变已存在 Job 的执行输入。

#### 7.4 调整 Repair 授权

自动 repair 的正确语义是：

```text
原 TaskManifest + Review feedback → 修复原任务实现
```

而不是：

```text
创建临时 Revision N+1 manifest → 安装到当前 Job
```

实现要求：

- 在原 TaskManifest 范围内的 Review feedback，直接生成 repair prompt；
- 保持当前 task manifest/source refs 不变；
- 保持同一 workspace、PI session 和累计 Candidate；
- 若反馈要求扩展任务范围，生成 follow-up repair draft；
- draft 使用当前 `taskSourceHash` / manifest hash 绑定来源，不使用 `parentRevision`；
- 当前 Job 进入 `NEW_JOB_REQUIRED` 或等价暂停状态；
- 用户创建新 Job 后，新的 source 通过普通 USER approval 进入系统。

阶段一验收条件：生产代码中不存在任何 `run.revision + 1`，且 TaskManifest/source refs 在 Job 创建后没有更新路径。

### 阶段二：移除核心 schema 中的 Revision

#### 7.5 TaskManifest

从 TaskManifest 及编译器删除：

- `revision`；
- `revisionId`；
- `approval.parentRevision`；
- 只为 Revision 链存在的连续性校验。

保留：

- `jobId`；
- canonical task path；
- source hash；
- provider config hash；
- 任务、criteria 和初始用户审批信息。

#### 7.6 Workspace

从 Git snapshot、Candidate 及 builder/verifier 删除 revision：

- `GitWorkspaceSnapshot.revision`；
- `GitCandidate.revision`；
- Revision input/result 链；
- revision 参与的 hash payload。

把 builder 输入收敛成 Run 语义：

```ts
buildGitCandidate({
  runBaseline,
  runResult
});
```

如果仍需保存 repair workspace seed，它是恢复输入，不是 Candidate diff baseline。

#### 7.7 State Store

从 state schema 删除：

- `RunRecord.revision`；
- `gitWorkspace.revisions` map；
- `GitRevisionWorkspace.revision`；
- Worker attempt revision；
- host turn revision；
- publish attempt revision；
- recovery 中的 revision / parentRevision；
- revision 连续性和 active-attempt revision 校验。

`runArtifactInventory()` 改成按当前 Job 的单个 workspace、attempt 和 durable artifact refs 构建清单。

#### 7.8 Protocol 和 Provider

从公开 protocol 和 Provider 接口删除：

- execute/status/result 中的 revision；
- resume/mutation 中的 `expectedRevision`；
- HostAction revision；
- `WorkerRunRequest.revision`；
- `WorkerStartInput.revision`；
- PI Worker event / attempt 中的 revision；
- PI completed session bundle 中的 revision。

Provider 不需要知道 artifact 路径布局，只需要 `jobId`、attempt identity、workspace 和不可变 config hash。

### 阶段三：改造 Daemon 全流程

#### 7.9 WorkerRunner

- 删除 request/run/attempt revision 一致性判断；
- artifact root 固定为 `runs/{jobId}`；
- baseline 只创建一次；
- workspace 从 baseline 或 durable repair seed 重建；
- `gitWorkspace.current` 保存最新 result/candidate；
- session artifact 不再写 revision；
- `matchesAttempt()` 使用 job、fence、attemptId 和 generation；
- protected read paths 不再按 `revision-N` 分区。

#### 7.10 Review

从 pending action、host turn、review artifact 和 leader decision 删除 revision，改为校验：

```text
jobId
taskSourceHash
candidateHash
reviewAttemptId
reviewer session identity
```

Review history 继续保留多轮记录。

#### 7.11 Repair 与 Recovery

Repair continuation 继续持久化：

- source attempt ID；
- repair prompt；
- expected PI session ID；
- session artifact；
- immutable workspace seed snapshot。

删除 continuation 和 recovery epoch 中的 revision。恢复身份改为：

```text
jobId + fence + attemptId + generation
```

崩溃恢复必须继续支持：

- PREPARING repair continuation；
- RUNNING process 已停止后的新 generation；
- workspace 丢失后从 immutable result seed 重建；
- 同一 PI session 恢复。

#### 7.12 Publish

从 publish identity 和 durable attempt 删除 revision。

新的稳定 operation ID 输入为：

```text
projectId
jobId
candidateHash
reviewHash
operationsHash
```

Publish state mutation 继续要求：

- expected state version；
- expected fence；
- expected phase；
- candidate / review / leader bindings；
- operation ID 和 operations hash；
- file-level expected old hash / mode CAS。

删除 `expectedRevision` 不能降低 stale publish 和重复提交保护。

### 阶段四：删除路径、文档和测试中的 Revision 假设

#### 7.13 代码与文件清理

删除或更新：

- `apps/daemon/src/approved-revision.ts`；
- 所有 `revision-1` / `revision-${...}` 路径；
- 所有 `run.revision + 1`；
- 所有 `approve_new_manifest_revision`；
- 所有 `expectedRevision`；
- `gitWorkspace.revisions`；
- `parentRevision`；
- `REVISION_RESULT`；
- 只服务于多 Revision 的 helper、error code 和文案。

不要删除：

- Git 本身对 commit/revision 的通用术语；
- `stateVersion`；
- attempt `generation`；
- repair round counters；
- review history。

#### 7.14 旧设计文档

实现完成后同步更新：

- `docs/plans/persistent-pi-session-review-loop.md`；
- daemon-driven review 设计文档；
- README 中的状态和协议说明；
- 相关 changeset。

旧文档中以下结论将失效：

```text
approved-revision.ts 中已有的新 Revision 能力本身继续存在
```

同 session 自动返修的其他设计保持有效。

## 8. 重点文件范围

### Daemon

- `apps/daemon/src/project-runtime.ts`
- `apps/daemon/src/approved-revision.ts`（删除）
- `apps/daemon/src/runtime-composition.ts`
- `apps/daemon/src/worker-runner.ts`
- `apps/daemon/src/review-runner.ts`
- `apps/daemon/src/review-coordinator.ts`
- `apps/daemon/src/repair-coordinator.ts`
- `apps/daemon/src/repair-continuation.ts`
- `apps/daemon/src/recovery-manager.ts`
- `apps/daemon/src/publish-coordinator.ts`
- `apps/daemon/src/cancel-manager.ts`

### Packages

- `packages/protocol/src/schema/**`
- `packages/state-store/src/schema.ts`
- `packages/task-manifest/src/**`
- `packages/workspace/src/**`
- `packages/provider-core/src/**`
- `packages/provider-pi/src/**`
- `packages/review/src/**`
- `packages/publish/src/**`

### Tests

- `tests/contract/mcp-tools.test.ts`
- `tests/integration/mcp-lifecycle.test.ts`
- `tests/integration/pi-runner.test.ts`
- `tests/integration/daemon-review.test.ts`
- `tests/integration/publish-cas.test.ts`
- `tests/crash/run-recovery.test.ts`
- `tests/e2e/production-repair-loop.test.ts`
- `tests/e2e/installed-package.test.ts`
- state-store、task-manifest、workspace、review、provider 和 publish 单元测试

## 9. 核心正确性风险

本计划不考虑旧数据迁移，但必须保护以下主流程正确性。

### 9.1 Candidate 不能退化成局部 repair diff

Repair workspace 可以从上一轮 result 恢复，但最终 Candidate 必须比较 Run baseline 与最新 result。否则 Publish 会遗漏第一轮或更早轮次的变化。

### 9.2 Task source 必须真正不可变

如果 Worker 每次仍从项目目录读取 live task 文件，那么字段虽已删除，Job 实际上仍可在运行中换任务。必须改为从 durable `run.taskSource` artifact 物化。

### 9.3 删除 expectedRevision 不能削弱 CAS

所有原来同时依赖 revision 的 mutation 都必须确认仍有足够的 `stateVersion`、fence、phase、attempt identity 和 content hash 保护。

### 9.4 Repair 不能扩大原任务授权

Review feedback 只能用于完成现有 acceptance criteria。需要新增任务或扩展范围时必须创建新 Job，不能通过 prompt 绕过不可变 manifest。

### 9.5 Recovery 不能依赖 revision 目录

所有 workspace、session、snapshot 和 containment 恢复路径必须从 `jobId` 和 durable refs 推导，不能残留隐式 `revision-1` 假设。

### 9.6 Publish 必须继续幂等

Operation ID 去掉 revision 后，必须继续由当前 Candidate、Review 和 operations 唯一确定，并支持 crash reconciliation 和重复调用。

## 10. 测试计划

### 10.1 Contract

验证：

- MCP 输入输出不再包含 revision；
- `approve_new_manifest_revision` 不再是合法 action；
- resume 不再接受 revision approval payload；
- `expectedRevision` 被移除；
- status/result 仍提供完成用户决策所需的 job、phase 和 action 信息。

### 10.2 State 与 workspace 单元测试

验证：

- 单 workspace state 可以通过 schema；
- attempt 不依赖 revision；
- snapshot/Candidate hash 不包含 revision；
- Candidate 是 baseline 到最新 result 的累计 diff；
- repair seed 不改变 Candidate baseline；
- artifact inventory 覆盖所有 durable refs。

### 10.3 Worker / Review / Repair 集成测试

验证：

- 首轮 Worker 正常完成；
- completed session bundle 不含 revision；
- Review repair 复用同一 PI session；
- 多轮 repair 的 taskManifest/taskSource refs 始终相同；
- workspace 丢失后可从 durable seed 恢复；
- scope-expanding repair 返回新 Job 要求，而不是修改当前 Job；
- Provider config intentional change 不能修改当前 Job。

### 10.4 Publish 与 Recovery 集成测试

验证：

- Publish operation ID 不依赖 revision；
- crash 后继续对账同一个 operation；
- stale state/fence/candidate/review 仍被拒绝；
- RUNNING recovery 创建新 generation，但不改变任务绑定；
- PREPARING repair continuation 可在 daemon 重启后恢复。

### 10.5 E2E

覆盖：

```text
execute → Worker → Review pass → Publish
execute → Worker → Review repair → resumed Worker → Review pass → Publish
repair 期间 crash → daemon restart → resume → Publish
scope expansion → NEW_JOB_REQUIRED → cancel → execute new Job
```

## 11. 验证命令

至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm exec vitest run --passWithNoTests \
  tests/contract/mcp-tools.test.ts \
  tests/integration/mcp-lifecycle.test.ts \
  tests/integration/pi-runner.test.ts \
  tests/integration/daemon-review.test.ts \
  tests/integration/publish-cas.test.ts \
  tests/crash/run-recovery.test.ts
pnpm exec vitest run --no-file-parallelism --passWithNoTests \
  tests/e2e/production-repair-loop.test.ts \
  tests/e2e/installed-package.test.ts
pnpm --filter @smartflow/daemon build
git diff --check
git diff --cached --check
```

并执行面向业务 revision 的残留搜索，逐项判断：

```text
approve_new_manifest_revision
createApprovedRevision
expectedRevision
parentRevision
run.revision
gitWorkspace.revisions
revision-1
REVISION_RESULT
```

搜索结果中不允许通过把业务 revision 改名来保留同一模型；后续 latest-only 变更还要求应用层 `schemaVersion` 零命中。

## 12. 验收标准

实现完成必须同时满足：

1. 一个 Job 只持有一份 Task source 和 TaskManifest；
2. Job 生命周期内不能替换 Provider config；
3. 自动 repair 不创建或安装新任务定义；
4. 超出原任务范围的变化必须创建新 Job；
5. 生产代码不存在 `approve_new_manifest_revision`；
6. 生产 state 和 protocol 不存在业务 revision / expectedRevision；
7. Artifact 路径不包含 `revision-N`；
8. `gitWorkspace` 不再维护 revision map；
9. Worker attempt、PI session、Review、Recovery 和 Publish 均不依赖 revision；
10. Candidate 始终是 Run baseline 到最新结果的累计变化；
11. state/fence/attempt/hash CAS 仍能拒绝 stale mutation；
12. Repair crash recovery 和同 PI session continuation 保持工作；
13. Publish 幂等和 crash reconciliation 保持工作；
14. 后续 latest-only 断代删除应用层 `schemaVersion`，但不改变本计划的不可变 Job 语义；
15. 不包含旧 revision 数据迁移、dual-read 或 compatibility union。

## 13. 推荐实施顺序

按以下顺序落地，避免在同一次修改中同时改变产品行为和所有存储结构：

1. 删除 `approve_new_manifest_revision` 和 `createApprovedRevision()`；
2. 强制 Job 从 durable taskSource 读取任务；
3. 调整 repair 为“原任务内修复 / 新 Job required”二分语义；
4. 用测试证明 TaskManifest/source/config 在 Job 内不可变；
5. 扁平化 Git workspace 和 artifact 目录；
6. 从 TaskManifest、snapshot、Candidate 和 state schema 删除 revision；
7. 从 protocol、Provider、Review、Recovery 和 Publish 删除 revision；
8. 更新全部测试、文档和 changeset；
9. 运行完整验证及 revision 残留检查。

阶段一结束后业务行为已经满足不可变 Job；阶段二和阶段三负责彻底删除冗余模型。不要跳过阶段一直接全局删字段，否则容易在 repair、recovery 或 publish 路径中留下隐式的新任务晋升行为。
