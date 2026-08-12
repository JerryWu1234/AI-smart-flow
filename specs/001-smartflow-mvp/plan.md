<!-- Authoring artifact only. SmartFlow runtime must not depend on Spec Kit or this file. -->

# SmartFlow MVP Implementation Plan

**Feature Branch**: `001-smartflow-mvp`
**Version**: 4.1.0
**Date**: 2026-08-11
**Scope**: Preserve the sandboxed Pi Worker and safe Git Candidate/Publish path while moving deterministic Review mechanics into the Daemon behind the preferred `smartflow_review_turn` composite API.

## Summary

```text
Host freezes tasks.md + Pi runtime config
→ smartflow_execute
→ Daemon creates Run/Revision and isolated Git workspace
→ Sandbox launches Pi SDK child; bundled Extension registers one model
→ Pi uses official read/bash/edit/write/grep/find/ls tools
→ Daemon snapshots Result and creates Candidate/Review Action
→ Host calls smartflow_review_turn
   ├─ NOT_READY → bounded poll
   ├─ REVIEW_REQUIRED → Host CREATE/RESUME bound Reviewer
   │                    → submit Review with same turnToken
   │                    → Daemon plan:
   │                       ├─ ACCEPT → CAS Publish/DeliveryBundle
   │                       ├─ REPAIR → new Revision/new Pi session
   │                       ├─ PAUSE_INVALID_REVIEW
   │                       └─ PAUSE_REPAIR_LIMIT
   ├─ USER_INPUT_REQUIRED → Host/user typed answer
   └─ DONE → terminal result
```

SmartFlow 不代理文件操作或 Shell。安全性由整个 Pi Worker 进程树的 OS sandbox 保证：Pi 可以在当前 isolated workspace 内修改项目文件、执行 Shell 和访问网络；原始项目、SmartFlow Data Dir 的其他内容、其他 Run workspace 和宿主用户数据不可见。

职责按能力拆分：Host/Leader 持有 MCP、独立 Reviewer CREATE/RESUME 与所有用户交互；Daemon 持有可冻结、可恢复的机械编排，包括 wait、claim/renew、Review submission、确定性 accept/repair/pause、同范围 repair continuation 和 Publish。Daemon 不创建 Reviewer，不解释开放式用户意图，也不扩大 Task 范围。Pi Worker 不接收 SmartFlow MCP；SmartFlow 不新增独立 verify/gate。

MCP server 进程环境仍是唯一模型配置入口。每个实例只绑定一个 API endpoint 和模型；API Key 只通过子进程环境传入。Pi child 加载静态 Extension，通过官方 `pi.registerProvider()` 内存注册模型，不生成或读取 `models.json`。

`smartflow_review_turn` 是 execute 后的首选高层 continuation。它公开四态并在 schema-v4 `RunRecord.hostTurn` 中持久化三阶段 checkpoint；旧 10 个 primitive 工具保留，总工具数恰好 11。设计细节见 [adr-daemon-owned-review-turn.md](adr-daemon-owned-review-turn.md) 与 [contracts/review-turn.md](contracts/review-turn.md)。

## Technical Context

| 项目 | 决策 |
|---|---|
| Language | TypeScript，`strict: true` |
| Runtime | Node.js `>=22.19.0`，满足目标 Pi SDK 当前要求 |
| Package manager | pnpm workspace |
| Worker SDK | `@earendil-works/pi-coding-agent`，固定已验证 published version |
| Worker protocol | SDK RPC JSONL over child stdin/stdout |
| Model registration | Bundled Pi Extension + official `pi.registerProvider()`; in-memory only |
| MCP model config | One API/Base URL/model/API Key per MCP server instance |
| Supported model APIs | `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` |
| Model defaults | context `1000000`、max output `384000`、reasoning enabled、thinking `high` |
| Worker tools | Pi official `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` |
| Sandbox | Existing Darwin `ExecutionSandboxAdapter` extended for streaming child process containment |
| State | Project 外 Data Dir 的原子 schema-v4 `state.json`；Run 含 durable `hostTurn`/`autoRepairRounds` |
| Schema | Zod；运行时类型与协议来自同一 Schema |
| Snapshot | Run-scoped Git object store + Revision-scoped ordinary workspace/index |
| Host protocol | Preferred `smartflow_execute → smartflow_review_turn`; four public states; exactly 11 MCP tools |
| Concurrency | Per-Run composite-turn queue + Project-wide stateVersion CAS + stable child request IDs |
| Transport | MCP Host ↔ local Daemon；Daemon ↔ Pi child JSONL RPC |
| Hash | SHA-256 + Canonical JSON |
| First platform | macOS；无可验证 Sandbox adapter 的平台 fail closed |
| Attempt timeout | MCP server 环境配置，计入 runtime config hash；超时终止 containment 并进入可恢复 PAUSED |

## Constitution Check

| 原则 | 计划结论 | 状态 |
|---|---|---|
| CP-001 Leader-only interaction | Host 独占 Reviewer 执行/用户交互；Daemon 只执行冻结的确定性 mechanics；Pi 不接 SmartFlow MCP | PASS |
| CP-002 Revision execution unit | TaskManifest v3 绑定 `runId + revisionId + tasksSha256` | PASS |
| CP-003 Pi config frozen | MCP server 环境是唯一来源；每个 Revision 绑定不含 API Key 的 `providerRuntimeConfigHash` | PASS |
| CP-004 fixed Pi/no fallback | Worker 固定 Pi；删除 OpenCode/Claude Worker，API/模型不 fallback | PASS |
| CP-005 process containment | Pi child 与全部子进程处于 workspace-scoped OS sandbox；无 Broker | PASS |
| CP-006 hidden running paths | 仅 claimed `REVIEW_REQUIRED` 向 owning Host 暴露 worktree；其他输出只含逻辑 ID/相对路径/Artifact | PASS |
| CP-007 Candidate before Publish | Snapshot/Review/Publish 主线不变 | PASS |
| CP-008 Review gate | 100%/FULL/no blocker 后 Daemon 自动 accept；否则只按 findings/budget repair 或 durable pause | PASS |
| CP-009 single writer/CAS/Host ownership | Per-Run queue、Project CAS、stable child IDs 与 durable `hostTurnId + turnToken` | PASS |
| CP-010 auditable attempt/session | Attempt 记录 Pi session/containment；Run 记录 Host turn、自动 decision 和用户 answer | PASS |
| CP-011 cancellation/timeout/recovery | Sandbox tree 可终止；Host-turn recovery 优先且重读 fresh state；旧 recovery 不并发 | PASS |

**Gate**: PASS。MCP 单模型配置、内存注册和凭据边界不改变 Constitution 的 Leader、Pi、Sandbox、Review 或 Publish 权限；不得用兼容层保留 Broker、OpenCode、Provider 选择或模型配置文件。

## Architecture

```mermaid
flowchart TD
    H["Host / User Leader"] -->|"smartflow_execute"| M["SmartFlow MCP Gateway"]
    H -->|"smartflow_review_turn"| M
    M --> D["Local Daemon"]
    M --> E["MCP process model configuration"]
    D --> Q["Per-Run Host-turn queue"]
    Q --> S["Atomic schema-v4 StateStore / Project CAS"]
    D --> G["Git Workspace Manager"]
    G --> W["Run / Revision isolated workspace"]
    D --> X["ExecutionSandboxAdapter"]
    X --> P["Pi SDK child process"]
    E --> P
    P --> I["Bundled in-memory model Extension"]
    D <-->|"JSONL RPC"| P
    P -->|"official coding tools"| W
    W --> C["Candidate + Review Action"]
    C --> Q
    Q -->|"claimed REVIEW_REQUIRED"| H
    H -->|"CREATE / RESUME"| R["Bound Reviewer session"]
    R -->|"structured Review"| H
    H -->|"same turnToken"| Q
    Q --> A{"Deterministic plan"}
    A -->|"ACCEPT"| U["CAS Publish / DeliveryBundle"]
    A -->|"REPAIR"| G
    A -->|"PAUSE_*"| H
```

### Responsibility boundaries

| 组件 | 保留/新增职责 | 明确不负责 |
|---|---|---|
| Host / User Leader | Task/user approval、稳定 hostTurn identity、Reviewer CREATE/RESUME、向用户展示 typed pause 并提交 answer | 不重建 wait/claim/renew/decision/Publish mechanics；不直接控制 Pi tools |
| MCP Gateway | 校验并转发 11 个工具；复合 turn 为首选；隐藏非 claimed 内部路径 | 不向 Pi 暴露 MCP；不删除兼容 primitives；不自行保存状态 |
| HostTurnCoordinator | Per-Run serialization、bounded wait、durable claim intent、claim/renew、Review submission、decision plan、typed pause、deadline/restart recovery | 不创建 Reviewer、不询问用户、不扩大 Repair scope |
| Daemon runtime | Project CAS、Run/Pi lifecycle、Attempt、取消、repair Revision、Publish progression；Host-turn checkpoint 优先恢复 | 不代理文件/Shell；checkpoint 存在时不并行 legacy recovery |
| StateStore / ProjectMutationExecutor | schema-v4 state、stateVersion CAS、request receipt/idempotency、atomic replace | 不从 events/timers/session 推断事实 |
| Git Workspace Manager | Baseline/Result Snapshot、Workspace 物化、Candidate diff、发布预检 | 不执行 Pi 工具调用 |
| ExecutionSandboxAdapter | 启动/终止受限进程树，提供 streams 与 containment identity | 不实现 Broker 权限策略 |
| Pi Provider | 冻结配置、启动 RPC child、归一化事件、保存 session evidence | 不选择备用 Worker/API/模型；不重写 official tools |
| Pi SDK child | 加载 Extension、内存注册一个模型、运行 Agent loop/official tools | 不读 `models.json`、Host MCP、原始项目或其他 Run state |
| Bound Reviewer | 读取 claimed workspace 中同步 Task/current full result，逐 Task 评分和完整路径覆盖 | 不调用 SmartFlow mechanics、不 Publish、不直接询问用户 |
| Review policy | `ACCEPT | REPAIR | PAUSE_INVALID_REVIEW | PAUSE_REPAIR_LIMIT`，15-round counter | 不发明无 finding repair、不覆盖 Reviewer binding |
| Publish Service | 项目级串行、冲突预检、批量写回、DeliveryBundle | 不自动 merge/commit/push；不绕过 Review gate |

## Pi Worker Design

### Package boundary

新增 `packages/provider-pi/`，删除 `packages/provider-opencode/`、`packages/provider-claude-agent/` 和 `packages/execution-broker/`。

`provider-pi` 分为两侧：

1. Parent adapter：运行于 Daemon，校验冻结配置，通过 `ExecutionSandboxAdapter` 启动 child，处理 JSONL RPC 和 SDK 事件。
2. Child entry：运行于 Sandbox 内，导入 `@earendil-works/pi-coding-agent` 并进入 SDK RPC mode；同时加载随 `provider-pi` 发布的静态模型 Extension，以 MCP 环境配置调用官方 `pi.registerProvider()`。

Child 必须使用 SDK 官方 session/tool/resource loader。SmartFlow 可以设置 cwd、模型配置、任务 prompt、session 目录和资源发现范围，但不能复制、包装或替换官方文件工具实现。

### Direct MCP model registration

MCP server 启动配置是唯一用户输入，必填字段为：

```text
SMARTFLOW_PI_API
SMARTFLOW_PI_BASE_URL
SMARTFLOW_PI_MODEL
SMARTFLOW_PI_API_KEY
```

`SMARTFLOW_PI_API` 只接受 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`。可选字段 `SMARTFLOW_PI_CONTEXT_WINDOW`、`SMARTFLOW_PI_MAX_TOKENS`、`SMARTFLOW_PI_THINKING`、`SMARTFLOW_PI_ATTEMPT_DEADLINE_MS` 分别默认 `1000000`、`384000`、`high`、`1800000`。模型注册固定 `reasoning: true` 和 `input: ["text"]`；`SMARTFLOW_PI_THINKING=off` 可关闭当前 session 的推理。

Daemon 解析并冻结除 API Key 外的配置。Child 只收到最小环境和一个固定内部注册 ID（例如 `smartflow-mcp`）；该 ID 是 Pi Extension API 的实现细节，不是 SmartFlow Provider 字段，不进入 TaskManifest、Run state 或 MCP 配置。Extension 使用环境变量引用解析 API Key，在内存中注册一个模型，然后由官方 RPC 通过固定内部 ID 和冻结 model ID 选择该模型。

以下字段完全删除且不兼容：`SMARTFLOW_WORKER`、`SMARTFLOW_MODEL_API_FORMAT`、`SMARTFLOW_MODEL_API_KEY`、`SMARTFLOW_MODEL_BASE_URL`、`SMARTFLOW_MODEL`、`SMARTFLOW_PI_PROVIDER`、`SMARTFLOW_PI_CREDENTIAL_ENV`。SmartFlow 不提供旧字段 fallback。

不得创建、读取或探测用户/Run 的 `models.json`。API Key 不进入 argv、runtime hash、Manifest、Run state、session、Artifact、日志或错误；Daemon 仅可使用 Key 摘要计算进程配置指纹，以便凭据轮换触发正确重连/重启。

### RPC lifecycle

```text
Daemon creates WorkerAttempt(PREPARING)
→ Sandbox spawns Pi child and returns containment identity
→ child loads bundled Extension and registers one frozen MCP model in memory
→ child emits ready/session metadata
→ Daemon sends frozen task prompt
→ child streams assistant/tool/session events
→ provider maps events to WorkerEvent
→ terminal complete | blocked | failed | timed_out | canceled
→ Daemon persists PiSessionArtifact
→ terminate/reconcile process tree
→ remove/exclude .smartflow-runtime
→ capture Result Snapshot and Candidate
```

JSONL stdout 只承载 RPC。诊断写 stderr，经现有日志脱敏后保存。协议行解析失败、child 非预期退出或 runtime config hash 不匹配均结束当前 Attempt，不得在宿主进程内继续执行 SDK。

### Prompt and resource scope

Worker prompt 只包含：

- 冻结 TaskSourceArtifact/TaskManifest 的任务内容；
- 当前 Revision 与上一轮结构化 RepairItems（如有）；
- cwd 是唯一项目工作区，允许修改其中任意项目文件；
- 不直接询问用户，无法继续时以结构化 blocked/failed 结果结束。

Pi ResourceLoader 必须以 isolated workspace 为项目 cwd，并把 user/global resource discovery 指向 Run-local runtime area 或关闭。项目本地资源若已存在于 workspace，可按 Pi 官方发现规则加载；不得读取宿主用户级 Pi/Codex/Claude Skill 目录，也不通过 MCP 动态注入 Skills。

### Runtime configuration

TaskManifest v3 只保存 `providerRuntimeConfigHash`，不保存 Provider 字段。哈希覆盖会改变 Agent 行为的稳定配置：API、Base URL、模型标识、context、max output、思考参数、Attempt 运行时限和资源加载选项；凭据本身不写入 Manifest、状态、session、Artifact 或日志。

Daemon 只向 child 传递运行所需最小环境：模型凭据、Run-local runtime 路径和基础进程环境。不得传递原始项目路径、SmartFlow Data Dir 根路径、其他 Run 路径或无关敏感环境变量。

## Sandbox and Workspace Boundary

### Required adapter extension

现有一次性命令执行接口需要增加受管 streaming child 能力，概念接口如下：

```ts
interface SandboxedProcessHandle {
  containmentId: string;
  pid: number;
  stdin: WritableStream;
  stdout: ReadableStream;
  stderr: ReadableStream;
  wait(): Promise<SandboxedProcessExit>;
  terminate(): Promise<void>;
}

interface ExecutionSandboxAdapter {
  spawn(request: SandboxedSpawnRequest): Promise<SandboxedProcessHandle>;
}
```

实际 TypeScript 名称可在实现中调整，但必须保留四个契约：可双向流式通信、稳定 containment identity、终止完整进程树、等待并对账退出事实。

### Filesystem policy

- Read/write project data: only current Revision workspace root.
- Read-only bootstrap: Node.js、必要系统库和已安装 Pi SDK 文件的最小路径集合。
- Denied: original project root、SmartFlow project Data Dir（除 Pi-visible runtime 子目录）、其他 Run workspace、用户 HOME 数据和任意额外宿主目录。
- Symlink/absolute path/subprocess escape: denied by OS sandbox, not by prompt or JavaScript path checking.
- Network: allowed.
- Shell command/child process choice: unrestricted inside the containment boundary.

Sandbox profile 由 Daemon 基于已解析的明确路径生成。路径必须先验证为当前 Run/Revision 所有，不能使用未解析 glob 或用户任务内容扩展权限。

### External path non-disclosure

Pi child 内部可以知道自己的 workspace cwd，但该绝对路径是运行细节。Worker event normalization、日志脱敏和 MCP/API/UI serialization 必须把 workspace、SmartFlow 状态、Run runtime 和 session 绝对路径替换为 `jobId`、Artifact ID 或项目相对路径。SDK error、stack trace 和 Shell 输出适用同一规则；Finalize Artifact 可以被列出，但不得包含内部绝对路径。

### Run-local Pi runtime

Pi session、settings/cache 和临时内容放在 `<revision-workspace>/.smartflow-runtime/`。该目录只服务当前 Attempt：

- Worker 运行时允许读写；
- Attempt 结束后，Daemon 将需要保留的 session 元数据写成 Data Dir Artifact；
- Result Snapshot/Candidate 明确排除该目录；
- 进程对账完成后删除该目录；
- 目录损坏或丢失只影响 Pi session 恢复，不改变 `state.json`、Task、Snapshot 或 Candidate 事实。

## Session, Recovery and Cancellation

| 场景 | job / Revision / workspace | Pi session | 处理 |
|---|---|---|---|
| Host/UI 断开后重连，Daemon 与 Worker 存活 | 相同 | 相同 | 查询/等待同一 job，不重启 Worker |
| 同一活跃 Attempt 内 Daemon 继续驱动 | 相同 | 相同 | 继续 JSONL RPC |
| Pi child 崩溃，Revision 可恢复 | 相同 | 新 session + 新 attempt | 复用相同 Revision workspace，旧 attempt 标 failed |
| Daemon/主机崩溃，旧进程已不可证明存活 | 相同 | 新 session + 新 attempt | 先对账/终止旧 containment，再恢复 |
| Daemon 自动批准同范围 repair，或 Host/用户批准 Task 补充 | 新 Revision，以上一 Result Tree 物化 | 新 session | 保留 Reviewer binding |
| 用户提出独立新功能 | 新 Task/Run/workspace | 新 session | Host/Leader 根据用户意图创建新执行单元 |
| 用户取消 | 相同 | 终止 | kill containment tree，durable 写 canceled |
| Attempt 达到冻结 deadline | 相同 | 终止并失效 | kill containment tree，durable 写 `TIMED_OUT`，Run 进入可恢复 `PAUSED` |

“同一 Task 还是新功能”只由 Leader 根据用户意图分类。Pi session 不承担跨 Revision 业务记忆；Task Artifact、RepairItems、Snapshot 和 Review history 才是恢复输入。

## State and Protocol Migration

### TaskManifest v3

```ts
interface TaskManifestV3 {
  schemaVersion: 3;
  runId: string;
  revisionId: string;
  providerRuntimeConfigHash: string;
  taskSourceArtifact: ArtifactRef;
  tasksSha256: string;
}
```

删除 `permissionPolicy`、`permissionPolicyHash`、OpenCode/Claude provider union 和 Broker tool definitions。

### Run state and Host-turn checkpoint

Project state remains schema version 4. Run retains `workerAttempts[]` and adds durable Review-turn fields:

```ts
interface PiWorkerAttemptState {
  attemptId: string;
  revision: number;
  generation: number;
  status: "PREPARING" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "CANCELED";
  piSessionId?: string;
  containmentId?: string;
  processIdentity?: ProcessIdentity;
  sessionArtifact?: ArtifactRef;
  startedAt: string;
  endedAt?: string;
}

type HostTurn =
  | { stage: "CLAIMING"; turnToken: string; hostTurnId: string; revision: number;
      actionId: string; startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_REVIEW"; turnToken: string; hostTurnId: string; revision: number;
      actionId: string; claimId: string; reviewAttemptId: string;
      startedAt: string; deadlineAt: string }
  | { stage: "AWAITING_USER_INPUT"; turnToken: string; hostTurnId: string;
      revision: number; pauseCode: string; startedAt: string };

interface RunReviewAutomationState {
  hostTurn?: HostTurn;
  autoRepairRounds?: number;
}
```

`CLAIMING` is persisted before claim, `AWAITING_REVIEW` before path disclosure, and `AWAITING_USER_INPUT` before asking the user. `autoRepairRounds` counts automatic repair in the current group; `resume_review_decision` resets it. Removed fields remain `brokerSession`, `effectExecutions`, `managedProcesses`, `workerBlock`, and their answers/receipts.

### MCP surface

Register exactly eleven public tools: `smartflow_execute`, `smartflow_status`, `smartflow_wait`, `smartflow_review_turn`, `smartflow_claim_action`, `smartflow_renew_action_claim`, `smartflow_submit_review`, `smartflow_submit_leader_decision`, `smartflow_resume`, `smartflow_cancel`, and `smartflow_result`.

The Host Skill uses only execute plus the composite turn at the high level. The ten primitives remain compatible for diagnostics/low-level clients but are not the preferred orchestration API. `smartflow_submit_tool_decision`, Worker block answers, and Host Worker-tool approval branches remain deleted. All non-`REVIEW_REQUIRED` composite outputs reject `worktreePath`.

`resume` only performs a Run action already present in durable `resumeActions`; it does not accept arbitrary Pi tool answers. `USER_INPUT_REQUIRED` exposes legal options and, when required, a typed approval template. `DONE` wraps result only for terminal phases.

### State compatibility

4.0 是不兼容状态升级。启动时如发现含 Broker/OpenCode 字段的旧 Active Run，Daemon 必须以明确 unsupported migration 状态停止，不尝试把旧 effect/session 转成 Pi session。已终态 Audit Artifact 可保留为只读历史，但不参与 4.0 恢复。

## Git Workspace, Candidate and Publish

现有 Git-backed 设计保持：

- Run Baseline 在整个 Run 内固定；Revision 1 使用 Baseline，后续 Revision 使用上一 Result Tree。
- 形式 Candidate 是 Baseline 到最新 Result Tree 的累计变化；相邻 Tree diff 只作为本轮 repair evidence。
- 每个 Run 使用独立 append-only Git object store，每个 Revision 使用独立 index/workspace/snapshot。
- Pi 不接触用户仓库 index、refs 或 Worktree；SmartFlow 不使用 `git worktree add`。
- Git capability probe 不检测或阻断 Git LFS、`.gitattributes` 与自定义 `clean`/`smudge`/`process` filter；workspace 内容按普通文件流程读写。
- Publish 只检查累计 Candidate paths，要求 expected-old-hash、稳定 operationId、结果查询和支持的 batch mode。
- 冲突返回 `0/N` 与 DeliveryBundle；PARTIAL/UNKNOWN 进入 `PUBLISH_RECOVERY_BLOCKED`。

Pi runtime directory 必须在 Result Snapshot 之前清理/排除，因此不会出现在 Candidate changed paths 或 Publish。

## Data Directory and Durability

```text
<user-data>/smartflow/projects/<projectId>/
├── lock
├── state.json
├── events.jsonl
└── runs/<jobId>/
    ├── task-source.md
    ├── task-manifest.json
    ├── baseline.json
    ├── git/objects/
    ├── attempts/<attemptId>/
    │   ├── session-artifact.json
    │   └── logs/
    ├── revisions/<revision>/
    │   ├── index
    │   ├── input-snapshot.json
    │   ├── result-snapshot.json
    │   ├── workspace/
    │   │   └── .smartflow-runtime/  # active attempt only; excluded/cleaned
    │   ├── candidate/
    │   └── review/
    └── delivery/
```

`state.json` 继续是唯一恢复事实。Artifact durable-first，随后通过 Project lock、revision/CAS 和原子 replace 提交状态。`events.jsonl` 只用于审计。

## State Machine Impact

Run phases remain durable business state; the composite API maps them to four public states and hides internal mechanics:

```mermaid
stateDiagram-v2
    [*] --> NOT_READY: Worker / snapshot / publish progress
    NOT_READY --> CLAIMING: REVIEW_PENDING
    CLAIMING --> AWAITING_REVIEW: Action claimed/reconciled
    AWAITING_REVIEW --> AWAITING_REVIEW: claim renewal
    AWAITING_REVIEW --> NOT_READY: Review submitted + REPAIR
    AWAITING_REVIEW --> NOT_READY: Review submitted + ACCEPT / Publish
    AWAITING_REVIEW --> AWAITING_USER_INPUT: invalid / limit / unavailable
    NOT_READY --> AWAITING_USER_INPUT: nonterminal durable pause
    AWAITING_USER_INPUT --> NOT_READY: allowed answer/resume
    NOT_READY --> DONE: COMPLETED / CANCELED / FAILED
```

Public mapping:

| Durable condition | Composite output |
|---|---|
| Active phase without immediate Host action | `NOT_READY` + bounded `retryAfterMs` |
| Current Action durably claimed for owning Host | `REVIEW_REQUIRED` |
| Nonterminal pause requiring choice/approval | `USER_INPUT_REQUIRED` |
| `COMPLETED | CANCELED | FAILED` | `DONE` + canonical result |

Decision transition:

```text
valid Review
├─ APPROVE + 100% + no blockers → ACCEPT → READY_TO_PUBLISH
├─ blockers + autoRepairRounds < 15 → REPAIR → FIXING → approved Revision → PREPARING
├─ incomplete without blockers → PAUSE_INVALID_REVIEW
└─ blockers + autoRepairRounds >= 15 → PAUSE_REPAIR_LIMIT
```

`CLAIMING`, `AWAITING_REVIEW`, and `AWAITING_USER_INPUT` are schema-v4 Host-turn checkpoints, not new Run phases or public states. There is no Worker tool-decision phase. Pi blocked/failure remains a durable pause handled through legal user input or recovery.

## Source Layout Changes

```text
packages/
├── provider-pi/                 # SDK parent adapter + sandbox child + bundled model Extension
├── provider-core/               # keep minimal WorkerProvider/event contract
├── workspace/                   # extend sandbox streaming process API
├── protocol/                    # provider/session/state/MCP schema v4
├── state-store/                 # PiWorkerAttempt persistence/recovery
├── task-manifest/               # TaskManifest v3, provider="pi"
├── review/                      # retained
├── publish/                     # retained
├── provider-opencode/           # delete
├── provider-claude-agent/       # delete
└── execution-broker/            # delete

apps/
├── daemon/                      # Pi composition, lifecycle, recovery/cancel
├── mcp-server/                  # remove tool-decision surface
├── host-skill/                  # remove Worker block/tool approval branch
└── cli/                         # Pi doctor/installed gate
```

同时更新 workspace manifests、root dependencies/scripts、bundle entry points 和安装产物，确保发布包不再包含 OpenCode binary/dependency、Broker 或 Claude placeholder。

## Implementation Phases

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P0 — Contract freeze | 更新 TaskManifest、Run state、MCP 和 Pi Worker contracts | schema v3/v4 可表达 Attempt/session/containment/timeout/path redaction；无 Broker 字段 |
| P1 — Sandbox streaming | 为 ExecutionSandboxAdapter 增加双向流、deadline、完整进程树取消和 path-containment tests | workspace 内命令/网络可用；受保护用户路径不可读写；超时后零存活进程 |
| P2 — Pi Provider | 新增 provider-pi parent/child、MCP 单模型内存注册 Extension、配置 hash、RPC 和事件归一化 | 四种标准 API 均可注册一个模型且不读写 `models.json`；真实 Pi session 可在 isolated workspace 完成 add/modify/delete/shell |
| P3 — Daemon integration | 接入 registry/runner/recovery/cancel/state，删除 Worker tool-decision 流 | 重连/崩溃/新 Revision 的 session matrix 全部通过 |
| P4 — Legacy deletion | 删除 execution-broker、provider-opencode、provider-claude-agent 及依赖/状态/协议残留 | 全仓 `rg` 对遗留运行代码命中为 0 |
| P5 — Review/Publish regression | 更新 contract/integration/security/crash/e2e tests | Candidate、Reviewer binding、冲突发布和取消恢复保持通过 |
| P6 — Solution D composite turn | 新增 schema-v4 Host turn、review-turn tool/coordinator、Host migration、deterministic policy 与 two-tool E2E | 四态/路径保护/11 工具、restart/CAS/renew/deadline、15 轮和 terminal-only DONE 全部通过；真实 Pi evidence 独立跟踪 |

P0→P1→P2 是 Worker 迁移阻塞链；P3 依赖 P0–P2；P4 在 Pi 主线接通后立即执行；P5 收敛 Worker/Publish 回归。P6 在现有 Candidate/Review primitives 上建立首选复合控制面，并以 schema-v4 checkpoint 接管 Review-turn 恢复。不得保留双 Provider feature flag、Broker compatibility adapter，或 Host/Daemon 两套并行机械编排。

## Test Strategy

### Contract

- Worker 只接受 Pi；TaskManifest v3 只绑定 runtime config hash，不含 Provider 字段。
- MCP 模型配置只接受四种 API、单模型和直接 API Key；默认值与合法覆盖均可冻结。
- MCP surface 不含 `smartflow_submit_tool_decision` 或 workerBlock answer。
- Run state 拒绝 Broker/effect/managedProcess 旧字段，接受 PiWorkerAttempt/session Artifact。
- MCP/API/UI/log serialization 不暴露 workspace、状态或 session 绝对路径。
- `smartflow_review_turn` 只接受互斥 Review/answer/failure continuations并要求 token；输出只属于四态。
- MCP schemas/handlers 恰好注册 11 个工具，保留全部十个 primitives。

### Composite Review turn

- Poll/stale/pause/terminal responses reject `worktreePath`; claim-complete `REVIEW_REQUIRED` includes current path and provenance.
- First Action requests Reviewer `CREATE`; repair requests bound `RESUME`; Reviewer ID cannot equal Pi session ID.
- Concurrent turns serialize per Run; an injected CAS mismatch permits at most four total attempts (the initial attempt plus up to three retries), rereading fresh state with stable child request IDs and no duplicate effects.
- Restart at `CLAIMING`, `AWAITING_REVIEW`, and `AWAITING_USER_INPUT` recovers one checkpoint; fresh-state reread prevents legacy recovery races.
- 30-minute deadline, 60-second renewal, 30-second safety margin, 1-second retry, and three-failure pause are tested with controlled time.
- `ACCEPT`, `REPAIR`, invalid Review, 15-round pause, counter reset, typed answer, and terminal-only `DONE` each have direct tests.

### Integration

- Pi SDK child 的 JSONL ready/prompt/event/terminal 流。
- Bundled Extension 从 MCP 环境直接注册模型；四种 API 各完成一次无网络模型解析，且运行前后不存在 `models.json`。
- add/modify/delete/search/shell 的 Candidate 结果。
- Host 重连同 session；child crash 新 attempt/session；new Revision 新 session。
- Pi config hash 漂移 fail closed。

### Security

- workspace 内任意项目路径读写成功，包括 `tasks.md` 和 `.specify`。
- 原始项目、SmartFlow 状态、其他 Run workspace、用户敏感目录访问失败。
- absolute path、symlink 和 subprocess escape 失败。
- Shell 与网络不被 Broker 或逐命令策略拦截。
- 已知绝对路径 canary 不出现在 Worker events、MCP payload、UI data、日志或 Finalize Artifact。
- API Key canary 不出现在 argv、runtime hash、Manifest、Run state、session、Artifact、日志或错误；宿主和 workspace `models.json` 均不被读取/生成。

### Crash and cancellation

- kill child、kill daemon、host reconnect、deadline timeout、cancel 进程树对账。
- session runtime 丢失后仍可从 `state.json`、Revision 和 workspace 创建新 attempt。
- 不重复 Candidate、Review Action 或 Publish。

### End-to-end

- Production composition: Host-level calls are exactly `smartflow_execute → smartflow_review_turn*`; Daemon performs claim/renew/decision/resume primitives internally.
- Automatic repair: new Revision/new Pi session, same Reviewer binding, cumulative Candidate, deterministic eventual Publish.
- Daemon restart during active Review turn restores token/claim/renewal and never starts competing legacy recovery.
- User-input states cover invalid Review, repair limit, unavailable Reviewer, and publish/recovery pauses; only terminal state returns `DONE`.
- Installed package: Task → real Pi → Candidate → Review → automatic accept → Publish.
- Publish conflict: overlapping Runs second result is zero-write `0/N`.

The covered production-composition scenario and focused regressions close T204/T205: composite ownership is enforced across compatibility mutations, lost claim responses recover from the durable lease, Reviewer callbacks receive cumulative `changedPaths`, and pauses are self-contained. They do not prove the installed Pi host contract. Real Pi 0.83.0 Extension/RPC evidence (T190/T208) and an authorized, checked-in real-model two-tool transcript (T192/T209) are separate open gates.

删除代码时同步删除其专属测试：Broker effect/policy/receipt、OpenCode capability/live-provider、Claude placeholder、Worker tool-decision tests。只为新的行为契约写测试；不为 prompt、Docker 或常量数据单独写单元测试。

## Acceptance Gate

实现完成必须同时满足：

1. `@earendil-works/pi-coding-agent` 是唯一 Worker SDK，依赖版本与 Node 要求已固定。
2. Pi 使用官方 coding tools；SmartFlow 文件/Shell Broker、effects 和 tool-decision 代码为零。
3. Pi 及全部子进程只能访问当前 isolated workspace 的项目数据；原始项目和 SmartFlow 状态不可访问。
4. 任意 workspace-local Shell 与网络可用，且无逐命令授权流程。
5. Candidate、Review、自动 decision 和 Publish 行为通过回归契约；Host 不重建机械 primitive loop。
6. Session matrix、取消和崩溃恢复测试通过。
7. Timeout 后完整进程树退出、Attempt 为 `TIMED_OUT`，且允许恢复前无新 Candidate/Attempt。
8. MCP/API/UI/log/Finalize Artifact 的内部绝对路径泄露数为 0；worktree 仅在 claimed `REVIEW_REQUIRED` 暴露。
9. 发布包、CLI doctor、scripts、workspace manifests 和测试名称不再包含 OpenCode/Claude/Broker 主线。
10. MCP 配置是唯一模型配置源；四种标准 API 可各自内存注册恰好一个模型，默认 1M/384K/high 生效，且 `models.json` 读写数和 API Key 泄露数均为 0。
11. Composite output 恰好四态，`DONE` terminal-only，stale continuation 无副作用且无 worktree path。
12. Public MCP surface 恰好 11 tools；Host Skill 高层调用只包含 execute/review-turn，十个 primitive 保持兼容。
13. Host-turn checkpoint 的三阶段、ownership、per-Run queue、Project CAS、stable child IDs、deadline/renew/retry 和 restart sole-authority tests 全部通过。
14. 自动 decision 覆盖 100% accept、finding repair、invalid Review、15-round limit 和 `resume_review_decision` counter reset。
15. 已实现的 production-composition gates 不得被用来关闭真实 installed Pi 0.83.0 compatibility 或授权 real-model evidence；T190/T208 与 T192/T209 在证据入库前保持开放。

## Upstream References

- Pi Coding Agent SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi Coding Agent RPC: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Pi Coding Agent Extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#piregisterprovidername-config
- Pi Agent Core: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- Pi Coding Agent package metadata: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json
