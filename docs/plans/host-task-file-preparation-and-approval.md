# Host 任务文件生成与用户确认实现计划

> **状态：已实施。**
>
> **实际落点：** `apps/mcp-server/src/server.ts` 与 `README.md` 定义 Host 准备、完整展示和明确确认策略；`packages/workspace/src/git-snapshot.ts`、`git-capability.ts`、`candidate-builder.ts` 实现 control-plane snapshot 隔离与 Candidate 防线；`apps/daemon/src/worker-runner.ts`、`git-publish-source.ts` 实现 immutable source 恢复与 Publish 防线。相关 contract、Host workflow、TaskManifest、Workspace、Worker/Review 和 Publish 测试均已补充。
>
> **验证结果：** 定向 Vitest 回归共 22 个测试文件、85 个测试通过；`pnpm run typecheck` 与 `pnpm run build` 均通过。
>
> 本计划建立 `smartflow_execute` 之前的 Host 准备流程：无论任务来自聊天上下文、一个已有文件或多个已有文件，Host 都先在项目内生成一份符合 SmartFlow 语法的 canonical `tasks.md`，向用户展示磁盘中的完整内容，并只在用户明确确认后计算文件 SHA-256、调用 `smartflow_execute`。
>
> `.smartflow/tasks/**` 被定义为 SmartFlow control-plane 路径：它可以在用户项目中保留供查看和追溯，但不得进入 Git Run baseline、RUN_RESULT、Candidate 或 Publish。Worker workspace 只注入当前 Job 的 immutable task source，Reviewer 读取的 canonical 文件也必须恢复为该确认版本。
>
> 本计划建立在业务 Revision 已移除、一个 Job 只绑定一份不可变 Task source 和 TaskManifest 的模型上，不恢复 `revision`、`revisionId`、`expectedRevision` 或同一 Job 内替换任务定义的能力。

## 1. 问题与核心决策

同一个 Host 会话可能连续处理多批实现任务：第一批任务执行完成后，用户可能在同一聊天窗口中发起第二批任务。每一批任务都需要独立生成、展示和确认，不能覆盖前一批任务文件，也不能复用前一次 execute 的幂等身份。

本计划采用以下模型：

```text
一个 Host 会话
├── 执行请求 A
│   ├── requestId A
│   ├── .smartflow/tasks/<requestId-A>/tasks.md
│   └── Job A
├── 执行请求 B
│   ├── requestId B
│   ├── .smartflow/tasks/<requestId-B>/tasks.md
│   └── Job B
└── 执行请求 C
    ├── requestId C
    ├── .smartflow/tasks/<requestId-C>/tasks.md
    └── Job C
```

因此，项目中可以长期存在多份文件名相同的 `tasks.md`，但它们位于不同的 `requestId` 目录中，完整路径不会重复：

```text
.smartflow/tasks/550e8400-e29b-41d4-a716-446655440000/tasks.md
.smartflow/tasks/6ba7b810-9dad-41d1-80b4-00c04fd430c8/tasks.md
```

核心定义是：

> 一个项目可以存在多份历史 canonical `tasks.md`；一次新的执行请求只生成、确认并执行其中一份。每次新的实现请求必须使用新的 `requestId` 和新的目录。

`requestId` 不是 Host ID、聊天 Session ID、Job ID 或 Revision。它是一次新 execute 请求的幂等身份，在生成任务草稿前创建，并在用户确认后原样传给 `smartflow_execute`。由于 `jobId` 只能由 Daemon 在 execute 成功后创建，不能使用 `jobId` 作为执行前任务文件的目录名。

## 2. 目标与非目标

### 2.1 目标

1. Host 只在用户明确表达实现、修改代码或执行任务的意图时进入准备流程。
2. 聊天上下文、单个任务文件和多个任务文件统一转换成当前执行请求的一份 canonical `tasks.md`。
3. 每次新的实现请求生成新的、文件系统安全且唯一的 `requestId`。
4. canonical 文件固定写入项目内的 `.smartflow/tasks/<requestId>/tasks.md`。
5. 同一 Host 会话中的后续任务不得覆盖或复用之前的任务文件。
6. Host 必须展示从磁盘读取的完整任务文件，并等待用户明确确认。
7. 确认后，Host 对该文件的精确字节计算 SHA-256，并调用现有 `smartflow_execute`。
8. Daemon 继续负责安全读取文件、校验 hash、编译 TaskManifest 和创建不可变 Job。
9. `.smartflow/tasks/**` 不进入 Run baseline、RUN_RESULT、Candidate 或 Publish，且隔离行为不依赖目标项目的 Git ignore 配置。
10. Worker workspace 只注入当前 Job 的 immutable task source，不复制历史 request 目录；Reviewer 读取当前确认版本。
11. Worker、Reviewer、Repair、Recovery 和 Publish 继续消费当前 Job 保存的 Task source、TaskManifest 和运行状态，不使用 Revision。

### 2.2 非目标

本次不实现：

- `tasksPath[]` 或一次 execute 原生接收多个任务文件；
- `smartflow_prepare_tasks`、`smartflow_validate_tasks` 等新 MCP 工具；
- `confirmation: true`、确认 token 或服务端用户身份认证；
- 同一 Job 内修改或替换 Task source / TaskManifest；
- Job 之间的 `parentJobId`、supersede 或自动串联关系；
- 旧任务目录的自动清理策略；
- 对任意第三方 Markdown 方言的 Daemon 兼容层；
- 已确认文件在执行前又被修改等中途变更场景的新设计。

## 3. 必须保持的不变量

### 3.1 每个新执行请求使用新身份

Host 判断用户发起一批新的实现任务后，必须：

```text
生成新的 requestId
→ 创建新的 .smartflow/tasks/<requestId>/ 目录
→ 写入该目录下的 tasks.md
```

不得：

```text
复用上一批任务的 requestId
复用上一批任务的完整 tasksPath
覆盖上一批任务的 tasks.md
把 Host sessionId 当作 requestId
```

复用旧 `requestId` 不只是文件重名问题：相同 payload 会 replay 旧 receipt，不同 payload 会触发 `IDEMPOTENCY_KEY_REUSED`，都不会创建预期的新 Job。

### 3.2 单次执行只绑定一份文件

一次 `smartflow_execute` 继续只接收：

```text
一个 tasksPath
一个 approvedSourceHash
一个 requestId
```

如果输入资料包含多个任务文件，多个文件只属于 Host 的准备输入。Host 必须先将其整理成当前请求的一份 canonical 文件，再调用 execute。Daemon 不负责多文件排序、合并、Task ID 冲突处理或多 hash 组合。

### 3.3 Job 创建后任务合同不可变

execute 成功后：

```text
jobId
+ task source bytes/hash
+ TaskManifest artifact/hash
+ canonical task path
```

共同标识当前 Job 的不可变任务合同。后续 Worker、Review 和自动 Repair 只推进执行结果，不更新任务定义。

用户在第一批 Job 完成后提出新的任务时，Host 应创建新的 `requestId`、新的任务文件，并通过新的 execute 创建新的 Job，而不是在旧 Job 上增加 Revision。

### 3.4 任务文件必须与 Git 产物链隔离

`.smartflow/tasks/**` 是控制 SmartFlow 执行的输入，不是用户要求 Worker 修改和发布的产品代码。它必须满足：

```text
Active project                可以保留当前及历史 tasks.md，供用户查看
RUN_BASELINE                  排除 .smartflow/tasks/**
Worker workspace              只注入当前 Job 的 immutable tasks.md
历史 request 目录             不复制进 Worker workspace
Worker attempt 完成后         从 immutable artifact 恢复当前 tasks.md
RUN_RESULT                    排除 .smartflow/tasks/**
Candidate                     不允许该前缀的 ADD/MODIFY/DELETE
Publish                       不允许该前缀的 operation
```

当前 baseline 使用 Git tracked 文件和未跟踪、未忽略文件，而 RUN_RESULT 会扫描 workspace 全部普通文件。如果不增加统一隔离：

- `.smartflow/` 未被忽略时，当前及历史任务文件会进入 baseline 和每个隔离 workspace；
- `.smartflow/` 被忽略时，当前文件不在 baseline，但会由 Daemon 注入 workspace，随后被 RUN_RESULT 识别为 `ADD`；
- active project 中该文件已经由 Host 创建，Publish preflight 会因为 `EXPECTED_ABSENT` 冲突而阻塞整个发布。

因此隔离规则必须由 SmartFlow 自身实施，不能依赖用户是否将 `.smartflow/` 写入 `.gitignore`。无论 ignored、untracked 还是 tracked，`.smartflow/tasks/**` 都不得进入代码 Candidate。

## 4. Host 目标流程

### 4.1 意图门

Host 收到用户消息后先判断意图：

| 用户意图 | Host 行为 |
| --- | --- |
| 明确要求实现、修改代码或执行任务 | 进入任务准备流程 |
| 只要求解释、评估、讨论或制定计划 | 正常回复，不生成执行任务文件，不调用 execute |
| 普通闲聊 | 正常回复，不生成执行任务文件，不调用 execute |
| 有实现意图但缺少关键目标、范围或验收标准 | 明确告诉用户缺少的信息并等待补充，不自行编造，不调用 execute |

用户最初的“帮我实现”只授权 Host 准备并展示任务草稿，不等于授权执行。

### 4.2 收集输入资料

实现意图明确后，Host 可以使用：

1. 当前聊天上下文；
2. 用户指定的一个任务或 Spec 文件；
3. 用户指定的多个任务或 Spec 文件；
4. 文件内容与聊天补充信息的组合。

多个输入文件可以保留各自的模块边界，但必须统一 Task ID、目标路径和验收格式，最终写入当前请求的一份 canonical `tasks.md`。Host 不修改用户原始输入文件。

### 4.3 创建请求身份与文件路径

在写任务文件之前，Host 为本批新任务生成新的唯一 `requestId`。推荐使用 UUID 或等价的文件系统安全唯一值。

目标相对路径固定为：

```text
.smartflow/tasks/<requestId>/tasks.md
```

完整路径为：

```text
<projectRoot>/.smartflow/tasks/<requestId>/tasks.md
```

Host 创建目录并写入文件时，应保留同一项目下已有的其他 request 目录。

### 4.4 生成 SmartFlow canonical 格式

Host 生成的文件必须符合 `packages/task-manifest/src/tasks-parser.ts` 当前支持的语法：

- 模块标题使用 `## M01 ...`；
- 任务使用 `- [ ] T001 ...`；
- 标签只使用 `[M01]` 形式的模块标签；
- 每个任务描述中包含至少一个反引号包裹的目标路径；
- 描述与验收标准之间使用精确分隔符 ` — 验收：`；
- Task ID 在当前 canonical 文件内全局唯一；
- 至少包含一个未完成任务。

示例：

```md
## M01 用户认证

- [ ] T001 [M01] 在 `src/auth/login.ts` 实现登录校验 — 验收：有效账号可以登录，错误密码返回明确错误
- [ ] T002 [M01] 在 `src/auth/login.test.ts` 补充登录场景测试 — 验收：成功和失败场景均有覆盖
```

外部 `task.md`、`tasks.md` 或 Spec 文件不是因为扩展名正确就一定能被 SmartFlow parser 接受。Host 的职责是将来源内容转换成以上 canonical 格式，而不是直接把任意 Markdown 文件交给 Daemon。

### 4.5 完整展示并请求确认

文件写入后，Host 必须重新读取磁盘文件，并向用户展示：

1. 当前 canonical 文件的项目相对路径；
2. 本次使用的输入资料路径（如果存在）；
3. 磁盘中 `tasks.md` 的完整内容；
4. 明确问题：是否确认执行以上任务。

只展示摘要、任务数量、diff 或部分内容不能替代完整展示。

用户必须针对当前展示内容作出明确确认。没有明确确认时，Host 不得调用 `smartflow_execute`。

### 4.6 计算 hash 并执行

确认后，Host 对已确认文件的精确字节计算 SHA-256，并调用：

```ts
smartflow_execute({
  projectRoot,
  tasksPath: ".smartflow/tasks/<requestId>/tasks.md",
  approvedSourceHash,
  requestId
});
```

`tasksPath` 中的 `<requestId>` 必须与 execute 输入的 `requestId` 相同。Host 不生成或传递任何 Revision 字段。

Daemon 继续执行：

```text
安全读取 projectRoot 内的普通文件
→ 校验 sha256(sourceBytes) === approvedSourceHash
→ compileTaskManifest(sourceBytes, ...)
→ 保存 runs/<jobId>/task-source.md
→ 保存 runs/<jobId>/task-manifest.json
→ 创建不可变 Job
```

### 4.7 同一 Host 的下一批任务

当前 Job 完成后，如果同一 Host 会话收到新的实现请求：

```text
旧请求 A / requestId A / tasks.md A / Job A 已完成
→ 用户提出新的实现任务
→ Host 生成 requestId B
→ Host 写入新的 tasks.md B
→ 完整展示 tasks.md B
→ 用户明确确认
→ 使用 requestId B 调用 execute
→ Daemon 创建 Job B
```

旧文件不参与新 Job，也不被覆盖：

```text
.smartflow/tasks/<requestId-A>/tasks.md  # 第一批任务，保留在 active project
.smartflow/tasks/<requestId-B>/tasks.md  # 第二批任务，新建并作为当前输入
```

准备 Job B 的 workspace 时，历史目录 A 不进入 baseline 或 workspace；只有 Job B 的 immutable task source 被注入 canonical path。

## 5. 文件位置与所有权

### 5.1 项目内的用户可见 control-plane 文件

Host 生成的文件位于用户项目内：

```text
<projectRoot>/.smartflow/tasks/<requestId>/tasks.md
```

该文件不位于 MCP npm 包、构建产物或 `node_modules` 中。MCP 构建和安装不会预先创建它；Host 在用户发起具体实现请求时，使用宿主自身的文件能力动态创建。

`.smartflow/tasks/**` 是 SmartFlow 保留的 control-plane 前缀，不用于存放应由 Worker 修改和发布的产品源码。用户是否将它加入 `.gitignore`，不得改变 SmartFlow 的 baseline、Candidate 和 Publish 结果。

### 5.2 Daemon 内部运行快照

execute 成功后，Daemon 会把确认后的来源保存到自己的数据目录。macOS 默认形态为：

```text
~/Library/Application Support/smartflow/daemon/projects/<projectId>/runs/<jobId>/task-source.md
~/Library/Application Support/smartflow/daemon/projects/<projectId>/runs/<jobId>/task-manifest.json
```

使用 `smartflow mcp --data-dir <path>` 时，内部根目录由配置覆盖。

文件职责如下：

| 文件 | 所有者 | 用途 | 是否进入代码 Candidate |
| --- | --- | --- | --- |
| `.smartflow/tasks/<requestId>/tasks.md` | Host / 用户项目 | 执行前查看、确认和后续追溯 | 否 |
| `runs/<jobId>/task-source.md` | Daemon | 当前 Job 的不可变来源 artifact | 否 |
| `runs/<jobId>/task-manifest.json` | Daemon | 运行阶段的结构化任务合同 | 否 |

### 5.3 Worker 与 Reviewer 中的 canonical 文件

Worker 不修改 Daemon 保存的 immutable task source。准备每次 Worker attempt 时，Daemon 执行：

```text
materialize 不含 .smartflow/tasks/** 的 input snapshot
→ 从 runs/<jobId>/task-source.md 注入当前 canonical path
→ Worker 执行
→ attempt 完成后再次从 immutable artifact 恢复 canonical path
→ 捕获排除 .smartflow/tasks/** 的 RUN_RESULT
→ Reviewer 从恢复后的 canonical path 读取当前确认内容
```

Repair attempt 继续复用同一 Job 的 result snapshot 和 PI session；由于 result snapshot 不包含任务控制文件，每次准备 workspace 时仍由 `syncCanonicalTask()` 注入同一份 immutable source。

## 6. 协议保持不变

`packages/protocol/src/schema/mcp-tools.ts` 中的 execute 输入继续保持：

```ts
{
  projectRoot,
  tasksPath,
  approvedSourceHash,
  requestId
}
```

字段职责：

- `projectRoot`：用户项目根目录；
- `tasksPath`：当前请求唯一 canonical 文件的项目相对路径；
- `approvedSourceHash`：用户已确认文件精确字节的 SHA-256；
- `requestId`：当前新 execute 请求的唯一幂等身份，同时用于隔离任务目录；

不新增：

```text
revision
revisionId
expectedRevision
parentRevision
taskPaths[]
approvedSourceHashes[]
confirmation: true
```

`approvedSourceHash` 可以保证 Daemon 执行的是 Host 提交的那份精确文件，但服务端无法仅凭 hash 证明用户确实表达过确认。最小实现将“完整展示并等待明确确认”定义为 Host policy，不增加确认 token 或新工具。

## 7. 文件级实施计划

### 7.1 `apps/mcp-server/src/server.ts`

将 pre-execution Host policy 放到 MCP server instructions 最前面，并建议把完整 instructions 导出为常量，供契约测试直接验证。

instructions 必须按顺序告诉 Host：

1. 先执行实现意图门，闲聊、解释、评估和纯规划不得 execute；
2. 信息不足时向用户提问，不编造关键目标、范围或验收标准；
3. 每批新的实现任务生成新的唯一 `requestId`，包括同一 Host 会话中的后续任务；
4. 将聊天、单文件或多文件输入统一转换成一份 canonical SmartFlow 文件；
5. 写入 `.smartflow/tasks/<requestId>/tasks.md`，不得覆盖旧 request 目录；
6. 重新读取并展示磁盘文件的完整内容；
7. 等待用户针对当前内容明确确认；
8. 确认后对精确文件字节计算 SHA-256；
9. 使用同一个 `requestId`、对应 `tasksPath` 和 hash 调用 `smartflow_execute`；
10. 不创建、跟踪或传递业务 Revision。

同时更新 `smartflow_execute` 的工具描述，明确：

- 该工具不负责规划或生成任务；
- 只能执行已经写入项目、完整展示并由用户确认的 canonical 文件；
- 每批新任务使用新的 `requestId`；
- `approvedSourceHash` 由 Host 根据确认文件计算，不能伪造 Daemon 内部 hash。

现有六个 MCP 工具保持不变：

```text
smartflow_execute
smartflow_review_turn
smartflow_status
smartflow_resume
smartflow_cancel
smartflow_result
```

### 7.2 `README.md`

新增 “Host task preparation and approval” 文档，说明：

- 哪些用户意图会进入准备流程；
- 三类输入如何归一化；
- 每个新执行请求生成独立 request 目录；
- 同一 Host 连续任务的路径示例；
- canonical SmartFlow 模板；
- 完整展示和明确确认要求；
- `.smartflow/tasks/**` 是不进入代码 Candidate 的 control-plane 前缀；
- ignored、untracked 或 tracked 状态不改变隔离行为；
- 项目内文件与 Daemon 内部 artifact 的区别；
- 文件由 Host 原生文件能力创建，不由 MCP 安装包预置。

### 7.3 `tests/helpers/host-workflow/planner.ts`

当前测试草稿使用：

```ts
interface TasksDraft {
  revision: number;
}
```

该字段只表示确认前第几次草稿编辑，不是业务 Revision。为避免继续传播已删除的概念，将其改名为：

```ts
interface TasksDraft {
  draftNumber: number;
}
```

同步更新引用和断言。该改名不进入生产协议或 Job 状态。

### 7.4 `tests/helpers/host-workflow/approval.ts`

保留现有职责：

- 为用户确认内容计算 SHA-256；
- 在 execute 前读取项目内普通文件；
- 校验文件与确认 hash 一致；
- 调用 `smartflow_execute`。

扩展测试输入，使 `tasksPath` 使用：

```text
.smartflow/tasks/<requestId>/tasks.md
```

并断言路径中的 ID 与 execute `requestId` 一致。若不希望把路径约束固化到通用 approval helper，可在 Host workflow 场景测试中完成该断言，不修改协议 helper 的通用路径能力。

### 7.5 `packages/workspace/src/git-snapshot.ts`

增加统一的 SmartFlow control-plane 路径判断，至少保留以下前缀：

```text
.smartflow/tasks/
```

同一判断必须同时应用于：

- RUN_BASELINE 的 `effectivePaths()` 结果；
- `includeAllFiles: true` 时 RUN_RESULT 的 `allWorkspacePaths()` 结果。

目标行为：

```text
tracked .smartflow/tasks/**      排除
untracked .smartflow/tasks/**    排除
ignored .smartflow/tasks/**      排除
```

如果现有 `inclusionPolicyHash` 表达 snapshot 路径策略，本次必须同步更新该策略身份，使旧策略生成的 snapshot 不能被误当成新策略 snapshot 复用。

### 7.6 `apps/daemon/src/worker-runner.ts`

保留 `syncCanonicalTask()`，但明确它是当前任务文件进入隔离 workspace 的唯一入口：

1. materialize baseline/input snapshot 后，从 `run.taskSource` 注入当前 canonical path；
2. 不从 active project 或历史 request 目录复制任务文件；
3. Worker attempt 完成后、捕获 RUN_RESULT 和进入 Review 前，再次调用等价同步逻辑恢复 immutable source；
4. RUN_RESULT 依赖统一 snapshot policy 排除该路径；
5. Repair workspace 每轮继续从当前 Job artifact 注入同一份任务文件。

这样即使 workspace 中的 canonical 文件曾发生变化，也不会进入 Candidate，Reviewer 看到的仍是用户确认版本。

### 7.7 Candidate 与 Publish 边界保护

在 snapshot 排除之外增加防御性不变量：

- `packages/workspace/src/candidate-builder.ts` 生成或校验 Candidate 时，不允许 `.smartflow/tasks/**` 的 `ADD`、`MODIFY` 或 `DELETE`；
- `apps/daemon/src/git-publish-source.ts` 转换 Publish operations 时，再次拒绝该前缀；
- 拒绝应作为内部不变量错误或安全暂停处理，不得静默发布控制文件。

正常路径中 snapshot 已经排除这些文件，因此 Candidate 不会包含它们；边界保护用于防止后续实现变化重新把 control-plane 文件带入发布链。

### 7.8 保持不变的生产契约

本计划仍不要求改变：

- `packages/protocol/src/schema/mcp-tools.ts` 的 execute 字段形状；
- `apps/daemon/src/project-runtime.ts` 的 task 文件安全读取、hash 校验和 manifest 编译；
- Reviewer 的 Task coverage 与 gate；
- Repair continuation 和同 Job 自动返修模型；
- Recovery 身份模型；
- Publish operation identity 的 hash 组成；
- state store 的 `stateVersion`、fence、attempt 和 generation 保护。

Workspace snapshot 路径策略、Worker canonical 文件同步和 Candidate/Publish 路径边界属于本计划必须修改的生产主链，不再声明整个 Daemon/Workspace/Publish 链无需修改。

## 8. 测试计划

### 8.1 MCP instructions 契约测试

新增：

```text
tests/contract/mcp-server-instructions.test.ts
```

断言 instructions 和 execute 描述覆盖以下语义：

- 实现意图门；
- 闲聊、解释和纯规划不执行；
- 信息不足时询问用户；
- 每个新实现请求创建新的 `requestId`；
- 同一 Host 会话后续任务不得复用旧 ID 或覆盖旧文件；
- 固定 `.smartflow/tasks/<requestId>/tasks.md` 路径；
- 单文件、多文件和聊天输入都归一化为当前请求的一份 canonical 文件；
- 展示磁盘中的完整内容；
- 等待明确确认；
- 确认后计算 hash 并 execute；
- 不使用 Revision；
- 工具集合仍为现有六个。

测试应断言关键语义和关键路径，不对整段自然语言做脆弱的全文快照。

### 8.2 Host workflow unit tests

扩展现有：

```text
tests/unit/helpers/host-workflow/workflow.test.ts
```

并按职责增加 planner/approval 测试，覆盖：

1. 没有确认快照时不调用 execute；
2. 确认文件的 hash 被传为 `approvedSourceHash`；
3. execute 使用项目相对路径；
4. 请求 A 写入 `.smartflow/tasks/<requestId-A>/tasks.md`；
5. 同一 Host 的新请求 B 写入 `.smartflow/tasks/<requestId-B>/tasks.md`；
6. A、B 的完整路径不同，A 的内容未被 B 覆盖；
7. A、B 调用 execute 时分别使用对应的 requestId、tasksPath 和 hash；
8. `PlanningSession` 使用 `draftNumber`，不再出现业务含义不清的 `revision`。

### 8.3 TaskManifest parser fixture

增加一份代表 Host canonical 输出的 fixture，交给 `compileTaskManifest` 验证：

- 模块标题可解析；
- Task ID 唯一；
- 模块标签可解析，`[P]` 等其他标签一律拒绝；
- 反引号目标路径可提取；
- ` — 验收：` 可提取 acceptance criteria；
- 至少一个 enabled task。

这保证 Host instructions 中展示的模板与真实 parser 不会漂移。

### 8.4 Workspace control-plane unit tests

扩展 `tests/unit/packages/workspace`，覆盖：

1. 未忽略且未跟踪的 `.smartflow/tasks/**` 不进入 RUN_BASELINE；
2. tracked 的 `.smartflow/tasks/**` 也不进入 RUN_BASELINE；
3. ignored 与 non-ignored 两种项目配置得到相同的任务路径排除结果；
4. `includeAllFiles: true` 的 RUN_RESULT 不包含注入的当前任务文件；
5. 历史 request 目录不进入 materialized workspace；
6. 普通产品源码仍按现有 inclusion policy 捕获；
7. snapshot inclusion policy identity 随新规则更新。

### 8.5 Worker、Candidate 与 Review tests

增加针对 Worker workspace 的测试，验证：

1. materialize 完成后只有当前 Job 的 canonical `tasks.md` 被注入；
2. 注入字节与 `run.taskSource` artifact 完全一致；
3. Worker attempt 完成后，Review 前的 canonical 文件再次与 immutable artifact 一致；
4. RUN_RESULT 和 Candidate operations 不包含 `.smartflow/tasks/**`；
5. Repair attempt 仍能重新注入同一份 canonical task source；
6. Candidate builder 拒绝手工构造的 control-plane operation。

### 8.6 Publish boundary tests

扩展 Publish/preflight 测试，验证：

1. ignored 与 non-ignored 两种项目配置都不会为任务文件生成 `ADD`；
2. 任务文件已经存在于 active project 时不会产生 `EXPECTED_ABSENT` 发布冲突；
3. `git-publish-source` 拒绝 `.smartflow/tasks/**` operation；
4. 普通代码 Candidate 和 Publish 行为保持不变。

### 8.7 MCP lifecycle integration

扩展：

```text
tests/integration/mcp-lifecycle.test.ts
```

验证：

1. Host 在项目内创建 `.smartflow/tasks/<requestId>/tasks.md`；
2. 文件字节的 SHA-256 与 execute 输入一致；
3. execute 成功创建不可变 Job；
4. Daemon 保存的 `task-source.md` 与确认文件内容一致；
5. 保存的 TaskManifest 包含预期任务；
6. execute 输入和输出均不包含 Revision；
7. 两个新 request 使用不同目录和不同幂等 ID，不覆盖彼此的项目文件；
8. 历史 request 文件不进入后续 Job workspace；
9. `.smartflow/` ignored 和 non-ignored 两种 fixture 均可完成 Candidate/Publish，不发布任务控制文件。

不为本计划新增用户确认后又修改 active project 文件等额外场景。

## 9. 实施顺序

1. 在 workspace 层定义 `.smartflow/tasks/**` control-plane 路径策略，并同步更新 inclusion policy identity。
2. 在 RUN_BASELINE 和 RUN_RESULT 捕获中应用同一排除规则。
3. 更新 WorkerRunner：只注入当前 immutable task source，并在 Review 前恢复确认版本。
4. 在 Candidate 和 Publish 边界拒绝 control-plane operations。
5. 增加 workspace、Worker、Candidate 和 Publish 隔离测试。
6. 导出并更新 `apps/mcp-server/src/server.ts` 的 server instructions。
7. 更新 `smartflow_execute` 工具描述。
8. 新增 MCP instructions 契约测试。
9. 将测试草稿字段 `revision` 改为 `draftNumber`。
10. 扩展 Host workflow unit tests，覆盖同一 Host 的连续 request 和目录隔离。
11. 增加 canonical tasks fixture 和 parser 测试。
12. 扩展 MCP lifecycle integration，覆盖 ignored/non-ignored 和连续 request。
13. 更新 README。
14. 运行针对性测试、typecheck 和 build。

## 10. 验证命令

```bash
pnpm exec vitest --run tests/contract/mcp-server-instructions.test.ts
pnpm exec vitest --run tests/unit/helpers/host-workflow
pnpm exec vitest --run tests/unit/packages/task-manifest
pnpm exec vitest --run tests/unit/packages/workspace
pnpm exec vitest --run tests/unit/apps/daemon
pnpm exec vitest --run tests/unit/packages/publish
pnpm exec vitest --run tests/integration/mcp-lifecycle.test.ts
pnpm run typecheck
pnpm run build
```

实现完成后，至少必须通过 instructions、Host workflow、parser、workspace snapshot、Worker/Review、Candidate/Publish、MCP lifecycle、typecheck 和 build 验证。完整端到端 Provider 测试可按受影响测试布局补充执行。

## 11. 验收标准

实现完成后必须满足：

1. Host 仅在明确的实现或执行意图下准备任务。
2. 信息不足时 Host 请求用户补充，不编造关键需求。
3. 每批新的实现任务都生成新的唯一 `requestId`。
4. 同一个 Host 会话可以依次生成多份 `tasks.md`，但完整路径均不同。
5. 新任务文件不会覆盖之前执行使用的任务文件。
6. 每次 execute 只绑定当前请求的一份 canonical `tasks.md`。
7. 用户能在执行前看到磁盘文件的完整内容。
8. 没有明确确认时不调用 `smartflow_execute`。
9. execute 的 `tasksPath`、`approvedSourceHash` 和 `requestId` 对应同一份当前请求文件。
10. Daemon 校验 hash、编译 TaskManifest，并为每个 Job 保存不可变 source/manifest artifact。
11. `.smartflow/tasks/**` 无论 tracked、untracked 或 ignored，都不进入 RUN_BASELINE 和 RUN_RESULT。
12. 历史 request 目录不进入后续 Job 的 Worker workspace。
13. Worker workspace 只注入当前 Job 的 immutable canonical task source。
14. Reviewer 读取的 canonical 文件与用户确认后保存的 Daemon artifact 字节一致。
15. Candidate 不包含 `.smartflow/tasks/**` 的 `ADD`、`MODIFY` 或 `DELETE`。
16. Publish 永远不会写入或删除 `.smartflow/tasks/**`。
17. `.smartflow/` ignored 与 non-ignored 两种项目配置不会因为任务文件产生 Publish 冲突。
18. Repair 每轮继续使用同一 Job、同一 TaskManifest 和同一 task source。
19. 全链路不恢复业务 Revision。
20. execute schema 和 MCP 六工具集合保持不变。

最终目标生命周期为：

```text
新实现请求
→ 新 requestId
→ 新 .smartflow/tasks/<requestId>/tasks.md
→ 展示完整内容
→ 用户明确确认
→ 计算文件 SHA-256
→ smartflow_execute
→ Daemon 保存 immutable source/manifest
→ baseline 排除所有 .smartflow/tasks/**
→ workspace 只注入当前 immutable tasks.md
→ Worker
→ 恢复当前 immutable tasks.md
→ RUN_RESULT / Candidate 排除 control-plane 路径
→ Review / Repair / Publish
→ 下一批新任务再次从“新 requestId”开始
```
