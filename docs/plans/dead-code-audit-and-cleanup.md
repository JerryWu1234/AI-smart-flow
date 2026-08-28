# 死代码审计与分批清理计划

> **状态：已实施（2026-08-28）；完整验证与最终复核见第 11、12 节。**
>
> **审计基线：** 2026-08-28，当前工作树位于 `main@914dc8d`，本地比 `origin/main` 超前 1 个提交，并包含大量 staged / unstaged 改动。本计划以审计时磁盘中的当前工作树为准，不以 `origin/main` 或单独的 `HEAD` 快照为准。
>
> **审计结论：** 当前 3 个 app、9 个 package 中，没有发现同时对生产入口、测试、脚本、配置和 package exports 都完全不可达的 TypeScript 源文件。可清理内容主要是局部未使用符号、仅测试或兼容 API、过宽的 private workspace 导出，以及旧 state / Git evidence 模型遗留字段。
>
> **后续格式决策：** `实现计划.md` 已进一步采用 latest-only 断代，删除 ProjectState 与 artifact 的应用层 `schemaVersion`，并将 SQLite 物理 schema 提升到 5、删除 `document_schema_version` 镜像；本计划中关于 v7/layout 4 的历史实施记录由该后续决策取代。
>
> **实施结果：** Batch A–E 已按本计划落地。`RESUMABLE` / `RESUME_WORKER` 因无生产 reattachment producer 被删除；provider SPI 身份与 containment 字段保留；无运行时消费者的 `workspace` / `publish` 配置改为拒绝解析；Publish apply 前后 fault hooks 因确定性 crash-window 覆盖而保留并注明用途。ProjectState 删除 patch / evidence 槽位与 semantic，并将 `workspace` 收敛为 `{ relativePath }`。旧数据不提供 migration、dual-read 或 fallback，开发环境升级前须执行 `pnpm clean:daemon-data`；private workspace barrel 已收窄，同时保留 Pi worker、model extension、daemon、MCP 和 Review adapter 动态入口。
>
> 本计划只整理删除边界和实施顺序，不在同一变更中顺带重构仍然活跃的 Review、Publish、Pi session 或 Git workspace 主链。

## 1. 目标与非目标

### 1.1 目标

1. 删除当前生产和测试均无消费者的局部死代码。
2. 将仅测试使用、但已被生产实现取代的兼容 API 迁移到真实生产入口后删除。
3. 清理 Candidate v2 / patch evidence 模型遗留的 state 字段和 artifact semantic。
4. 收窄 private workspace package 的无消费者导出面。
5. 保留所有动态入口、配置驱动入口、故障注入点和持久化协议必须字段。
6. 每一批清理都能独立验证和回滚，不把低风险删码与 schema 迁移混在同一个提交中。

### 1.2 非目标

本计划不直接实施：

- Review gate 与 leader decision 的架构合并；
- HostAction / HostTurn 状态模型重设计；
- Codex CLI 与 Codex Desktop adapter 生命周期抽象；
- Publish 多层 preflight / capability check 的统一；
- PI model extension 与 runtime config 校验逻辑重构；
- 新的 worker reattachment 或 daemon 重启续接能力；
- 为 private workspace package 建立新的外部兼容承诺；
- 与死代码无关的大规模命名、目录或格式重构。

这些区域存在重复或可优化之处，但仍在生产调用链上，不属于可直接删除的死代码。

## 2. 审计口径

### 2.1 真实入口

本次可达性分析从以下入口开始：

- 根 CLI bundle：`apps/cli/src/main.ts`；
- daemon 启动与 IPC：`apps/daemon/src/main.ts`、`ProjectRuntime.handle()`；
- MCP server 和六个 tool registration；
- 各 workspace package 的 `src/index.ts` 和 `package.json#exports`；
- `packages/provider-pi/src/worker-entry.ts`；
- `packages/provider-pi/src/mcp-model-extension.ts`；
- 根与 workspace `tsdown` entries；
- release scripts、CI、测试 aliases、fixtures 和测试深路径 import。

不能只按普通 TypeScript import 判断以下入口：

```text
smartflow mcp
→ connectOrLaunchDaemon()
→ spawn(node, [smartflowEntry, "daemon", ...])

PiProvider
→ 计算 sibling worker-entry 路径
→ 启动独立 RPC child
→ 通过 --extension 动态加载 mcp-model-extension
```

### 2.2 候选分类

| 分类 | 定义 | 处理方式 |
| --- | --- | --- |
| 完全不可达 | 生产、测试、配置、脚本、exports 均无入口 | 可直接删除文件 |
| 局部死代码 | 文件活跃，但某个参数、字段、函数或 hook 无消费者 | 第一批删除 |
| 生产不可达、仅测试使用 | 生产已经有替代路径，旧 API 只为测试存在 | 迁移测试后删除 |
| 过宽导出 | 实现活跃，但不需要作为 package API 暴露 | 收窄 export，不删实现 |
| schema 残留 | 当前无 producer，但仍存在于 strict 持久化格式 | 单独版本化清理 |
| 动态可达 | spawn、extension loader、字符串 dispatch、配置工厂使用 | 明确保留 |

### 2.3 仓外消费者边界

所有 workspace app/package 当前均为 `private: true`，唯一发布到 npm 的是根 `@jerrywu1234/smartflow`，且根 package 只公开 `dist/smartflow.mjs`。因此，private workspace barrel 的收窄风险较低。

本计划仍把 export 收窄和实现删除分开：即使没有仓内消费者，也不以“private”为理由顺带删除仍被内部生产代码调用的实现。

## 3. 总体结论

### 3.1 文件级结论

- 没有完全不可达的 `.ts` 文件。
- `packages/state-store/src/mutation.ts` 是生产不可达、仅测试使用的完整兼容模块，迁移测试后可整文件删除。
- `packages/review/src/agents/claude/code-cli/.gitkeep` 与 `packages/review/src/agents/claude/desktop/.gitkeep` 是无消费者的空目录占位文件，可直接删除。
- `dist/**`、source map、workspace link 和 pnpm store 均为生成物或依赖镜像，不作为源码死代码候选。

### 3.2 实施批次

```text
Batch A：零行为风险的局部删除
→ Batch B：迁移测试后删除生产不可达兼容 API
→ Batch C：记录产品决策后删除条件能力
→ Batch D：state / artifact schema 版本化清理
→ Batch E：收窄 private workspace export surface
```

Batch A、B、D 不应合并为一个大提交。

## 4. Batch A：零行为风险局部删除

### A01. 删除未使用的 `run` 参数

位置：

- `apps/daemon/src/host-turn-coordinator.ts`；
- 私有方法 `resumeReviewDecision(input, state, run, turn)`；
- 唯一调用点位于同文件的 `answer === "resume_review_decision"` 分支。

证据：额外启用 `noUnusedLocals` / `noUnusedParameters` 后，TypeScript 只报告该参数未读取。

实施：

1. 从私有方法签名删除 `run`；
2. 从唯一调用点删除对应实参；
3. 不修改该方法内部 artifact 校验、mutation 和 outcome 调度。

### A02. 删除 `resolveRunDataDirectory()`

位置：`apps/daemon/src/data-dir.ts`。

证据：除定义和 `apps/daemon/src/index.ts` 的 wildcard re-export 外，无源码、测试、脚本或配置引用。当前运行目录均直接使用扁平的 `runs/{jobId}/...` 模型。

实施：

1. 删除函数；
2. 确认 daemon barrel 不再生成该导出；
3. 保留 `resolveInstallationDataDirectory()` 和 `resolveProjectDataDirectory()`。

### A03. 删除未启用的 `beforeCandidateArtifact` hook

位置：`apps/daemon/src/worker-runner.ts`：

- `WorkerRunnerHooks`；
- `WorkerRunnerOptions.hooks`；
- `WorkerRunner.hooks` 字段；
- Candidate artifact 写入前的 optional invocation。

证据：所有生产与测试构造点都未传入该 hook。当前测试也没有依赖该 race/fault injection seam。

实施后保留 `WorkerRunnerOptions.logger`，不要删除 WorkerRunner 的日志注入。

### A04. 删除游离的 `projectSchema` / `Project`

位置：`packages/protocol/src/schema/common.ts`。

证据：

- 只经 `packages/protocol/src/index.ts` wildcard 导出；
- 不组成 MCP schema；
- 不组成 state-store 的 `projectStateSchema`；
- 没有 app、package、test、fixture 或 script 消费者。

实施时只删除 `projectSchema` 及其派生 `Project` 类型，保留 common schema 中的 artifact、error、canonical value 和 receipt 定义。

### A05. 收窄 `PiRuntimeResources`

位置：`packages/provider-pi/src/runtime-resources.ts`。

可删除返回字段：

- `runtimeDirectory`；
- `sessionDirectory`。

证据：`PiProvider` 只读取 `resources.spawnRequest`。两个同名局部变量仍用于 child argv、HOME、TMP 和 session directory，不能删除局部计算。

目标结构：

```ts
interface PiRuntimeResources {
  spawnRequest: SandboxedSpawnRequest;
}
```

也可以在后续重构中直接返回 `SandboxedSpawnRequest`，但本批只做最小收窄。

### A06. 删除无效果的 stderr redaction handler

位置：`packages/provider-pi/src/pi-provider.ts`。

当前逻辑对每个 stderr chunk 调用 `redactPiValue()`，但丢弃返回值且不记录任何内容。`redactPiValue()` 本身没有副作用。

实施：

- 删除 `handle.stderr.on("data", ...)`；
- 保留 `handle.stderr.resume()`，继续避免 pipe backpressure；
- 不新增 stderr 日志，避免无意扩大敏感信息输出面。

### A07. 删除无人传入的 `workerEntryPath` option

位置：`PiProviderOptions.workerEntryPath` 及 `PiProvider.start()` 向 `createPiRuntimeResources()` 传递的第四个实参。

证据：全仓没有生产或测试构造者传入该 option。生产始终通过 `runtime-resources.ts` 的 sibling `.js` / `.mjs` 路径发现 worker entry。

注意：只删除 override option，不能删除默认路径发现逻辑、worker entry 文件或 tsdown entry。

### A08. 删除重复类型别名 `GitCandidate`

位置：`packages/workspace/src/candidate-builder.ts`。

当前：

```ts
export type GitCandidate = GitCandidateV3;
export type Candidate = GitCandidateV3;
```

仓内消费者统一使用 `Candidate` 或 `GitCandidateV3`，没有 `GitCandidate` named consumer。删除前者即可。

### A09. 删除 Claude 空目录占位

删除：

```text
packages/review/src/agents/claude/code-cli/.gitkeep
packages/review/src/agents/claude/desktop/.gitkeep
```

当前 Review strategy 只支持 `codex` 与 `codex-desktop`，没有 Claude 配置值、factory 或源码实现。

### Batch A 验收

- 上述符号全仓零命中；
- Pi worker 和 extension 构建产物仍生成；
- daemon、MCP 和 root bundle 均可构建；
- 不修改 state schemaVersion、artifact bytes 或 wire protocol。

## 5. Batch B：迁移测试后删除生产不可达代码

### B01. 删除 `CancelManager.request()`

位置：`apps/daemon/src/cancel-manager.ts`。

当前生产链：

```text
smartflow_cancel
→ ProjectRuntime.cancel()
→ 持久化 CANCELING
→ CancelManager.reconcile()
```

`CancelManager.request()` 在生产中没有调用者，只有 crash tests 直接使用；它重复实现了 `ProjectRuntime.cancel()` 的请求阶段。

迁移：

1. crash tests 改走 `ProjectRuntime.handle("smartflow_cancel", ...)`；或
2. 测试只需要 reconciliation 时，fixture 直接准备合法 `CANCELING` state；
3. 删除 `CancelManager.request()`；
4. 保留 `CancelManager.reconcile()`、`CancellationRuntime` 和 `CancellationResult`。

### B02. 删除 `ProjectMutationSession` 兼容模块

位置：

- `packages/state-store/src/mutation.ts`；
- `packages/state-store/src/index.ts` 对该模块的 export。

生产 daemon 已使用 `apps/daemon/src/project-mutation-executor.ts` 作为唯一 mutation 入口。`ProjectMutationSession` 当前只服务 idempotency、state concurrency 和 crash 测试。

迁移要求：

1. 将相关测试改为覆盖生产 `ProjectMutationExecutor`；
2. 确认 fence、expected state version、idempotency replay 和 stale mutation 场景仍被覆盖；
3. 删除整个 `mutation.ts`；
4. 删除 state-store barrel export；
5. 不复制一份新的测试专用 mutation 实现。

目标是消除两套 fence / idempotency 逻辑，而不是把旧实现换一个目录继续保留。

### B03. 删除 `buildGitTreePatch()`

位置：`packages/workspace/src/candidate-builder.ts`。

唯一消费者是 workspace candidate integration test。Candidate v3 生产链使用：

```text
RUN_BASELINE snapshot
+ RUN_RESULT snapshot
→ Candidate operations
```

不再生成或消费 binary Git patch。

实施：

- 删除 `buildGitTreePatch()`；
- 删除不再需要的 `runGitCommand` import；
- 将对应测试收敛为 Candidate operations、hash 和 snapshot binding 验证。

### B04. 删除 `parseCodexJsonl()`

位置：`packages/review/src/agents/codex/cli/events.ts`。

生产 CLI adapter 使用流式：

```text
createCodexEventState()
+ reduceCodexEventLine()
```

`parseCodexJsonl()` 只有单元测试调用。测试应改为逐行调用 reducer，直接覆盖真实生产解析方式，然后删除该 convenience helper。

### B05. 删除 `PiRpcTransport.stderr`

位置：`packages/provider-pi/src/rpc-client.ts`。

`PiRpcClient` 只读取 stdin / stdout；stderr 由 `PiProvider` 独立 drain。删除 interface 字段后，同步更新 RPC client 测试中的 transport object literal。

### B06. Publish fault hook 迁移后再删除

位置：`PublishService.publish()` 的：

- `beforeAdapterApply`；
- `afterAdapterApply`。

生产 `PublishCoordinator` 不传入这两个回调；它们用于测试 apply 前后的 crash window。

删除前必须先把 fault injection 移入测试 store 或 fake adapter。若迁移导致关键 crash window 无法确定性覆盖，则保留 hook，并明确注释其测试用途；不能为了形式上的“零测试专用 API”而降低发布恢复验证能力。

### Batch B 验收

- tests 不再直接依赖已被生产实现取代的旧入口；
- cancellation 和 mutation 测试覆盖真实 production boundary；
- Candidate 测试不再生成 v2 patch；
- Codex test 使用生产 reducer；
- Publish crash-window 覆盖数量不下降。

## 6. Batch C：需要产品决策的条件候选

### C01. `RESUMABLE` / `RESUME_WORKER`

位置：`apps/daemon/src/recovery-manager.ts` 和 `ProductionRuntimeComposition.inspectWorker()`。

现状：

- production `inspectWorker()` 只返回 `STOPPED` 或 `UNKNOWN`；
- `RESUMABLE` 只由 crash tests 注入；
- production 没有重新连接旧 Worker RPC stream 的 producer；
- composition 也没有对应的真实 reattachment action。

推荐决策：如果近期不实现 daemon 重启后的进程重连，删除：

- `RecoveryRuntime.inspectWorker()` 的 `RESUMABLE` union member；
- `RecoveryAction.RESUME_WORKER`；
- `recoverWorker()` 对应分支；
- 只构造该结果的测试。

如果决定保留，则必须记录真实 producer 和恢复动作设计，不能继续只保留一个测试可以制造、生产永远不能产生的成功分支。

### C02. Worker provider 输入中的未消费字段

候选：

- `WorkerStartInput.jobId`：host 写入，PiProvider 不读取；
- `WorkerStartInput.generation`：生产 PiProvider 不读取，仅 fake providers 使用；
- `WorkerContainmentInput.runtimeReadPaths`：生产固定传空数组；
- containment 的 `homeDirectory` / `tempDirectory`：runtime resources 会从 workspace 重新计算，当前只参与错误脱敏 roots。

这些字段属于 provider SPI 设计，不应在普通局部清理中直接删除。实施前必须决定：

1. provider-core 是否只服务内置 Pi provider；
2. future provider 是否需要 Job / generation identity；
3. orchestration 是否允许补充 runtime allowlist；
4. HOME / TMP 的权威计算层应位于 host 还是 provider。

在没有该决策前，本计划默认保留这些字段。

### C03. parse-only daemon 配置

候选：

- `config.workspace.mode`；
- `config.publish.mode`；
- `config.publish.onConflict`。

当前配置 loader 会解析并返回这些字段，但运行时代码没有对应分支消费者。处理方式必须二选一：

- 删除 schema、文档和配置测试中的伪配置；或
- 将配置真正接入 runtime。

不应继续接受一个看似生效、实际被忽略的配置项。

## 7. Batch D：state / artifact schema 版本化清理

### D01. 删除旧 Git patch / evidence 槽位

位置：`packages/state-store/src/schema.ts`。

候选字段：

```text
gitWorkspace.current.incrementalPatch
gitWorkspace.current.cumulativePatch
gitWorkspace.current.evidence
```

候选 artifact semantic：

```text
GIT_PATCH
GIT_EVIDENCE
```

全局引用结果：

- 没有 Worker、Recovery、Publish 或 Git adapter 写入这些字段；
- `runArtifactInventory()` 只被动枚举；
- integration test 只断言字段不存在、inventory 不产生对应 semantic；
- Candidate v3 已直接保存 snapshot binding 与 operations。

实施：

1. 从 state schema 删除三个 optional 字段；
2. 从 `RunArtifactBinding.semantic` 删除两个字面量；
3. 从 `runArtifactInventory()` 删除枚举分支；
4. 更新 fixtures 与负断言；
5. 删除 Batch B 中的 `buildGitTreePatch()`。

### D02. 收敛 `workspaceRefSchema`

当前字段：

```text
relativePath     活跃：Review、Publish、Worker resume 定位物理 workspace
baselineHash     只写不读，与 snapshot 重复
generation       只写不读，attempt generation 才是 stale identity
sandboxId        只写不读，containment identity 在 attempt 上
mutable          恒为 true，无分支消费者
```

推荐目标：

```ts
workspace?: {
  relativePath: string;
}
```

删除只写元数据时，同步更新 Worker 写入、fixtures 和 schema tests。不能删除整个 `workspace`，否则 Review / Publish 无法定位当前 worktree。

### D03. schemaVersion 策略

D01 或 D02 会改变严格的 state v6 文档形状。推荐：

1. 将 project state `schemaVersion` 从 `6` 提升到 `7`；
2. 项目尚未发布时，不增加 v6 兼容解析分支；
3. 明确要求开发环境清理旧 daemon data；
4. 更新 fixtures、schema tests、crash tests 和 installed/e2e lifecycle 数据；
5. 不把业务 Revision 恢复为迁移身份。

如果团队决定继续使用 `schemaVersion: 6`，必须先证明所有现存 v6 数据都会在部署前统一清理，并在变更说明中记录这一破坏性决定。

### D04. 后续格式版本候选

以下内容不与 state v7 清理强制绑定：

- `CaptureGitSnapshotInput.activeWorktreeRoot` 当前只触发一次 `realpath()`，输出仍固定为 `"."`；
- TaskManifest 中 `runId === jobId`；
- `tasksSha256`、`sourceHash` 与 `taskSourceArtifact.sha256` 的重复身份。

如果删除 snapshot 输出字段或 TaskManifest 字段，必须分别提升对应 artifact schemaVersion。不要为了顺手减少字段而扩大本轮 state 清理范围。

### Batch D 验收

- 新 state 不再出现 patch / evidence 字段和 semantic；
- 所有 state fixtures 使用同一新版本；
- old state 的处理策略明确且可执行；
- Candidate、Review、Recovery、Publish artifact integrity 检查仍完整；
- `runArtifactInventory()` 对所有当前活跃 artifact 继续覆盖。

## 8. Batch E：收窄 private workspace 导出面

这批只调整 API surface，不删除活跃实现。

### 8.1 Provider

可考虑停止从 `@smartflow/provider-pi` 根导出：

- `PI_HEARTBEAT_INTERVAL_MS`；
- `PI_HEARTBEAT_STATUS_KEY`；
- `PiEventNormalizer`。

底层常量和 normalizer 实现仍分别被 extension / provider 内部使用，不能删除。

`packages/provider-pi/package.json` 的：

```text
./worker-entry
./mcp-model-extension
```

当前没有 package-name subpath import 消费者；实际运行使用 sibling absolute path。可以删除 private package 的 subpath export，但必须保留：

- 两个源文件；
- root/workspace tsdown entries；
- sibling path discovery；
- extension default export。

### 8.2 Review

`packages/review/src/index.ts` 和 `agents/index.ts` 使用宽 `export *`。可以改为显式导出生产需要的：

- `AgentAdapter` 契约；
- `CodexAdapter`；
- `CodexDesktopAdapter`；
- Review/repair 生产函数和必要类型。

以下类型只作为模块内部函数或 constructor 签名，可停止 named export：

- repair assessment context/result helper types；
- review gate/decision input helper types；
- Codex spawn/kill/options helper types；
- Desktop spawn/kill/options helper types。

测试需要的函数类型优先在测试中使用参数推断，不要求生产 package 为测试暴露所有内部类型。

### 8.3 Publish

可停止 barrel 导出 `TargetStateObservation`；调用者可以从 `observeTargetState()` 推断结果。

模块内部的 `ApplyPathResult`、`PublishBlobReader`、`PublishBindings` 如果没有 package-level consumer，可以去掉不必要的 `export` 修饰符，但保留类型定义。

### 8.4 Apps barrels

根 npm bundle 直接从 CLI main 构建，不把三个 private app package 当作公开 library。可以将 app `src/index.ts` 从 wildcard export 收窄为实际测试和跨 app 需要的 API，但这属于最后一批清理，不应先于生产死代码删除。

## 9. 明确保留：不能误判为死代码

### 9.1 Pi 动态入口和 session 续接

必须保留：

- `packages/provider-pi/src/worker-entry.ts`；
- `mcp-model-extension.ts` 的 default export；
- 根与 workspace 的 worker / extension tsdown entries；
- `.js` / `.mjs` sibling 路径选择；
- `import.meta.resolve()` 的 Pi SDK sandbox allowlist；
- heartbeat status 事件和 deadline renewal；
- completed PI session bundle；
- `--session` 恢复参数；
- final session ID 和 session file 校验。

这些路径缺少普通静态 import 是设计结果，不是死代码证据。

### 9.2 Daemon / MCP 字符串路由

必须保留：

- `connectOrLaunchDaemon()` 的 spawn；
- 六个 MCP tool handler；
- `ProjectRuntime.handle()` 中对应的 IPC method string；
- `smartflow_health` CLI 路径；
- Provider registry environment callback。

### 9.3 Review / Repair

必须保留：

- `CodexAdapter` 和 `CodexDesktopAdapter`；
- `ReviewRunner`、`ReviewCoordinator`、`HostTurnCoordinator`；
- `review-gate.ts` 和 `review-decision.ts`；
- `host-action.ts`；
- `repair-loop.ts` 的所有运行时函数；
- reviewer / worker session 隔离和 durable leader decision 校验。

Gate、decision 和 protocol validator 有重复判断，但都仍有生产消费者。后续可以设计合并，不能局部删除其中一层。

### 9.4 Publish

必须保留：

- service-level preflight；
- filesystem adapter apply 前和 staging 后的 preflight；
- recovery capability check；
- target observation；
- stable operation ID、file-level CAS 和 durable result query。

这些检查覆盖不同竞争窗口，不是简单重复调用。

### 9.5 测试契约与故障注入

默认保留：

- `mcpToolSchemas` 六工具聚合对象；
- atomic write checkpoint hooks；
- `PiProviderOptions.createSandbox`；
- sandbox / Git binary adapter seam；
- deterministic crash-window injection。

它们可能只有测试直接消费，但验证的是崩溃一致性、协议集合和 containment，具有明确价值。只有在等价测试能力迁移后才能删除。

## 10. 实施顺序

### Phase 0：锁定基线

- [x] 暂停与本计划目标文件重叠的并发编辑。
- [x] 记录实施开始时的 commit 和工作树状态。
- [x] 先处理或单独记录当前 lint baseline 的 3 个错误。
- [x] 确认未把 `dist/**` 生成物加入源码删改范围。

### Phase 1：Batch A

- [x] 删除未使用参数、helper、hook、schema、返回字段和 no-op handler。
- [x] 删除两个 Claude `.gitkeep`。
- [x] 运行 typecheck、unused 检查和 build。
- [x] 确认 root bundle 仍生成三个 entry artifact。

### Phase 2：Batch B

- [x] 迁移 cancellation tests 到 `ProjectRuntime` 生产入口。
- [x] 迁移 mutation tests 到 `ProjectMutationExecutor`。
- [x] 删除 patch helper 并收敛 Candidate tests。
- [x] 删除 JSONL convenience parser并改用生产 reducer。
- [x] 迁移或明确保留 Publish fault hooks。
- [x] 运行 unit、integration、crash 和 security tests。

### Phase 3：Batch C 决策

- [x] 决定是否实现真实 Worker reattachment。
- [x] 若不实现，删除 `RESUMABLE` / `RESUME_WORKER`。
- [x] 决定 provider SPI 的身份和 containment 字段边界。
- [x] 删除或接线 parse-only 配置。

### Phase 4：Batch D

- [x] 删除 patch / evidence state 字段和 semantic。
- [x] 收敛 workspace ref。
- [x] 应用 state schemaVersion 决策。
- [x] 更新 fixtures、recovery、installed 和 lifecycle tests。
- [x] 验证旧 daemon data 的明确处理流程。

### Phase 5：Batch E

- [x] 将 private workspace wildcard export 改为显式 export。
- [x] 删除无消费者 subpath export，但保留动态 entry 文件。
- [x] 检查生成 `.d.ts` 和 root bundle exports。

## 11. 验证计划

### 11.1 审计时基线

已执行：

```text
pnpm typecheck                                      通过
pnpm build                                          通过
pnpm exec tsc ... --noUnusedLocals --noUnusedParameters
                                                    发现 1 个未使用参数
pnpm lint                                           未通过，3 个现存测试错误
```

当前 lint 错误：

```text
tests/integration/host-canonical-task-lifecycle.test.ts:30
tests/integration/host-canonical-task-lifecycle.test.ts:34
tests/unit/packages/workspace/control-plane-paths.test.ts:120
```

workspace build 中存在 `@smartflow/*` unresolved import 被当作 external 的警告，但最终 workspace 和 root bundle 均构建成功。该警告不作为死代码证据；可以在单独的 build 配置任务中处理。

### 11.2 每批最小验证

Batch A：

```bash
pnpm lint
pnpm typecheck
pnpm exec tsc -p tsconfig.tests.json --noEmit --noUnusedLocals --noUnusedParameters --pretty false
pnpm build
pnpm test
```

Batch B：在 Batch A 基础上增加：

```bash
pnpm test:integration
pnpm test:crash
pnpm test:security
```

Batch D：运行完整 CI 对应检查：

```bash
pnpm release:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:crash
pnpm test:provider:pi
pnpm test:installed
```

### 11.3 针对性行为验证

清理完成后至少确认：

1. `smartflow doctor` 仍能 probe Pi 和 sandbox；
2. `smartflow mcp` 能连接或拉起 daemon；
3. execute → Worker → Review → Repair → Worker → Publish 主链不变；
4. repair attempt 仍恢复同一 `piSessionId`；
5. daemon 重启后的 STOPPED / UNKNOWN recovery 行为不变；
6. cancel 仍经过 durable `CANCELING` 和 reconciliation；
7. Candidate 只依赖 baseline/result snapshots，不生成 patch/evidence；
8. Publish CAS、recovery 和 manual target observation 不变；
9. npm 安装包继续包含 `smartflow.mjs`、`worker-entry.mjs` 和 `mcp-model-extension.mjs`。

### 11.4 实施验证结果（2026-08-28）

完整矩阵执行结果：

| 检查 | 结果 |
| --- | --- |
| `pnpm release:check` | 通过 |
| `pnpm lint` | 通过；审计基线记录的 3 个测试 lint 错误已做最小修复 |
| `pnpm typecheck` | 通过 |
| `pnpm exec tsc -p tsconfig.tests.json --noEmit --noUnusedLocals --noUnusedParameters --pretty false` | 通过 |
| `pnpm build` | 通过；确认生成 `smartflow.mjs`、`worker-entry.mjs`、`mcp-model-extension.mjs` |
| `pnpm test` | 36 files / 151 tests 通过 |
| `pnpm test:contract` | 3 files / 11 tests 通过 |
| `pnpm test:integration` | 10 files / 60 tests 通过 |
| `pnpm test:e2e` | 4 files / 15 tests 通过，1 个既有 opt-in installed live lifecycle 用例跳过 |
| `pnpm test:security` | 4 files / 8 tests 通过 |
| `pnpm test:crash` | 5 files / 33 tests 通过 |
| `pnpm test:provider:pi` | 7 files / 26 tests 通过 |
| `pnpm test:installed` | 1 test 通过，1 个同一 opt-in live lifecycle 用例跳过 |
| `git diff --check` / `git diff --cached --check` | 通过 |

workspace build 仍会输出审计时已记录的 `@smartflow/*` unresolved-as-external 警告，但所有 bundle 和声明文件均成功生成。实施未改动 index：原有 114 个 staged 路径仍保持 staged，本计划改动保留在 unstaged / untracked 工作树中。

## 12. 完成标准

本计划完成需要同时满足：

- Batch A、B 中确认删除的符号已无定义或引用；
- production mutation 只保留 `ProjectMutationExecutor` 一套实现；
- production cancellation request 只保留 `ProjectRuntime.cancel()` 一套实现；
- state 不再包含无 producer 的 patch / evidence 字段；
- schemaVersion 与旧数据处理策略一致；
- private workspace exports 与实际消费者匹配；
- 动态 Pi、daemon、MCP 和 review adapter 入口全部保留；
- lint、typecheck、build 和适用测试全部通过；
- 没有为了删除测试 seam 而降低 crash、atomicity、containment 或 publish recovery 覆盖；
- 每批变更都能通过独立 diff 解释，不夹带无关架构重构。

## 13. 最终删除优先级

| 优先级 | 内容 | 风险 |
| --- | --- | --- |
| P0 | 未使用参数、无调用 helper、无注入 hook、游离 schema、无效果 handler、空 `.gitkeep` | 低 |
| P1 | Cancel request、MutationSession、Git patch helper、JSONL test helper | 中低，需要测试迁移 |
| P2 | `RESUMABLE`、provider SPI 字段、parse-only 配置 | 中，需要产品决策 |
| P3 | state patch/evidence、workspace 只写元数据 | 中高，需要 schema / 数据策略 |
| P4 | Review / Publish 活跃重复层的架构合并 | 不属于本计划的直接删码范围 |
