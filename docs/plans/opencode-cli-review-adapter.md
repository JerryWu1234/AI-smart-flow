# OpenCode CLI Review Adapter 实现计划

> **状态：已完成。** Phase 0 已在 OpenCode 1.17.7 上通过；adapter、strategy wiring、隔离测试、全量测试与发布检查均已完成。
>
> **分支：** `feat/opencode-review-adapter`，基于 `main` / `origin/main` 的 `3d3b9933e84ff5a630051bdabad5adea691abf84`。

## 1. 目标

新增 durable Review strategy `opencode`。Daemon 每次 CREATE/RESUME 启动一个独立的 `opencode run` 进程，使用独立 Reviewer session，同时复用 Daemon 环境中的 OpenCode 安装、provider authentication 和本地 session store。

不引入 OpenCode SDK/server/ACP，不修改 `AgentAdapter`、ReviewRunner、ReviewCoordinator、ProjectRuntime、RecoveryManager 或 Worker Provider。

配置示例：

```yaml
review:
  strategy: opencode
  model: provider/model
  effort: high
```

`review.model` 对 OpenCode 是必填项并原样映射为 `--model`；可选 `review.effort` 原样映射为 provider-specific `--variant`。

## 2. 已验证的 Phase 0 契约

验证使用本地 OpenAI-compatible mock endpoint，没有调用真实 provider、消耗付费额度或发送项目源码。

### CLI 与 session

- 可用命令：`opencode --pure run --format json`。
- 已验证 `--session`、`--dir`、`--agent`、`--title`、`--model`、`--variant`。
- CREATE 事件返回顶层 `sessionID`。
- 第二个独立 CLI 进程使用精确 `--session` 后返回同一 ID。
- 两个并发 CREATE 返回不同 session ID，未出现数据库锁。
- 不使用 `--continue`、`--fork`、`--share` 或 `--attach`。

### NDJSON

已观察并固化的事件：

```text
step_start
text
step_finish
error
tool_use
```

所有已知事件必须携带同一非空 `sessionID`。Reducer 在每个 `step_start` 重置当前 step 文本，只把 `step_finish.part.reason === "stop"` 对应的文本作为最终响应；`tool-calls` 只结束中间 tool step。最终文本直接 `JSON.parse`，不剥 Markdown fence、不提取子串、不做 JSON repair。

### 配置与目录隔离

直接在 candidate 目录运行不安全：OpenCode 会合并 candidate 的 `opencode.json`、`.opencode`、permissions 和 MCP；顶层 `"*": "deny"` 不会自动覆盖已存在的显式 `edit`/`bash` allow。

已验证的安全拓扑：

1. 进程 cwd 与 `--dir` 都指向稳定的 private Reviewer root；
2. Reviewer root 自身是最小 Git root，阻止向父目录发现 config 和 `AGENTS.md`；
3. `XDG_CONFIG_HOME` 指向 Reviewer 私有空目录；
4. 删除继承的 `OPENCODE_CONFIG` 与 `OPENCODE_CONFIG_DIR`；
5. 使用 `OPENCODE_CONFIG_CONTENT` 同时在 global 与专用 agent 层设置 deny-by-default；
6. candidate 只通过精确 `external_directory` allow 暴露；
7. prompt 追加 candidate 的绝对路径。

真实 tool-call 验证结果：

- provider 请求只暴露 `read`、`glob`、`grep`；
- exact candidate 文件读取成功；
- candidate 外部读取在执行前返回 permission error；
- `edit`、`write`、`patch`、`bash`、`task`、web、skill、interactive tools 不可用；
- 恶意 candidate MCP sentinel 未启动；
- provider system context 的 workspace root 是 Reviewer root，没有加载父仓库 `AGENTS.md`。

OpenCode managed configuration 的优先级高于 inline config，CLI 没有稳定的“一次禁用全部 managed config”开关。MVP 将系统级 managed config 视为受信任管理员策略；不宣称能抵抗恶意管理员配置。只读约束属于 OpenCode 应用层 permission，不是 OS sandbox。

### 本地数据兼容说明

Reviewer 保留继承的 OpenCode data/auth store，以复用登录和跨进程 session。本机默认 data DB 与被测 1.17.7 binary 曾出现既有 SQLite schema 不匹配（缺少 `replacement_seq`）；隔离 spike data root 正常。Adapter 不迁移或修改该数据库结构，这类安装/data-version 问题按普通 Review process failure 返回。

## 3. 实现设计

### 文件

```text
packages/review/src/agents/opencode/cli/events.ts
packages/review/src/agents/opencode/cli/adapter.ts
```

### Reviewer root

从 `request.outputPath` 稳定推导：

```text
<reviews directory>/.opencode-reviewer
```

它跨同一 Job 的 correction 和后续 review attempt 保持稳定，但位于 candidate workspace 外。Adapter 创建最小 `.git/HEAD`、`.git/config`、objects 与 refs 目录，不依赖额外 `git init` 进程。

如果 candidate 与 Reviewer root 路径重叠，adapter fail closed。

### argv

```text
opencode --pure run
  --format json
  --dir <reviewerRoot>
  --agent smartflow-reviewer
  --title "SmartFlow review <runId>"
  [--session <expectedSessionId>]
  --model <provider/model>
  [--variant <effort>]
  <promptWithWorkspaceAndSchema>
```

CREATE 不传 session；RESUME 只传上层给出的精确 ID。事件报告不同 ID 时返回 `OPENCODE_SESSION_MISMATCH`，不接受新的绑定。

### 安全配置

Global 和 `smartflow-reviewer` agent 复用相同对象：

- tools：默认 false，只开启 `read`、`glob`、`grep`；
- permissions：默认 deny，只允许上述只读工具；
- `external_directory`：默认 deny，只允许 candidate 根与其后代；
- 显式拒绝 edit/write/patch/bash/task/web/skill/LSP/todo/question/plan；
- `share: disabled`、`autoupdate: false`、`plugin: []`、`mcp: {}`。

隔离 XDG config 会移除用户 `opencode.json` 中的 custom provider definitions。MVP 只支持 OpenCode 自带 provider 加共享 auth store；不复制或清洗用户 provider config。

### 生命周期

采用 Claude Code adapter 的 ownership 语义：

- schema I/O 前 reserve `runId`；
- child 使用 detached process group；
- cancel/deadline 发 SIGTERM，grace period 后发 SIGKILL；
- child `error` 只记录，统一等待 `close` settle；
- `cancel()`、run promise 和 runId reservation 都等到 close 后完成；
- POSIX 对负 PID 发信号；Windows 只保证直接 child kill。

### 输出

1. 读取并 compact JSON Schema；
2. 删除 stale output；
3. schema 与 candidate 绝对路径追加到原 prompt；
4. 增量消费 NDJSON；
5. 校验 session 与 terminal event；
6. 严格解析最终 JSON；
7. 写入 `request.outputPath`；
8. 返回相同对象给现有 ReviewRunner；
9. 继续使用现有 Zod 与 task coverage gate。

## 4. Strategy wiring

修改：

- `packages/review/src/agents/index.ts` 与 `src/index.ts`：导出 `OpenCodeAdapter`；
- `apps/daemon/src/config/config.ts`：注册 `opencode`；
- `apps/daemon/src/main.ts`：lazy factory；
- `packages/state-store/src/schema.ts`：durable `reviewAdapterId` enum；
- `README.md` 与 changeset。

选择规则保持不变：显式 YAML 优先；未配置时只有精确 `clientInfo.name === "opencode"` 自动选择；大小写变体、alias 和未知 Host 回退 `codex`。Job 创建后 strategy ID 持久化，retry、repair 和 daemon recovery 不重新选择。

## 5. 测试计划

### Unit

- event CREATE/RESUME、session mismatch/missing、step text 聚合、error、known malformed、unknown line；
- argv、model/variant、CREATE/RESUME、prompt schema；
- safe cwd/env/config 与危险 flags/tools 缺失；
- strict JSON、stale output、nonzero/error/missing terminal；
- duplicate run ID；
- cancel/deadline TERM→KILL 且等待 close。

### Config/state/integration

- YAML `opencode`；
- exact Host 自动选择与 fallback；
- state schema 接受 `opencode`；
- ProjectRuntime 将 exact Host 固化为 durable `reviewAdapterId: "opencode"`。

### Contract/security

使用仓库内 mock executable，不依赖真实 OpenCode 或网络：

- contract fixture 产生已验证 NDJSON，并验证 CREATE/RESUME argv；
- security fixture 验证 Reviewer root/XDG/config、candidate unchanged、危险工具禁用与递归 MCP sentinel 不执行。

真实 CLI 1.17.7 spike 作为手动证据，不在 CI 使用用户 credentials。

## 6. 明确不支持

- CLI-native JSON Schema enforcement；
- executable 配置与 daemon startup version preflight；
- 自动安装、升级、登录或 provider auth 管理；
- custom provider definitions；
- Host process/conversation/session attach；
- SDK/server/ACP/TUI/Desktop；
- in-flight crash session checkpoint；
- daemon crash orphan reviewer reconciliation；
- 跨用户/HOME/XDG/机器迁移；
- Windows 完整 descendant cleanup；
- 对抗恶意 system managed config；
- OS-level filesystem sandbox。

## 7. 验收与验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:integration
pnpm test:security
pnpm test:crash
pnpm build
pnpm release:check
git diff --check
```

验收要求：strategy 可选择并 durable；CREATE/RESUME session 稳定；结果严格 JSON；candidate 不被写入；危险工具/MCP 不加载；cancel 等待 close；既有四个 strategy 无回归；无新 dependency 或 lockfile 变更。

## 8. 官方依据

- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)
- [OpenCode configuration precedence](https://opencode.ai/docs/config/)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode providers](https://opencode.ai/docs/providers/)

外部资料均已释义，未逐字复制；Phase 0 行为以本机 OpenCode 1.17.7 实测为准。Content was rephrased for compliance with licensing restrictions.
