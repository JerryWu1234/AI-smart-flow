# Daemon 自己启动 Reviewer — 实现计划（第一版：Codex）

## 目标

Review 从「host 的活」变成 daemon pipeline 的一个阶段。daemon 通过统一的 `AgentAdapter`
启动 reviewer，第一版只实现 Codex。

- **token 归属**：Codex 默认复用 `~/.codex/auth.json`（用户已登录的账号），不是 Pi worker 的 API key
- **reviewer 权限**：`codex exec` 默认 OS 级只读沙箱，第一次做到真强制而不是 prompt 约定
- **host 职责**：只剩轮询。`REVIEW_REQUIRED` 从协议里消失

## 流程

**迁移前**

```
worker 跑完 → REVIEW_PENDING → pipeline 停住
host 领取 REVIEW_REQUIRED → 启动 Reviewer → 回传 review payload
daemon finalizeReview → gate → repair/publish
```

**当前实现**

```
worker 跑完 → REVIEW_PENDING → daemon 自己接着跑 review 阶段
daemon          beginReview → 通过 AgentAdapter 启动 Codex CLI（只读沙箱，cwd = worktree）
                → 校验结构化结果 → finalizeReview → gate → repair/publish
host → daemon   review_turn() → NOT_READY(30s) → … → DONE（result.review 里读结果）
```

Host 协议不再包含 Reviewer session、worktree 或 review submission。Review 从此和 worker
（`RUNNING`）、publish（`READY_TO_PUBLISH`）一样，是 Daemon 自己调度和恢复的阶段。

---

## Step 0 — 前置确认（已完成）

```
$ codex --version
codex-cli 0.146.0

$ codex exec --help | grep -E 'output-schema|output-last-message|--json|--cd|--sandbox'
  -C, --cd <DIR>
  -s, --sandbox <SANDBOX_MODE>   [possible values: read-only, workspace-write, danger-full-access]
      --output-schema <FILE>     Path to a JSON Schema file describing the model's final response shape
      --json                     Print events to stdout as JSONL
  -o, --output-last-message <FILE>

$ codex exec resume --help
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

$ node -e "z.toJSONSchema(...)"
→ 输出干净的 draft-2020-12 schema
```

**`z.toJSONSchema` 的一个已知行为**：`superRefine` 被静默丢弃。所以生成的 JSON Schema 只约束
**形状**（字段、类型、pattern、additionalProperties: false），不约束
「100% ⟺ issues 为空」「id 唯一」「issue 按 path+message 唯一」这些不变量。

那些仍然由 daemon 侧的 `reviewResultSchema.parse()` + `assertTaskCoverage()` 把关。
分工是：**Codex 保证形状对，zod 保证语义对。**

### Step 0b — 真实跑一次（已完成，结论重要）

只验证 `z.toJSONSchema` 能产出 schema 是不够的 —— 必须把它喂给 Codex 发一次真请求。实测结果：

原始契约中 `reviewIssueSchema.suggestedFix` 是 optional，直接生成的 JSON Schema 因此只有
`required: ["path","message"]`，Codex strict structured output 会以 400 拒绝。实测确认的错误是：

```
"code": "invalid_json_schema",
"message": "... required ... Missing 'suggestedFix'."
```

最终修法不是维护第二份手写 Schema，而是修正全局领域契约：`suggestedFix` 改为必填的
`string | null`。这样 `reviewResultSchema.toJSONSchema()` 自然生成
`required: ["path","message","suggestedFix"]` 和 string/null union；Codex、Zod、TypeScript
共享同一结构，同一个 prompt 实测成功：

```
{"type":"thread.started","thread_id":"01a01e64-e216-7e53-b0ef-ec385d056462"}
{"type":"turn.completed","usage":{"input_tokens":15711,"output_tokens":28,...}}
→ 输出文件：{"tasks":[{"id":"T001","completionPercentage":100,"issues":[]}]}
```

所以 Step 2 直接使用全局 `reviewResultSchema.toJSONSchema()`，不做手写复制或输出 normalize。

同一次实测顺带确认的三件事：

| 待测项 | 结论 |
|---|---|
`--skip-git-repo-check` | **有效且必要**。两次都在非 git 的 `/private/tmp` 下跑通 |
`--ignore-user-config` 会不会破坏 auth | **不会**。带着它请求正常发出并完成，token 归属的前提成立 |
`--json` 能不能拿到 sessionId | **能**。第一行就是 `thread.started` 带 `thread_id` |

**另外两个必须写进 adapter 的观察：**

1. **stderr 里有非致命的 `ERROR` 行。** 每次运行都会出现
   `ERROR codex_models_manager::cache: failed to load models cache` 和
   `failed to refresh available models: timeout waiting for child process to exit`，
   但运行是成功的。**adapter 绝对不能把 stderr 里的 "ERROR" 当失败** ——
   只认 stdout 上的 `turn.failed` / `error` 事件和进程退出码，否则每一次都会误判。
2. **不带 `--ignore-user-config` 会继承用户的 config。** 第一次运行打印了
   `reasoning effort: xhigh` 并触发了 `hook: SessionStart` —— 都来自用户的
   `~/.codex/config.toml`。reviewer 要可复现，就必须带 `--ignore-user-config`
   并用 `-m` 显式钉住模型。

*（Codex flag 说明改写自 [Codex 非交互模式文档](https://developers.openai.com/codex/noninteractive)，
以遵守授权限制。）*

---

## Step 1 — `AgentAdapter` 契约 + Codex 实现

**不新建包，放进现有的 `packages/review`。** Agent 接入按产品族和通道分层，
通用契约与 Review 领域逻辑保持独立；未实现的通道只保留目录，不导出虚假 API。

```
packages/review/src/
  agents/
    agent-adapter.ts          # provider-neutral 契约与规范化结果
    index.ts                  # 只导出已实现 adapter
    codex/
      cli/
        adapter.ts            # Codex CLI 实现（唯一 spawn 进程的地方）
        events.ts             # Codex CLI JSONL 事件解析（纯函数）
      desktop/.gitkeep        # 预留 Codex Desktop
    claude/
      code-cli/.gitkeep       # 预留 Claude Code CLI
      desktop/.gitkeep        # 预留 Claude Desktop
  host-action.ts              # 现有领域逻辑
  repair-loop.ts              # 现有领域逻辑
  review-decision.ts          # 现有领域逻辑
  review-gate.ts              # 现有领域逻辑
  review-prompt.ts            # provider-neutral prompt/schema
  index.ts                    # package root 公共入口
```

放这里的三个理由：

- **零新依赖。** 只用 `node:child_process` / `node:fs/promises` / `node:path` 三个内置模块，
  而 `host-action.ts` 已经在用 `node:crypto`，包的性质没变。`@smartflow/protocol` 和
  `@smartflow/task-manifest` 本来就是 `packages/review` 的依赖，`package.json` 一行不用改。
- **零波及面。** `@smartflow/review` 目前只被 `apps/daemon` 引用，mcp-server 根本不依赖它，
  所以引入 spawn 代码不会污染任何其他产物。
- **域内聚。** review 的判定逻辑（gate / decision / repair）继续留在包根；不同 Reviewer
  的进程、事件和传输细节收敛在各自的 `agents/<family>/<channel>` 下。

**一个自觉的取舍**：这个包从「纯函数」变成「也会起进程」。把 spawn 严格限制在
`agents/codex/cli/adapter.ts`，`agents/codex/cli/events.ts` 保持纯解析，其余文件不受影响。

### 契约

```ts
export interface AgentProbe {
  available: boolean;
  agentId: string;               // "codex"
  version?: string;              // "codex-cli 0.146.0"
  reason?: string;               // 不可用原因
}

export interface AgentRunRequest {
  readonly runId: string;              // 日志/取消用，取 reviewAttemptId
  readonly cwd: string;                // worktree 绝对路径
  readonly prompt: string;
  readonly outputSchemaPath: string;   // 已落盘的 JSON Schema
  readonly outputPath: string;         // 最终消息写到哪
  readonly deadlineMs: number;
  readonly model?: string;
}

export type AgentRunOutcome =
  | { kind: "COMPLETED"; sessionId: string; finalResponse: unknown }
  | { kind: "FAILED"; sessionId?: string; code: string; message: string }
  | { kind: "TIMED_OUT"; sessionId?: string }
  | { kind: "CANCELED"; sessionId?: string };

export interface AgentAdapter {
  readonly id: string;
  probe(): Promise<AgentProbe>;
  createSession(request: AgentRunRequest): Promise<AgentRunOutcome>;
  resume(sessionId: string, request: AgentRunRequest): Promise<AgentRunOutcome>;
  cancel(runId: string): Promise<boolean>;
}
```

**`listSessions()` 第一版不做。** daemon 已经把 sessionId 落在 run state 的 `reviewHistory` 里，
枚举能力目前没有消费者。等真需要「孤儿 session 清理」之类再加，加的时候不用改现有签名。

### Codex argv

创建（第一轮）：

```
codex exec
  --json
  --sandbox read-only
  --output-schema  <outputSchemaPath>
  --output-last-message <outputPath>
  --cd <cwd>
  --skip-git-repo-check          # ← 见下方「必须实测」
  --ignore-user-config           # 可复现性；auth 仍走 CODEX_HOME
  [-m <model>]
  <prompt>
```

续（第二轮起）：

```
codex exec resume <sessionId>
  --json --sandbox read-only
  --output-schema <...> --output-last-message <...> --cd <cwd>
  <prompt>
```

**绝对不要加 `--ephemeral`** —— 不落盘就没法 resume（[openai/codex#15538](https://github.com/openai/codex/issues/15538)
就是这个坑）。

**绝对不要套 `ExecutionSandboxAdapter`** —— Codex 自带 OS 沙箱（macOS Seatbelt / Linux Bubblewrap），
嵌套沙箱会出诡异问题（[openai/codex#15696](https://github.com/openai/codex/issues/15696)）。
裸 `child_process.spawn` 即可。

上面这套 flag 组合（`--sandbox read-only` + `--skip-git-repo-check` +
`--ignore-user-config` + `--output-schema` + `-o` + `--json`）已在 Step 0b 实测通过。

**还剩一件必须实测：resume 时能不能同时带配置 flag。** 社区经验说 resume 最好只带最少参数。
如果带 `--sandbox` / `--output-schema` 会出问题，就把它们移进 `-c key=value` 或改用
`-p profile`。

### 事件解析

stdout 是 JSONL：

| 事件 | 用途 |
|---|---|
`{"type":"thread.started","thread_id":"..."}` | 取 `sessionId` |
`{"type":"turn.completed","usage":{...}}` | 成功；usage 可以进日志 |
`{"type":"turn.failed",...}` / `{"type":"error",...}` | 映射成 `FAILED` |
`{"type":"item.completed","item":{"type":"agent_message",...}}` | 兜底取最终文本 |

结果读 `outputPath` 文件 → `JSON.parse` → 作为 `finalResponse` 返回（不在这一层做 zod 校验，
adapter 不认识 review 的语义）。schema 被拒时**不会**产生输出文件，所以「文件不存在」
本身就是一种失败信号。

**stderr 只做日志，不参与成败判定**（见 Step 0b 的观察 1）。

超时：`setTimeout(deadlineMs)` → kill 进程树 → `TIMED_OUT`。
`cancel(runId)` → kill 同一个进程树。

### 验证

测试放 `tests/unit/packages/review/`（`packages/review/package.json` 的 test 脚本已经指向那里）。

- `codex-events.test.ts` —— JSONL 解析，固定 fixture，不起进程
- `codex-adapter.test.ts` —— `probe()` 在本机返回 `available: true` + 版本号
- 手动冒烟（不进 CI）：临时 git repo + 简单 schema 跑一次真实 `createSession`，
  断言拿到 `sessionId` 和合规 JSON，再 `resume` 一次

---

## Step 2 — review prompt + output schema

同样放 `packages/review`，新文件 `packages/review/src/review-prompt.ts`。

理由和 Step 1 一样：纯函数、同一个域、`@smartflow/task-manifest` 已经是依赖。
这样 `packages/review` 承载所有**无状态**的 review 逻辑，`apps/daemon` 只留碰 StateStore 的编排 ——
和现在 `review-gate.ts`（包里）vs `review-coordinator.ts`（daemon 里）的分工一致。

```ts
export function reviewOutputJsonSchema(): unknown {
  return reviewResultSchema.toJSONSchema();
}

export function buildReviewPrompt(input: {
  manifest: TaskManifest;
  changedPaths: readonly string[];
  tasksPath: string;
  correction?: string;        // 上一轮为什么被拒（内部重试用）
}): string;
```

`reviewResultSchema` 是唯一结构来源。全局 `ReviewIssue.suggestedFix` 为必填
`string | null`，因此生成 schema 的每层 `required` 覆盖全部 `properties`；同时保留 Task ID
pattern、0–100 范围、minLength 和 `additionalProperties: false`。`superRefine` 的语义不变量
不会进入 JSON Schema，仍由 Daemon 的 `reviewResultSchema.safeParse()` 与
`assertReviewTaskCoverage()` 校验。

prompt 四段：

1. **审查契约** —— 只读、只按验收标准报问题、issue 只能有
   path/message/suggestedFix、必须恰好覆盖 taskIds、100% 必须无 issue
2. **任务要求** —— `manifest.tasks[].id / description / acceptanceCriteria`
3. **上下文** —— `tasksPath`（要求每轮重读）、`changedPaths`
4. **输出** —— 说明最终回答必须符合 `--output-schema`；`correction` 存在时附在末尾

这一步只从 `@smartflow/protocol` 导入已有 schema，不直接依赖 `zod`，
`packages/review/package.json` 不新增依赖。

### 验证

`tests/unit/packages/review/review-prompt.test.ts` 验证：

- `reviewOutputJsonSchema()` 每层 `required` 覆盖全部 `properties`
- 每层都有 `additionalProperties: false`
- issue schema 要求 `suggestedFix` 且接受 string/null
- 生成结构直接来自 `reviewResultSchema`，没有 normalize 或第二份手写结构

---

## Step 3 — `ReviewRunner`

新文件 `apps/daemon/src/review-runner.ts` —— **daemon 侧唯一的新文件**。这一步只是编排，
Step 1、2 的产物（`AgentAdapter` / `CodexAdapter` / `buildReviewPrompt` / `reviewOutputJsonSchema`）
都从 `@smartflow/review` import，且都已单独可测。

```ts
import {
  ReviewCoordinator          // 注意：这个在 apps/daemon/src/review-coordinator.ts，不在包里
} from "./review-coordinator.js";
import {
  buildReviewPrompt, reviewOutputJsonSchema,
  type AgentAdapter
} from "@smartflow/review";

const DAEMON_REVIEWER_HOST_TURN_ID = "daemon-reviewer";

export class ReviewRunner {
  constructor(
    private store: StateStore,
    private adapter: AgentAdapter,
    private options: { model?: string; deadlineMs: number; maxAttempts: number;
                       logger?: StructuredLogger }
  ) {}

  async run(request: { projectId: string; jobId: string }): Promise<
    { schedule: "pipeline" | "publish" | "none" }
  >;
}
```

流程：

1. `readState`，要求 `phase === "REVIEW_PENDING"`，取 `pendingReviewAction(run)`、`workspace`、manifest
2. **beginReview mutation** —— 照搬 `HostTurnCoordinator.beginReview`（:262-341）的 mutation body：
   `verifyRunArtifacts` + `observeApprovedSource` 漂移检查 + `ReviewCoordinator.beginReview`。
   `hostTurnId` 用 `DAEMON_REVIEWER_HOST_TURN_ID`，`turnToken` 沿用确定性派生，
   `deadlineAt = now + deadlineMs`
3. 把 JSON Schema 写到 `runs/<job>/revision-N/reviews/<attemptId>.schema.json`，
   最终消息输出到 `.../<attemptId>.output.json`
4. `action.reviewerSession.mode === "CREATE" ? adapter.createSession(...) : adapter.resume(id, ...)`
5. `reviewResultSchema.parse(outcome.finalResponse)`
   - 解析失败 → `attempt += 1`，用同一个 `sessionId` resume，prompt 带 `correction`
   - `attempt > maxAttempts` → `ReviewCoordinator.pauseForHostUnavailable`（现有方法，不改）
6. **finalizeReview mutation** —— 照搬 `submitReviewTurn`（:366-453）的 mutation body，
   `reviewerSessionId` 用 `outcome.sessionId`
7. 返回 `finalized.response.schedule`

`ReviewCoordinator` 一行不动：gate、artifact 落盘、`planReviewDecision`、repair 计数、
`schedule` 返回值、`reviewerSession` 的 CREATE/RESUME 绑定全部复用。
**`codex exec resume <id>` 正好满足那个绑定，所以绑定不需要放开。**

### 验证

用 fake adapter（返回预设 `AgentRunOutcome`）跑集成测试，覆盖：
接受 / 返修 / 结果不合规重试后成功 / 重试用尽转 PAUSED。

---

## Step 4 — review 变成 pipeline stage

| 文件 | 改动 |
|---|---|
`apps/daemon/src/project-runtime.ts` | `ProjectRuntimeOptions`（:61-66）加 `review?: (context) => Promise<void>`；`schedule`（:1019-1022）的 kind 联合加 `"review"` 并接上 callback；`ResumeSchedule`（:218）加 `"review"`；`closedResumeRoute` 里 `retry_host_review`（:229-231）的 `schedule: "none"` 改 `"review"`；`resumeSchedule` 里 `retry_host_review` 同改 |
`apps/daemon/src/runtime-composition.ts` | 新增 `review = async (context) => {...}` 方法（与 `runPipeline` / `publish` 并列），构造 `ReviewRunner` 并按返回的 schedule 接着跑；`runPipeline` 末尾 worker 返回 `REVIEW_PENDING` 时接着跑 review（与 `FIXING → prepareRepairAndContinue` 对称） |
`apps/daemon/src/recovery-manager.ts` | `REVIEW_PENDING`（:349）从 `WAIT_FOR_HOST` 改新增的 `RUN_REVIEW`；`REVIEWING` + `AWAITING_REVIEW`（:351-353）也改 `RUN_REVIEW`（重跑即可，`REVIEW_ATTEMPT_REUSED` 会挡重复记账） |
`apps/daemon/src/main.ts` / 组装处 | 注册 Codex adapter，把 `review` callback 接进 `ProjectRuntimeOptions` |
`apps/daemon/src/config.ts` | `review.strategy` 固定为 `"daemon-codex"`；reviewer 的 model / deadlineMs / maxAttempts 放这里 |

### 阻塞项：Step 5 里那两个分支必须和 Step 4 同批做

**Step 4 单独上线的话，host 第一次轮询就炸。** 已核实的两处：

```
host-turn-coordinator.ts:226   advance() 的 REVIEWING 分支 → assertHostOwner(turn, input.hostTurnId)
host-turn-coordinator.ts:219   if (status.phase === "REVIEW_PENDING") return this.beginReview(...)
```

第一处：daemon 写的 `hostTurnId` 是 `"daemon-reviewer"`，真 host 对不上 →
抛 `HOST_TURN_OWNED_BY_ANOTHER_HOST`。而 `turn()`（:157-165）只 catch
`STATE_VERSION_MISMATCH`，其余一律 `throw error` —— **所以这不是 NOT_READY，是异常直接冒到
host**，轮询循环当场挂掉。

第二处更糟：worker 刚结束、daemon 的 ReviewRunner 还没起 Codex 的那个窗口里，
host 的轮询要是落进去，**它会自己 `beginReview` 把 review 回合抢走**，写上自己的
`hostTurnId`。然后 ReviewRunner 再 `beginReview` 撞
`REVIEW_ACTION_NOT_CLAIMABLE`（`review-coordinator.ts:171`）—— review 死掉，
run 卡在 REVIEWING 谁也动不了。这不是理论 race，是 happy path 上的必经窗口。

**所以：`REVIEWING` 和 `REVIEW_PENDING` 两个分支都塌成 `notReady()` 这件事，
必须和 Step 4 同一批落地。** 协议 schema 的删减（`REVIEW_REQUIRED`、input 的 `review`）
可以留到 Step 5，但这两个分支不能等。

### 三个容易漏的隐藏点（必须改，否则会卡死）

**① host 在 REVIEWING 期间无法取消。**
`assertCancelAuthority`（`project-runtime.ts:950`）：`hostTurn` 存在就要求 `hostTurnId` 匹配。
daemon 写的是 `DAEMON_REVIEWER_HOST_TURN_ID`，真 host 对不上 → 取消被拒。

改法：daemon 自有的 review turn 不阻塞 host 取消。

```ts
if (hostTurn.hostTurnId === DAEMON_REVIEWER_HOST_TURN_ID) return;
```

**② `advance()` 会对真 host 抛 owner 错误。**
`host-turn-coordinator.ts:222-241` 的 `REVIEWING` 分支会 `assertHostOwner(turn, input.hostTurnId)`
→ `HOST_TURN_OWNED_BY_ANOTHER_HOST`。

改法：该分支整个塌成 `notReady()`（Step 5 一起做）。

**③ daemon 重启后 review 不会自动继续。**
`project-runtime.ts:455` 附近：

```ts
if (recoveredRun === undefined || recoveredRun.hostTurn !== undefined) continue;
```

有 hostTurn 就跳过调度。daemon 自有的 review turn 在重启后会命中这条，review 永远不恢复。

改法：`hostTurn.hostTurnId === DAEMON_REVIEWER_HOST_TURN_ID` 时不跳过，调度 `"review"`。

**④ 失败路径会把 run 锁死 —— 调试期间会反复踩。**

happy path 没问题：`finalizeReview` 在 ACCEPT 时 `pauseCode === undefined` →
`nextHostTurn = undefined` → `hostTurn` 被清掉。

但**两条失败路径都把 `"daemon-reviewer"` 复制进了 pause 后的 hostTurn**（已核实）：

```
review-coordinator.ts:312   返修满限的 pause      → hostTurnId: turn.hostTurnId
review-coordinator.ts:552   pauseForHostUnavailable → hostTurnId: turn.hostTurnId
```

而 host 想读这个 pause 要过三道 owner 检查（均已核实）：

```
host-turn-coordinator.ts:558   requireUserInput  → assertHostOwner(run.hostTurn, input.hostTurnId)
host-turn-coordinator.ts:562   requireUserInput  → assertHostOwner(previousTurn, ...)
host-turn-coordinator.ts:666   submitAnswer      → assertHostOwner(turn, ...)
```

全都对不上 `"daemon-reviewer"`。结果是：run 既读不到 `USER_INPUT_REQUIRED`，
也 submit 不了 answer，只能手改状态文件。

第二条正是 ReviewRunner「重试用尽」要走的路。而调试期间你会**反复**走这条 ——
Codex 没登录、schema 被拒、输出不合规，每一次都产出一个死锁的 run。

改法：ReviewRunner 在走 pause 的那个 mutation 里把 `hostTurn` 置成 `undefined`。
daemon 自己跑的 review 本来就没有 host 拥有这个回合，不该留一个假 owner 在那儿。

---

## Step 5 — 协议瘦身

> `advance()` 的 `REVIEWING` / `REVIEW_PENDING` 两个分支**已经在 Step 4 改掉了**
> （见 Step 4 的阻塞项）。本步只做剩下的清理。

| 文件 | 改动 |
|---|---|
`packages/protocol/src/schema/mcp-tools.ts` | 从 `reviewTurnOutputSchema`（:320-338）删 `reviewTurnReviewRequiredSchema`（:281-294）；从 `reviewTurnInputSchema`（:229-262）删 `review` 和 `reviewUnavailableReason`（host 完全不参与了，这次可以真删），`superRefine` 的 `submissions` 只留 `answer`；删 `reviewTurnReviewSchema`（:191-197）、`reviewerSessionRequestSchema`（:273-280） |
`apps/daemon/src/host-turn-coordinator.ts` | `turn()`（:157-165）删 review / reviewUnavailable 两个分支；删 `beginReview`、`reviewRequired`、`submitReviewTurn`、`reportReviewUnavailable`；删全部 deadline 定时器（`scheduleDeadline` / `scheduleWakeAt` / `expireReviewTurn` / `pauseActiveReview` / `timers` / `dispose`）—— 超时改由 Codex 进程管 |
`apps/mcp-server/src/server.ts` | `instructions` 删掉讲 reviewer 职责的 5 句，改成一句「Review 由 Daemon 内部完成，你只需轮询到 DONE，审查结果在 result.review 里」；`smartflow_review_turn` 的 description 去掉 `REVIEW_REQUIRED` |

`retryAfterMs` 从 1 秒改 30 秒是本次唯一的「让 host 少烧 turn」的动作。真正的长轮询
（daemon 持住响应）**第一版不做** —— MCP 客户端有请求超时，等确实觉得慢了再加。

---

## Step 6 — 测试

| 文件 | 改动 |
|---|---|
新增 `tests/unit/packages/review/codex-events.test.ts` | JSONL 事件解析 fixture（纯函数，不起进程）|
新增 `tests/unit/packages/review/codex-adapter.test.ts` | `probe()`；超时 kill |
新增 `tests/unit/packages/review/review-prompt.test.ts` | prompt + JSON Schema 快照 |
新增 `tests/integration/daemon-review.test.ts` | fake adapter 驱动：接受 / 返修 / 不合规重试 / 重试用尽 |
`tests/helpers/host-workflow/workflow.ts` | 删 `REVIEW_REQUIRED` 分支和 `callbacks.review`；`Pick<ReviewTurnInput, ... "review" ...>`（:69）编译会报错 |
`tests/helpers/host-workflow/reviewer.ts` | 整个删掉；`index.ts`（:4）去掉 re-export |
`tests/unit/apps/daemon/host-turn-coordinator.test.ts` | :271-278 的 `expectReviewRequired`、:449、:536、:575 全部重写或删除 |
`tests/integration/mcp-lifecycle.test.ts` | :626、:658、:675、:693、:788、:811、:828 六处 review turn 场景改成 daemon 侧驱动 |
`tests/e2e/production-repair-loop.test.ts` | 整个 review 往返改成 fake adapter；:745-790 的重启恢复用例要覆盖上面隐藏点 ③ |
`tests/crash/full-lifecycle.test.ts` | :46 的 `["REVIEW_PENDING", "WAIT_FOR_HOST"]` → `RUN_REVIEW` |
`tests/unit/packages/protocol/schema/protocol.test.ts` | :55-58 的 `REVIEW_REQUIRED` 用例删除；:261-265「review 在 input 里合法」翻转为不合法；:294-302 的 `reviewUnavailableReason` 用例同理 |
`tests/contract/mcp-v6.test.ts` | review turn 桩不变（工具清单不变，仍是 6 个）|
`tests/e2e/installed-package.test.ts` | :336 工具清单**不变**（没有新工具）；:351-358 的 workflowToolNames 断言**保持**（host 仍然只用 2 个工具 —— 这次是加强了，不是放宽）|
`tests/unit/helpers/host-workflow/workflow.test.ts` | :30-33 FakeGateway 的 `review === undefined` 判断删掉；:72-76 的 `reviewRequired()` 删掉 |

**一个反直觉的好消息**：这个方案**不新增任何 MCP 工具**。工具数还是 6 个，
`installed-package.test.ts:351-358` 那条「host 只用 execute + review_turn」的断言
不但不用放宽，反而变得更真了。

---

## 范围控制（第一版明确不做）

- **不新建包** —— adapter 和 prompt 都进 `packages/review`。等真有第三个以上 agent、
  或者别的包也要用 adapter 时再拆
- **`listSessions()`** —— 接口不放，等有消费者再加
- **`providerRuntimeConfigHash` 不动** —— reviewer 的 model / deadline 只进 `config.ts`，
  不进那个 hash。一旦进了会牵动 manifest 编译、approved revision、
  `PROVIDER_RUNTIME_CONFIG_DRIFT` 一整套
- **不复用 worker 的环境变量通道** —— `worker-config.ts:46` 的 `isWorkerConfigurationKey`
  会把未知的 `SMARTFLOW_*` key 判成 `WORKER_CONFIGURATION_INVALID`。reviewer 配置走
  `SMARTFLOW_CONFIG` 那个 YAML，不走 worker 握手
- **长轮询不做** —— 只把 `retryAfterMs` 调到 30 秒
- **第二个 agent 不做** —— 只预留 `agents/codex/desktop`、`agents/claude/code-cli`、
  `agents/claude/desktop`；有真实实现时再接 registry、配置、probe 与测试

## 新增文件总览

```
packages/review/src/agents/agent-adapter.ts          统一契约与规范化结果
packages/review/src/agents/index.ts                  已实现 Agent 的内部 barrel
packages/review/src/agents/codex/cli/adapter.ts      Codex CLI 实现（唯一 spawn 的地方）
packages/review/src/agents/codex/cli/events.ts       Codex CLI JSONL 解析（纯函数）
packages/review/src/agents/codex/desktop/.gitkeep    Codex Desktop 预留位
packages/review/src/agents/claude/code-cli/.gitkeep  Claude Code CLI 预留位
packages/review/src/agents/claude/desktop/.gitkeep   Claude Desktop 预留位
packages/review/src/review-prompt.ts                 prompt + JSON Schema 生成
apps/daemon/src/review-runner.ts                     编排（唯一碰 StateStore 的新文件）
```

只新增实现所需文件和未导出的目录占位，不新增包或运行时依赖。

---

## 破坏性改变

**没有状态迁移。** `hostTurn`、`HostAction`、durable review artifact、`processedRequests`
键派生全不变，`schemaVersion: 6` 不动。

**协议 breaking。** `reviewTurnInputSchema` / `reviewTurnOutputSchema` 都是 `.strict()`：
删掉 `review` 后仍然传的调用方会被直接拒，`REVIEW_REQUIRED` 也已从 output union 删除。
为避免旧 MCP server 与新 Daemon 握手后产生形状错配，IPC 已同步升为 `smartflow.v6`；
YAML `SmartFlowConfig.version: 5` 与持久状态 `schemaVersion: 6` 是独立版本，不随 IPC 改动。

**`HOST_REVIEW_UNAVAILABLE` 语义改变。** 从「host 的 reviewer 不可用」变成
「daemon 的 reviewer 失败」。pause code 和 `retry_host_review` 这个 resume action
名字都不再贴切，但**第一版不改名** —— 改名要动 `resumeActionSchema`、
`closedResumeRoute`、`pauseMessage`、`optionDescription` 和一堆测试。留个 TODO。

**新增外部依赖：`codex` 可执行文件 + 已登录状态。** `probe()` 失败时应该 pause 并给出
明确的 `REVIEWER_UNAVAILABLE`，不要静默卡住。

**可观测性。** `HostTurnCoordinatorDependencies` 里没有 logger，`ReviewRunner` 要自己接
`StructuredLogger`（`runtime-composition.ts` 已经有一个实例）。至少记：
probe 结果、每次 attempt 的 sessionId / usage / 失败原因、finalize 的 schedule。

---

## 执行顺序

1. ~~Step 0 前置确认~~ **已完成**
2. ~~Step 0b 真实跑一次 Codex~~ **已完成** —— 发现 optional 字段不兼容 strict output
3. ~~Step 2 全局 schema + prompt~~ **已完成** —— `suggestedFix` 改为 required nullable，直接生成 JSON Schema
4. ~~Step 1 `AgentAdapter` + Codex CLI~~ **已完成** —— 已迁入多 Agent 目录布局
5. ~~Step 3 `ReviewRunner` + fake adapter 集成测试~~ **已完成**
6. ~~Step 4 + Step 5 原子运行时切换~~ **已完成** —— pipeline stage、恢复、取消与 Host `NOT_READY`
7. ~~Step 5 协议 schema / IPC v6 清理~~ **已完成**
8. ~~Step 6 测试、installed package 和文档收尾~~ **已完成** —— fake Codex 路径已覆盖；真实 Pi installed lifecycle 需显式环境启用
9. ~~全量 `lint` / `typecheck` / `build` / 测试矩阵~~ **已完成**
10. ~~`.changeset/` 加 breaking 说明~~ **已完成** —— `@smartflow/cli: major`

运行时切换必须整批落地；Schema 始终由 protocol 的全局 Zod 契约直接派生，不维护第二份结构。

## 验收标准

- [x] ~~`codex exec` 在非 git 目录下能启动~~ 已验证，`--skip-git-repo-check` 必需
- [x] ~~`--ignore-user-config` 不破坏 auth~~ 已验证
- [x] ~~`--json` 能拿到 `thread_id`~~ 已验证
- [x] `reviewOutputJsonSchema()` 每层 `required` 覆盖全部 `properties`
- [x] `--output-schema` 与 Daemon 校验都直接使用 `reviewResultSchema`；`suggestedFix` 为 required nullable
- [x] 第一轮 CREATE 拿到 `thread_id`，第二轮 `resume` 续上同一个 session，
      `finalizeReview` 的 `REVIEWER_SESSION_BINDING_MISMATCH` 不触发
- [x] adapter 不因 stderr 里的非致命 `ERROR` 行误判失败
- [ ] Codex 在只读沙箱下**改不动** worktree 里的文件（尚未在真实 Codex 会话中实测）
- [x] 结果不合规时用同一 session resume 纠正，达上限转 `PAUSED` 且日志有每次失败原因
- [x] **失败转 `PAUSED` 后 host 能正常读到 `USER_INPUT_REQUIRED` 并提交 answer**（隐藏点 ④）
- [x] host 全程只调 `smartflow_execute` + `smartflow_review_turn`，REVIEWING 期间收到
      `NOT_READY { retryAfterMs: 30000 }`，最终从 `DONE.result.review` 读到结果
- [x] **REVIEW_PENDING 窗口期 host 轮询不会抢走 review 回合**（Step 4 阻塞项）
- [x] REVIEWING 期间 host 调 `smartflow_cancel` 能成功（隐藏点 ①）
- [x] daemon 在 REVIEWING 中重启后，review 能自动继续（隐藏点 ③）
- [x] `codex` 不存在 / 未登录时 pause 并给出明确原因，不静默卡住

---

## 方案演进（留档，避免重复讨论）

**A. MCP sampling** —— daemon 反向请 host 代跑推理。逻辑与 token 归属都对，但要新加
daemon → mcp-server 反向通道，且依赖客户端支持 `sampling/createMessage`（多数不支持）。

**B. 把工单换成现成 prompt** —— host 仍轮询，但只当模型出口。零新基建，但 daemon 得自己
准备全部代码上下文（无工具、无法读文件）。

**C. reviewer 自己调 MCP 提交** —— 否，两个致命问题：
1. MCP 不区分调用方，reviewer 拿到工具箱就能调 `smartflow_cancel`。而 reviewer 恰好是
   全系统唯一读取攻击者可控内容（待审代码）的组件，构成注入路径。
2. 心跳不可行 —— worker 的心跳是 harness 用 `setInterval` 机械发的
   （`mcp-model-extension.ts:162-168`），模型不参与；reviewer 没有这个 harness，
   心跳只能是模型自己决定调的工具，LLM 读三分钟 diff 不会记得每 30 秒点一下。

**D. daemon 读 reviewer 的 transcript 文件** —— 可行，但依赖各 agent 私有的 JSONL 路径与
格式，升级即可能崩。

**本方案** —— daemon 自己 spawn reviewer，于是拿到 stdout、退出码、kill 句柄，
上面所有问题（权限、心跳、格式依赖、结果丢失）同时消失。和现在 Pi worker 的形状一致。
