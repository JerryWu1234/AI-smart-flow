import { DATA_DETAILS } from "./data-structures.js";

const source = (path, symbol) => `${path}#${symbol}`;
const stage = (definition) => Object.freeze({
  terminal: false,
  ...definition,
  actorIds: Object.freeze(definition.actorIds),
  outputs: Object.freeze(definition.outputs),
  sources: Object.freeze(definition.sources)
});
const transition = (definition) => Object.freeze({
  durationMs: 3_600,
  bend: 0,
  route: "curve",
  ...definition,
  actorIds: Object.freeze(definition.actorIds),
  dataDetailIds: Object.freeze(definition.dataDetailIds),
  changes: Object.freeze(definition.changes),
  sources: Object.freeze(definition.sources)
});
const scenario = (definition) => Object.freeze({
  ...definition,
  transitionPath: Object.freeze(definition.transitionPath)
});

export const FLOW_META = Object.freeze({
  id: "smartflow.production-lifecycle.v5",
  title: "SmartFlow 端到端生产流程",
  schemaVersion: 5,
  entryStageId: "stage.external.approval",
  repairRoundLimit: 15,
  noProgressLimit: 15,
  simulationKind: "ILLUSTRATIVE_SIMULATION",
  disclaimer: "页面使用基于代码结构的示例身份和 payload，不是 live telemetry。"
});

export const ACTORS = Object.freeze([
  { id: "host", code: "HOST", name: "用户 / Host", role: "批准、Reviewer 会话与用户决策" },
  { id: "mcp", code: "MCP", name: "MCP Gateway", role: "公开协议解析与转发" },
  { id: "daemon", code: "DMN", name: "Daemon", role: "机械编排与确定性策略" },
  { id: "ledger", code: "CAS", name: "StateStore", role: "Durable 恢复真相" },
  { id: "worker", code: "PI", name: "Pi Worker", role: "隔离代码执行" },
  { id: "workspace", code: "GIT", name: "Run Worktree", role: "快照、Candidate 与发布操作" },
  { id: "reviewer", code: "REV", name: "Independent Reviewer", role: "只读逐项复核" },
  { id: "project", code: "SRC", name: "Original Project", role: "Publish 前保持只读" }
]);

const STAGE_LIST = [
  stage({
    id: "stage.external.approval",
    badge: "01",
    title: "批准任务字节",
    shortTitle: "批准",
    kind: "external",
    phase: "NO RUN",
    tone: "cyan",
    layout: { row: 1, column: 1 },
    actorIds: ["host", "mcp", "project"],
    summary: "Host 稳定读取任务源并形成用户批准的内容哈希。",
    plainLanguage: "先把用户真正同意的任务内容锁定。此时还没有 Run，内容漂移会直接拒绝而不是创建一半工作单。",
    before: { run: "不存在", taskBytes: "未授权", projectWrite: "LOCKED" },
    after: { run: "不存在", taskBytes: "approvedSourceHash 已绑定", projectWrite: "LOCKED" },
    outputs: ["ApprovedTasksSnapshot", "approvedSourceHash"],
    sources: [
      source("apps/host-skill/src/approval.ts", "readStableApprovedTasks"),
      source("apps/daemon/src/approved-source.ts", "observeApprovedSource")
    ]
  }),
  stage({
    id: "stage.run.preparing",
    badge: "02",
    title: "创建 / 准备 Revision",
    shortTitle: "PREPARING",
    kind: "durable",
    phase: "PREPARING",
    tone: "cyan",
    layout: { row: 1, column: 2 },
    actorIds: ["mcp", "daemon", "ledger"],
    summary: "原子创建 Run 或接收自动修复生成的 Revision N+1。",
    plainLanguage: "这里是每一轮执行的统一入口：第一轮登记新 Run；修复轮登记新 Revision。任何 repair 都必须明确回到这里。",
    before: { phase: "NO_RUN 或 FIXING", revision: "— 或 N", stateVersion: "vN" },
    after: { phase: "PREPARING", revision: "1 或 N+1", schemaVersion: "5" },
    outputs: ["RunRecord", "TaskManifest", "TaskSource Artifact", "active task binding"],
    sources: [
      source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.execute"),
      source("apps/daemon/src/approved-revision.ts", "createApprovedRevision")
    ]
  }),
  stage({
    id: "stage.workspace.materialize",
    badge: "03",
    title: "物化私有工作区",
    shortTitle: "WORKSPACE",
    kind: "activity",
    phase: "PREPARING",
    tone: "cyan",
    layout: { row: 1, column: 3 },
    actorIds: ["daemon", "ledger", "workspace", "project"],
    summary: "从 Run baseline 或上一 Revision result snapshot 创建隔离 worktree。",
    plainLanguage: "Worker 只会拿到 Daemon 私有副本。第一轮复制原项目基线，后续修复直接从上一轮结果继续。",
    before: { phase: "PREPARING", inputSnapshot: "待物化", originalProject: "READ ONLY" },
    after: { phase: "PREPARING", workspace: "private + mutable", originalProject: "READ ONLY" },
    outputs: ["GitWorkspaceSnapshot", "WorkspaceRef", "sandboxId"],
    sources: [
      source("apps/daemon/src/worker-runner.ts", "WorkerRunner.prepareWorkspace"),
      source("packages/workspace/src/git-snapshot.ts", "captureGitSnapshot")
    ]
  }),
  stage({
    id: "stage.worker.running",
    badge: "04",
    title: "新 Worker Attempt",
    shortTitle: "RUNNING",
    kind: "durable",
    phase: "RUNNING",
    tone: "cyan",
    layout: { row: 1, column: 4 },
    actorIds: ["daemon", "worker", "workspace", "ledger"],
    summary: "Pi Worker 在私有 worktree 内实现当前批准 Revision。",
    plainLanguage: "每个 Revision 都启动新的 Worker Attempt。production 恢复不会把旧 Pi session 当作可继续的工作进程。",
    before: { phase: "PREPARING", attemptId: "—", workspace: "ready" },
    after: { phase: "RUNNING", attemptId: "new attempt", containment: "registered" },
    outputs: ["WorkerStartInput", "PiWorkerAttempt", "private file changes"],
    sources: [
      source("apps/daemon/src/worker-runner.ts", "WorkerRunner.run"),
      source("packages/provider-core/src/worker-provider.ts", "WorkerStartInput")
    ]
  }),
  stage({
    id: "stage.candidate.freeze",
    badge: "05",
    title: "冻结累计 Candidate",
    shortTitle: "CANDIDATE",
    kind: "activity",
    phase: "RUNNING",
    tone: "cyan",
    layout: { row: 1, column: 5 },
    actorIds: ["worker", "workspace", "daemon", "ledger"],
    summary: "把当前结果冻结为从 Run baseline 到最终结果的精简累计 Candidate。",
    plainLanguage: "Reviewer 和发布都检查同一份完整候选；这里只保存快照引用哈希和累计操作，patch 到发布时才从 Git trees 临时生成。",
    before: { phase: "RUNNING", resultSnapshot: "mutable workspace", candidate: "—" },
    after: { phase: "RUNNING", resultSnapshot: "frozen", candidate: "v3 hash-bound" },
    outputs: ["Candidate v3", "result snapshot"],
    sources: [source("apps/daemon/src/worker-runner.ts", "WorkerRunner.captureCandidate")]
  }),
  stage({
    id: "stage.review.pending",
    badge: "06",
    title: "等待 Review Turn",
    shortTitle: "REVIEW_PENDING",
    kind: "durable",
    phase: "REVIEW_PENDING",
    tone: "violet",
    layout: { row: 1, column: 6 },
    actorIds: ["daemon", "ledger", "host"],
    summary: "Candidate 已固定，ReviewHostAction 等待 owning Host 开始 composite turn。",
    plainLanguage: "代码已经停笔，系统正在等 Host 接手独立评审。这里没有旧版 CLAIMING checkpoint。",
    before: { phase: "RUNNING", pendingAction: "—", candidate: "frozen" },
    after: { phase: "REVIEW_PENDING", pendingAction: "ReviewHostAction", reviewerMode: "CREATE 或 RESUME" },
    outputs: ["ReviewHostAction", "reviewAttemptId", "reviewer mode"],
    sources: [
      source("apps/daemon/src/worker-runner.ts", "WorkerRunner.captureCandidate"),
      source("packages/state-store/src/schema.ts", "hostActionSchema")
    ]
  }),
  stage({
    id: "stage.review.active",
    badge: "07",
    title: "原子开始 Review",
    shortTitle: "REVIEWING",
    kind: "durable",
    phase: "REVIEWING",
    tone: "violet",
    layout: { row: 2, column: 6 },
    actorIds: ["host", "mcp", "daemon", "ledger"],
    summary: "一次 mutation 写入 REVIEWING 与 AWAITING_REVIEW，再返回 worktreePath。",
    plainLanguage: "Host 的 30 分钟回调窗口和所有身份绑定先落盘，之后才披露评审目录；没有独立 claim lease 状态机。",
    before: { phase: "REVIEW_PENDING", hostTurn: "—", worktreePath: "not disclosed" },
    after: { phase: "REVIEWING", hostTurn: "AWAITING_REVIEW", deadline: "30 minutes" },
    outputs: ["REVIEW_REQUIRED", "turnToken", "worktreePath", "reviewerSession mode"],
    sources: [
      source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.beginReview"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.beginReview")
    ]
  }),
  stage({
    id: "stage.reviewer.evaluate",
    badge: "08",
    title: "独立 Reviewer 逐项评分",
    shortTitle: "REVIEWER",
    kind: "activity",
    phase: "REVIEWING",
    tone: "violet",
    layout: { row: 2, column: 5 },
    actorIds: ["host", "reviewer", "workspace"],
    summary: "首轮 CREATE，后续 Revision RESUME 同一个 Reviewer session。",
    plainLanguage: "Reviewer 只读任务和 Candidate，给每个 Task 打分并提出可定位 finding；它与写代码的 Pi Worker 是不同会话。",
    before: { phase: "REVIEWING", reviewer: "CREATE 或 bound session", result: "—" },
    after: { phase: "REVIEWING", reviewer: "bound reviewerSessionId", result: "every Task scored" },
    outputs: ["ReviewSubmission", "reviewerSessionId", "findings"],
    sources: [
      source("apps/host-skill/src/reviewer.ts", "reviewer integration"),
      source("apps/daemon/src/review-coordinator.ts", "assertReviewerContext")
    ]
  }),
  stage({
    id: "stage.review.decision",
    badge: "09",
    title: "原子 Review 决策",
    shortTitle: "POLICY GATE",
    kind: "activity",
    phase: "REVIEWING → next",
    tone: "violet",
    layout: { row: 2, column: 4 },
    actorIds: ["daemon", "ledger", "reviewer"],
    summary: "同一 finalize mutation 写 Review/Decision Artifact 并直接选择发布、修复或暂停。",
    plainLanguage: "只有 APPROVE、100% 且没有阻塞问题才通过。当前主流程不会先停在 LEADER_DECISION。",
    before: { phase: "REVIEWING", review: "submitted", hostTurn: "AWAITING_REVIEW" },
    after: { phase: "READY_TO_PUBLISH / FIXING / PAUSED", hostTurn: "cleared 或 AWAITING_USER_INPUT" },
    outputs: ["DurableReviewDecision", "DurableLeaderDecision", "next phase"],
    sources: [
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview"),
      source("packages/review/src/review-decision.ts", "planReviewDecision")
    ]
  }),
  stage({
    id: "stage.publish.ready",
    badge: "10",
    title: "发布条件已满足",
    shortTitle: "READY_TO_PUBLISH",
    kind: "durable",
    phase: "READY_TO_PUBLISH",
    tone: "green",
    layout: { row: 2, column: 3 },
    actorIds: ["daemon", "ledger", "workspace"],
    summary: "Candidate、Review 与 accept Decision 的哈希绑定已验证。",
    plainLanguage: "评审通过不等于已经写入项目；这里只是允许 Daemon 准备发布包，原项目仍然锁定。",
    before: { phase: "REVIEWING", decision: "accept", projectWrite: "LOCKED" },
    after: { phase: "READY_TO_PUBLISH", decision: "accept", projectWrite: "LOCKED" },
    outputs: ["accepted evidence chain", "publish schedule"],
    sources: [source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")]
  }),
  stage({
    id: "stage.publish.preflight",
    badge: "11",
    title: "全路径 Publish Preflight",
    shortTitle: "PUBLISHING",
    kind: "activity",
    phase: "PUBLISHING",
    tone: "green",
    layout: { row: 2, column: 2 },
    actorIds: ["daemon", "ledger", "workspace", "project"],
    summary: "按需生成累计 Git patch，并冻结带 blobs 的签名 Bundle 后执行全路径 expected-old 检查。",
    plainLanguage: "先把最终 patch、操作和文件内容封进唯一自包含 Bundle，再一次性检查所有路径；默认 adapter 直接读 Bundle，不另存 publish blobs。",
    before: { phase: "READY_TO_PUBLISH", publishAttempt: "—", projectWrite: "LOCKED" },
    after: { phase: "PUBLISHING", publishAttempt: "PREPARED", preflight: "all paths match 或 conflict" },
    outputs: ["DeliveryBundle", "ApplyOperation[]", "PublishAttempt"],
    sources: [
      source("apps/daemon/src/publish-coordinator.ts", "PublishCoordinator.publish"),
      source("packages/publish/src/preflight.ts", "preflightOperations")
    ]
  }),
  stage({
    id: "stage.publish.apply",
    badge: "12",
    title: "应用并对账",
    shortTitle: "PUBLISHING",
    kind: "durable",
    phase: "PUBLISHING",
    tone: "green",
    layout: { row: 2, column: 1 },
    actorIds: ["daemon", "ledger", "project"],
    summary: "以稳定 operationId 应用预检通过的操作，并逐路径确认结果。",
    plainLanguage: "写入响应丢失时不会盲目重放；Daemon 会先查询相同 operationId，只有全部路径可证明提交才算成功。",
    before: { phase: "PUBLISHING", attempt: "PREPARED", projectWrite: "LOCKED" },
    after: { phase: "PUBLISHING 或 COMPLETED/PAUSED", attempt: "SUBMITTED / reconciled" },
    outputs: ["PublishResult", "path receipts", "operation reconciliation"],
    sources: [
      source("packages/publish/src/publish-service.ts", "PublishService.publish"),
      source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverPublish")
    ]
  }),
  stage({
    id: "stage.terminal.completed",
    badge: "13",
    title: "Durable 完成",
    shortTitle: "COMPLETED",
    kind: "terminal",
    phase: "COMPLETED",
    tone: "green",
    layout: { row: 3, column: 1 },
    actorIds: ["daemon", "ledger", "project"],
    summary: "全部发布路径已证明 COMMITTED，Run 进入持久化终态。",
    plainLanguage: "完成后清理 worktree 和 Git object store；签名 DeliveryBundle 保留为唯一自包含最终内容副本，不再旁挂 patch/evidence/publish-blob 副本。",
    before: { phase: "PUBLISHING", publishResult: "pending" },
    after: { phase: "COMPLETED", publishResult: "COMMITTED", projectWrite: "APPLIED" },
    outputs: ["terminal RunRecord", "committed PublishResult", "signed DeliveryBundle"],
    sources: [source("apps/daemon/src/publish-coordinator.ts", "PublishCoordinator")]
  }),
  stage({
    id: "stage.output.done",
    badge: "OUT",
    title: "Host 收到 DONE",
    shortTitle: "output.kind=DONE",
    kind: "output",
    phase: "COMPLETED + DONE",
    tone: "green",
    terminal: true,
    layout: { row: 3, column: 2 },
    actorIds: ["daemon", "mcp", "host"],
    summary: "review_turn 在终态返回 canonical ResultOutput。",
    plainLanguage: "DONE 是协议响应，不是新的 RunPhase；持久化状态仍然是 COMPLETED。",
    before: { phase: "COMPLETED", output: "not returned" },
    after: { phase: "COMPLETED", output: "kind=DONE" },
    outputs: ["ReviewTurnOutput.DONE", "ResultOutput"],
    sources: [source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.advance")]
  }),
  stage({
    id: "stage.repair.prepare-revision",
    badge: "R2",
    title: "构造受限 Revision",
    shortTitle: "SCOPED REVISION",
    kind: "activity",
    phase: "FIXING",
    tone: "amber",
    layout: { row: 3, column: 4 },
    actorIds: ["daemon", "ledger", "workspace"],
    summary: "比较 blocker 与相关路径，追加受原验收范围约束的修复任务。",
    plainLanguage: "能证明没有扩大范围时自动创建下一 Revision；证明不了就进入 PAUSED 等用户批准。",
    before: { phase: "FIXING", revision: "N", repairRound: "selected" },
    after: { phase: "PREPARING 或 PAUSED", revision: "N+1 或 N", approval: "LEADER_REPAIR 或 USER" },
    outputs: ["RepairRound", "scoped task append", "approval envelope"],
    sources: [source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.prepare")]
  }),
  stage({
    id: "stage.repair.fixing",
    badge: "R1",
    title: "进入自动修复",
    shortTitle: "FIXING",
    kind: "durable",
    phase: "FIXING",
    tone: "amber",
    layout: { row: 3, column: 5 },
    actorIds: ["daemon", "ledger", "reviewer"],
    summary: "Review blocker 被选择为 repairItems，自动修复计数增加。",
    plainLanguage: "修复范围来自 Reviewer 的具体 fingerprint；第 1 到第 15 次可以自动进入，下一次失败会暂停。",
    before: { phase: "REVIEWING", autoRepairRounds: "n", blockers: "> 0" },
    after: { phase: "FIXING", autoRepairRounds: "n + 1", blockers: "selected fingerprints" },
    outputs: ["repair decision", "repairItems", "updated autoRepairRounds"],
    sources: [
      source("packages/review/src/review-decision.ts", "planReviewDecision"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")
    ]
  }),
  stage({
    id: "stage.recovery.reconcile",
    badge: "RCV",
    title: "重启后对账",
    shortTitle: "RECOVERY",
    kind: "recovery",
    phase: "原 phase 决定",
    tone: "violet",
    layout: { row: 3, column: 6 },
    actorIds: ["daemon", "ledger", "worker", "project"],
    summary: "按 PREPARING、RUNNING、REVIEWING 或 PUBLISHING 的 durable 证据选择恢复路径。",
    plainLanguage: "重启不会一律重跑：Worker 先核销进程，Review 继续等同一 Host，Publish 先查询 operationId。",
    before: { runtime: "restarted", phase: "persisted", externalOutcome: "unknown" },
    after: { runtime: "new fence", phase: "continue / completed / paused", externalOutcome: "reconciled" },
    outputs: ["recovery epoch", "process or publish reconciliation", "safe next phase"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recover")]
  }),
  stage({
    id: "stage.terminal.canceled",
    badge: "END",
    title: "取消完成",
    shortTitle: "CANCELED",
    kind: "terminal",
    phase: "CANCELED",
    tone: "red",
    terminal: true,
    layout: { row: 4, column: 1 },
    actorIds: ["daemon", "ledger", "host"],
    summary: "所有未决 Worker、Review 和 Publish 身份已被核销。",
    plainLanguage: "只有确认不会再有后台副作用，取消才从 CANCELING 进入 CANCELED。",
    before: { phase: "CANCELING", identities: "reconciling" },
    after: { phase: "CANCELED", identities: "settled" },
    outputs: ["terminal CancellationRecord"],
    sources: [source("apps/daemon/src/cancel-manager.ts", "CancelManager")]
  }),
  stage({
    id: "stage.cancel.running",
    badge: "CXL",
    title: "核销活动身份",
    shortTitle: "CANCELING",
    kind: "durable",
    phase: "CANCELING",
    tone: "red",
    layout: { row: 4, column: 2 },
    actorIds: ["host", "daemon", "ledger", "worker"],
    summary: "停止并核对 Worker、Review continuation 与 Publish operation。",
    plainLanguage: "取消不是立刻把状态涂成红色；它先确认所有可能继续产生副作用的身份都已停止。",
    before: { phase: "active 或 PAUSED", cancellation: "requested" },
    after: { phase: "CANCELING", cancellation: "reconciling" },
    outputs: ["CancellationRecord", "identity reconciliation"],
    sources: [
      source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.cancel"),
      source("apps/daemon/src/cancel-manager.ts", "CancelManager")
    ]
  }),
  stage({
    id: "stage.pause.awaiting-user",
    badge: "PAU",
    title: "安全暂停 / 等待用户",
    shortTitle: "PAUSED",
    kind: "pause",
    phase: "PAUSED",
    tone: "red",
    layout: { row: 4, column: 4 },
    actorIds: ["daemon", "ledger", "host", "mcp"],
    summary: "额度、范围、源漂移、Provider、Review 或 Publish 证据不足时停止自动推进。",
    plainLanguage: "暂停不是失败被吞掉，而是把原因、证据和唯一允许动作明确交给用户。",
    before: { phase: "任一非终态", safetyProof: "insufficient" },
    after: { phase: "PAUSED", pauseCode: "typed", resumeActions: "explicit" },
    outputs: ["PauseRecord", "USER_INPUT_REQUIRED", "inspection + resume options"],
    sources: [
      source("packages/state-store/src/schema.ts", "pauseRecordSchema"),
      source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.requireUserInput")
    ]
  }),
  stage({
    id: "stage.external.rejected",
    badge: "REJ",
    title: "创建前拒绝",
    shortTitle: "NO RUN CREATED",
    kind: "rejection",
    phase: "NO RUN",
    tone: "red",
    terminal: true,
    layout: { row: 4, column: 6 },
    actorIds: ["host", "mcp", "daemon"],
    summary: "execute 前批准源漂移或输入不可信，不创建 jobId。",
    plainLanguage: "还没有 Run 时无法“暂停恢复”；用户必须恢复批准字节或重新批准后重新 execute。",
    before: { run: "不存在", approvedHash: "expected", observedHash: "different" },
    after: { run: "仍不存在", error: "APPROVED_SOURCE_DRIFT" },
    outputs: ["typed rejection"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.execute")]
  })
];

export const STAGES = Object.freeze(STAGE_LIST);

const MAIN = [
  transition({
    id: "tr.execute.create-run", fromStageId: "stage.external.approval", toStageId: "stage.run.preparing",
    label: "批准一致，创建 Durable Run", graphLabel: "创建 Run", lane: "main", tone: "cyan",
    condition: "Daemon 复算任务字节哈希、路径与 active task binding 均有效。",
    explanation: "一次 CAS mutation 创建 schema v5 Run、Revision 1 Manifest、TaskSource Artifact 和路径占用。",
    before: { phase: "NO_RUN", revision: "—" }, after: { phase: "PREPARING", revision: "1" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.approval.snapshot", "data.execute.input", "data.run.record"],
    payloadExample: "{ tasksPath, approvedSourceHash, requestId } → { jobId, revision: 1 }",
    changes: ["RunRecord.phase: — → PREPARING", "stateVersion: 0 → 1", "activeRunsByTaskPath: empty → jobId"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.execute")]
  }),
  transition({
    id: "tr.pipeline.materialize", fromStageId: "stage.run.preparing", toStageId: "stage.workspace.materialize",
    label: "物化当前 Revision 的私有输入", graphLabel: "物化快照", lane: "main", tone: "cyan",
    condition: "Run 处于 PREPARING，输入 snapshot 与 Git capability 可验证。",
    explanation: "Revision 1 使用 Run baseline；修复 Revision 使用上一轮 result snapshot。",
    before: { phase: "PREPARING", workspace: "—" }, after: { phase: "PREPARING", workspace: "private" },
    actorIds: ["daemon", "ledger", "workspace", "project"], dataDetailIds: ["data.workspace.snapshot", "data.run.record"],
    payloadExample: "inputSnapshot ArtifactRef → workspaces/revision-N",
    changes: ["workspace: — → WorkspaceRef", "original project: READ ONLY → READ ONLY"],
    sources: [source("apps/daemon/src/worker-runner.ts", "WorkerRunner.prepareWorkspace")]
  }),
  transition({
    id: "tr.pipeline.start-worker", fromStageId: "stage.workspace.materialize", toStageId: "stage.worker.running",
    label: "启动新的 Worker Attempt", graphLabel: "新 Worker", lane: "main", tone: "cyan",
    condition: "Provider probe、workspace containment 与 runtime config hash 均通过。",
    explanation: "每一 Revision 创建新 attemptId 和 generation；当前 production 不恢复旧 Pi session。",
    before: { phase: "PREPARING", attempt: "—" }, after: { phase: "RUNNING", attempt: "STARTED" },
    actorIds: ["daemon", "worker", "workspace", "ledger"], dataDetailIds: ["data.worker.attempt", "data.workspace.snapshot"],
    payloadExample: "WorkerStartInput { revision: N, workspaceDir, deadlineAt }",
    changes: ["phase: PREPARING → RUNNING", "workerAttempts[]: + new attempt", "containment: registered"],
    sources: [source("apps/daemon/src/worker-runner.ts", "WorkerRunner.run")]
  }),
  transition({
    id: "tr.worker.freeze-candidate", fromStageId: "stage.worker.running", toStageId: "stage.candidate.freeze",
    label: "完成 Attempt 并冻结结果", graphLabel: "冻结结果", lane: "main", tone: "cyan",
    condition: "Worker 终态与进程树已核销，workspace 可安全快照。",
    explanation: "捕获 result snapshot，并从最初 Run baseline 构建累计 Candidate。",
    before: { phase: "RUNNING", workspace: "mutable" }, after: { phase: "RUNNING", resultSnapshot: "frozen" },
    actorIds: ["worker", "workspace", "daemon", "ledger"], dataDetailIds: ["data.worker.attempt", "data.candidate.bundle"],
    payloadExample: "private worktree → resultSnapshot + cumulative operations",
    changes: ["attempt.status: RUNNING → COMPLETED", "resultSnapshot: — → ArtifactRef", "candidate: — → hash-bound"],
    sources: [source("apps/daemon/src/worker-runner.ts", "WorkerRunner.captureCandidate")]
  }),
  transition({
    id: "tr.worker.candidate-ready", fromStageId: "stage.candidate.freeze", toStageId: "stage.review.pending",
    label: "登记 Candidate 与 Review Action", graphLabel: "Review 就绪", lane: "main", tone: "violet",
    condition: "Candidate 非空，或 manifest 明确允许 no-change。",
    explanation: "Run 进入 REVIEW_PENDING；首轮 action 使用 CREATE，已有唯一历史 Reviewer 时使用 RESUME。",
    before: { phase: "RUNNING", pendingAction: "—" }, after: { phase: "REVIEW_PENDING", pendingAction: "ReviewHostAction" },
    actorIds: ["workspace", "daemon", "ledger", "host"], dataDetailIds: ["data.candidate.bundle", "data.review.host-action"],
    payloadExample: "{ candidateHash, changedPaths, reviewerSession: CREATE|RESUME }",
    changes: ["phase: RUNNING → REVIEW_PENDING", "pendingAction: — → ReviewHostAction"],
    sources: [source("apps/daemon/src/worker-runner.ts", "WorkerRunner.captureCandidate")]
  }),
  transition({
    id: "tr.review.begin", fromStageId: "stage.review.pending", toStageId: "stage.review.active",
    label: "原子开始 Composite Review Turn", graphLabel: "开始 Review", lane: "main", tone: "violet",
    condition: "artifact integrity、approved source 与 owning Host identity 仍有效。",
    explanation: "单次 mutation 直接写 REVIEWING + AWAITING_REVIEW，再返回 REVIEW_REQUIRED；没有 CLAIMING 中间态。",
    before: { phase: "REVIEW_PENDING", hostTurn: "—" }, after: { phase: "REVIEWING", hostTurn: "AWAITING_REVIEW" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.review.host-action", "data.run.record"],
    payloadExample: "REVIEW_REQUIRED { turnToken, worktreePath, reviewAttemptId, deadlineAt }",
    changes: ["phase: REVIEW_PENDING → REVIEWING", "hostTurn: — → AWAITING_REVIEW", "deadline: — → 30 minutes"],
    sources: [
      source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.beginReview"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.beginReview")
    ]
  }),
  transition({
    id: "tr.reviewer.create", fromStageId: "stage.review.active", toStageId: "stage.reviewer.evaluate",
    label: "首轮 CREATE 独立 Reviewer", graphLabel: "CREATE Reviewer", lane: "main", tone: "violet", bend: -22,
    condition: "reviewerSession.mode=CREATE 且历史没有已绑定 Reviewer session。",
    explanation: "Host 创建与 Pi Worker 不同的独立 Reviewer；Reviewer 在 worktree 中只读检查。",
    before: { phase: "REVIEWING", reviewerBinding: "—" }, after: { phase: "REVIEWING", reviewerBinding: "pending first valid submission" },
    actorIds: ["host", "reviewer", "workspace"], dataDetailIds: ["data.review.host-action", "data.review.submission"],
    payloadExample: "{ mode: CREATE, reviewAttemptId, piSessionId }",
    changes: ["Reviewer native session: — → created", "Run phase remains REVIEWING"],
    sources: [source("apps/daemon/src/review-coordinator.ts", "assertReviewerContext")]
  }),
  transition({
    id: "tr.reviewer.resume", fromStageId: "stage.review.active", toStageId: "stage.reviewer.evaluate",
    label: "修复轮 RESUME 同一 Reviewer", graphLabel: "RESUME Reviewer", lane: "repair", tone: "amber", bend: 24,
    condition: "reviewerSession.mode=RESUME 且 reviewerSessionId 匹配唯一历史绑定。",
    explanation: "新的 Candidate 回到同一个 Reviewer 上下文；只复用 Reviewer，不复用旧 Worker/Pi session。",
    before: { phase: "REVIEWING", reviewerBinding: "reviewer-session-r9" }, after: { phase: "REVIEWING", reviewerBinding: "same reviewer-session-r9" },
    actorIds: ["host", "reviewer", "workspace"], dataDetailIds: ["data.review.host-action", "data.review.submission"],
    payloadExample: "{ mode: RESUME, reviewerSessionId: 'reviewer-session-r9' }",
    changes: ["Reviewer session: bound → same bound session", "Candidate hash: revision N → revision N+1"],
    sources: [source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")]
  }),
  transition({
    id: "tr.review.submit", fromStageId: "stage.reviewer.evaluate", toStageId: "stage.review.decision",
    label: "提交逐项 Review 并执行固定规则", graphLabel: "提交评分", lane: "main", tone: "violet",
    condition: "turnToken、deadline、revision、hash、reviewAttemptId 与 Reviewer binding 全部匹配。",
    explanation: "规范化每项 Task，写 Review 和 LeaderDecision Artifact，并在同一 mutation 选择下一 phase。",
    before: { phase: "REVIEWING", review: "—" }, after: { phase: "REVIEWING → policy output", review: "hash-bound" },
    actorIds: ["reviewer", "host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.review.submission", "data.review.decision"],
    payloadExample: "{ reviewerSessionId, result: { tasks[], completionPercentage, verdict, findings[] } }",
    changes: ["reviewHistory[]: + entry", "review Artifact: — → written", "leaderDecision Artifact: — → written"],
    sources: [source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")]
  }),
  transition({
    id: "tr.review.accept", fromStageId: "stage.review.decision", toStageId: "stage.publish.ready",
    label: "Accept：APPROVE + 100% + 0 blocker", graphLabel: "ACCEPT", lane: "main", tone: "green",
    condition: "verdict=APPROVE、completionPercentage=100 且 blockingFindings.length=0。",
    explanation: "Review finalize 原子进入 READY_TO_PUBLISH，并调度 publish。",
    before: { phase: "REVIEWING", gate: "all green" }, after: { phase: "READY_TO_PUBLISH", decision: "accept" },
    actorIds: ["daemon", "ledger"], dataDetailIds: ["data.review.decision", "data.run.record"],
    payloadExample: "{ decision: 'accept', reviewHash, blockingFindings: [] }",
    changes: ["phase: REVIEWING → READY_TO_PUBLISH", "hostTurn: AWAITING_REVIEW → cleared"],
    sources: [
      source("packages/review/src/review-decision.ts", "planReviewDecision"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")
    ]
  }),
  transition({
    id: "tr.publish.start", fromStageId: "stage.publish.ready", toStageId: "stage.publish.preflight",
    label: "重验绑定并准备发布操作", graphLabel: "准备 Publish", lane: "main", tone: "green",
    condition: "Candidate、Review、Decision、revision 与 source binding 全部有效。",
    explanation: "从 baseline/result trees 按需生成累计 patch，把操作和最终 blobs 冻结为签名 DeliveryBundle，再生成稳定 operationId。",
    before: { phase: "READY_TO_PUBLISH", publishAttempt: "—" }, after: { phase: "PUBLISHING", publishAttempt: "PREPARED" },
    actorIds: ["daemon", "ledger", "workspace"], dataDetailIds: ["data.candidate.bundle", "data.review.decision", "data.publish.bundle"],
    payloadExample: "DeliveryBundle { operationId, operationsHash, operations[] }",
    changes: ["phase: READY_TO_PUBLISH → PUBLISHING", "PublishAttempt: — → PREPARED"],
    sources: [source("apps/daemon/src/publish-coordinator.ts", "PublishCoordinator.publish")]
  }),
  transition({
    id: "tr.publish.preflight-ok", fromStageId: "stage.publish.preflight", toStageId: "stage.publish.apply",
    label: "所有 touched path 通过预检", graphLabel: "全路径匹配", lane: "main", tone: "green",
    condition: "每条路径的 old hash、mode 或 absence 与当前原项目一致。",
    explanation: "只有 all-path preflight 全部通过，Adapter 才能开始第一笔写入。",
    before: { phase: "PUBLISHING", projectWrites: "0", preflight: "pending" }, after: { phase: "PUBLISHING", projectWrites: "allowed", preflight: "MATCH" },
    actorIds: ["daemon", "project", "ledger"], dataDetailIds: ["data.publish.bundle"],
    payloadExample: "7 ApplyOperation[] → ALL PATHS MATCH",
    changes: ["preflight: pending → MATCH", "publishedCount remains 0 until apply"],
    sources: [source("packages/publish/src/preflight.ts", "preflightOperations")]
  }),
  transition({
    id: "tr.publish.commit", fromStageId: "stage.publish.apply", toStageId: "stage.terminal.completed",
    label: "全部路径对账为 COMMITTED", graphLabel: "COMMITTED", lane: "main", tone: "green",
    condition: "operationId、operationsHash、path hash 与 mode 回执全部有效。",
    explanation: "只有可证明的完整提交才把 Run 从 PUBLISHING 推进到 COMPLETED。",
    before: { phase: "PUBLISHING", result: "SUBMITTED" }, after: { phase: "COMPLETED", result: "COMMITTED" },
    actorIds: ["project", "daemon", "ledger"], dataDetailIds: ["data.publish.bundle", "data.publish.result", "data.run.record"],
    payloadExample: "PublishResult { status: COMMITTED, publishedCount: 7 }",
    changes: ["phase: PUBLISHING → COMPLETED", "projectWrite: LOCKED → APPLIED", "active task binding: released"],
    sources: [
      source("packages/publish/src/publish-service.ts", "PublishService.finish"),
      source("apps/daemon/src/publish-coordinator.ts", "PublishCoordinator")
    ]
  }),
  transition({
    id: "tr.turn.done", fromStageId: "stage.terminal.completed", toStageId: "stage.output.done",
    label: "review_turn 返回 DONE", graphLabel: "output DONE", lane: "main", tone: "green",
    condition: "Run phase 属于 terminal set。",
    explanation: "HostTurnCoordinator 返回内嵌 canonical ResultOutput；DONE 不是新的 durable phase。",
    before: { phase: "COMPLETED", outputKind: "—" }, after: { phase: "COMPLETED", outputKind: "DONE" },
    actorIds: ["daemon", "mcp", "host"], dataDetailIds: ["data.result.output"],
    payloadExample: "{ kind: 'DONE', result: { phase: 'COMPLETED', revision: N } }",
    changes: ["durable phase remains COMPLETED", "protocol output: — → DONE"],
    sources: [source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.advance")]
  })
];

const REPAIR = [
  transition({
    id: "tr.review.request-repair", fromStageId: "stage.review.decision", toStageId: "stage.repair.fixing",
    label: "选择 blocker，进入自动修复", graphLabel: "REPAIR n→n+1", lane: "repair", tone: "amber", bend: -16,
    condition: "存在 actionable blocking finding，且当前 autoRepairRounds < 15。",
    explanation: "只选择当前 Review 的 finding fingerprint；决策时把自动修复计数增加 1。",
    before: { phase: "REVIEWING", autoRepairRounds: "n < 15" }, after: { phase: "FIXING", autoRepairRounds: "n + 1" },
    actorIds: ["reviewer", "daemon", "ledger"], dataDetailIds: ["data.review.decision", "data.repair.round", "data.run.record"],
    payloadExample: "{ decision: 'repair', repairItems: [findingFingerprint] }",
    changes: ["phase: REVIEWING → FIXING", "autoRepairRounds: n → n + 1", "repairItems: — → selected blockers"],
    sources: [
      source("packages/review/src/review-decision.ts", "planReviewDecision"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")
    ]
  }),
  transition({
    id: "tr.repair.prepare-draft", fromStageId: "stage.repair.fixing", toStageId: "stage.repair.prepare-revision",
    label: "评估进展并构造受限修复任务", graphLabel: "限定范围", lane: "repair", tone: "amber",
    condition: "Run 仍为 FIXING，Review/Decision/Candidate binding 可验证。",
    explanation: "比较 blocker 严格子集和相关路径哈希，生成只覆盖授权 criterion 的追加任务。",
    before: { phase: "FIXING", revision: "N", noProgressCount: "k" }, after: { phase: "FIXING", revisionDraft: "N+1", progress: "assessed" },
    actorIds: ["daemon", "ledger", "workspace"], dataDetailIds: ["data.repair.round", "data.revision.manifest"],
    payloadExample: "RepairRound + parent Manifest → scoped repair task append",
    changes: ["repairRound: previous → current", "noProgressCount: k → reset or k+1", "revision draft: — → N+1"],
    sources: [source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.prepare")]
  }),
  transition({
    id: "tr.repair.create-scoped-revision", fromStageId: "stage.repair.prepare-revision", toStageId: "stage.run.preparing",
    label: "自动创建 Revision N+1，回到 PREPARING", graphLabel: "↺ Revision N+1", lane: "repair", tone: "amber", route: "repair-back",
    condition: "deriveRepairApproval() 返回 LEADER_REPAIR，范围与 Provider 配置均未扩大。",
    explanation: "安全 repair 不经过 PAUSED/REPAIR_TASKS_READY；createApprovedRevision 直接建立下一 Revision 并回到统一入口。",
    before: { phase: "FIXING", revision: "N", approval: "LEADER_REPAIR" }, after: { phase: "PREPARING", revision: "N + 1", workerAttempt: "new next" },
    actorIds: ["daemon", "ledger", "workspace"], dataDetailIds: ["data.repair.round", "data.revision.manifest", "data.run.record"],
    payloadExample: "parent result snapshot + scoped tasks → approved Revision N+1",
    changes: ["phase: FIXING → PREPARING", "revision: N → N + 1", "next input: previous result snapshot", "next Worker: new Attempt"],
    sources: [
      source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.prepare"),
      source("apps/daemon/src/approved-revision.ts", "createApprovedRevision")
    ]
  })
];

const BRANCHES = [
  transition({
    id: "tr.execute.reject-source-drift", fromStageId: "stage.external.approval", toStageId: "stage.external.rejected",
    label: "execute 前批准源漂移", graphLabel: "源漂移 · 拒绝", lane: "pause", tone: "red", bend: 92,
    condition: "Daemon 观察到的任务字节哈希不等于 approvedSourceHash。",
    explanation: "Run 尚未创建，因此直接拒绝；恢复原字节或重新批准后重新 execute。",
    before: { phase: "NO_RUN", hash: "approved" }, after: { phase: "NO_RUN", error: "APPROVED_SOURCE_DRIFT" },
    actorIds: ["host", "mcp", "daemon"], dataDetailIds: ["data.approval.snapshot", "data.execute.input"],
    payloadExample: "approvedHash ≠ observedHash → rejection",
    changes: ["jobId remains absent", "no StateStore Run mutation"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.execute")]
  }),
  transition({
    id: "tr.pipeline.provider-unavailable", fromStageId: "stage.run.preparing", toStageId: "stage.pause.awaiting-user",
    label: "Provider 能力或配置不可用", graphLabel: "Provider 暂停", lane: "pause", tone: "red", bend: 54,
    condition: "coding tools、streaming、cancellation、session evidence 或 runtime config probe 未通过。",
    explanation: "在启动半初始化 Worker 前进入 typed pause，允许重新探测或取消。",
    before: { phase: "PREPARING", provider: "unproved" }, after: { phase: "PAUSED", pauseCode: "PROVIDER_UNAVAILABLE" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.pause.record", "data.run.record"],
    payloadExample: "resumeActions: ['retry_provider_probe', 'cancel']",
    changes: ["phase: PREPARING → PAUSED", "workerAttempts remains unchanged"],
    sources: [source("apps/daemon/src/project-runtime.ts", "provider gate")]
  }),
  transition({
    id: "tr.worker.empty-candidate", fromStageId: "stage.worker.running", toStageId: "stage.repair.fixing",
    label: "Worker 完成但 Candidate 为空", graphLabel: "空 Candidate → FIX", lane: "repair", tone: "amber", bend: 34,
    condition: "Worker completed、无 changed Candidate 且 Manifest 不允许 no-change。",
    explanation: "写入 WORKER_CANDIDATE_EMPTY finding，并复用同一受限 repair machinery。",
    before: { phase: "RUNNING", candidate: "empty" }, after: { phase: "FIXING", lastError: "WORKER_CANDIDATE_EMPTY" },
    actorIds: ["worker", "daemon", "ledger"], dataDetailIds: ["data.worker.attempt", "data.candidate.bundle", "data.repair.round"],
    payloadExample: "empty Candidate evidence → synthetic blocking finding",
    changes: ["phase: RUNNING → FIXING", "lastError.code: — → WORKER_CANDIDATE_EMPTY"],
    sources: [
      source("apps/daemon/src/worker-runner.ts", "WorkerRunner.captureCandidate"),
      source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.prepare")
    ]
  }),
  transition({
    id: "tr.worker.failure-pause", fromStageId: "stage.worker.running", toStageId: "stage.pause.awaiting-user",
    label: "Worker timeout / failure / containment 不明", graphLabel: "Worker 暂停", lane: "pause", tone: "red", bend: 24,
    condition: "Provider failed、deadline exceeded，或无法证明旧进程树已停止。",
    explanation: "保存 Attempt 和进程证据；未核销旧身份前禁止启动新 Attempt。",
    before: { phase: "RUNNING", attempt: "active" }, after: { phase: "PAUSED", pauseCode: "typed worker failure" },
    actorIds: ["worker", "daemon", "ledger", "host"], dataDetailIds: ["data.worker.attempt", "data.pause.record"],
    payloadExample: "ATTEMPT_DEADLINE_EXCEEDED / PI_CONTAINMENT_RECONCILIATION_REQUIRED",
    changes: ["phase: RUNNING → PAUSED", "lastError + resumeActions persisted"],
    sources: [source("apps/daemon/src/worker-runner.ts", "pauseForRuntimeFailure")]
  }),
  transition({
    id: "tr.review.invalid", fromStageId: "stage.review.decision", toStageId: "stage.pause.awaiting-user",
    label: "Review 不完整且无可执行 blocker", graphLabel: "INVALID_REVIEW", lane: "pause", tone: "red", bend: -26,
    condition: "未达到 accept，但没有 actionable blocking finding 可构造 repairItems。",
    explanation: "当前实现立即暂停，不存在历史 ADR 所述的三次自动 Reviewer 重试。",
    before: { phase: "REVIEWING", gate: "incomplete + no blocker" }, after: { phase: "PAUSED", pauseCode: "INVALID_REVIEW" },
    actorIds: ["reviewer", "daemon", "ledger", "host"], dataDetailIds: ["data.review.decision", "data.pause.record"],
    payloadExample: "USER_INPUT_REQUIRED { pause.code: 'INVALID_REVIEW' }",
    changes: ["phase: REVIEWING → PAUSED", "hostTurn: AWAITING_REVIEW → AWAITING_USER_INPUT"],
    sources: [source("packages/review/src/review-decision.ts", "planReviewDecision")]
  }),
  transition({
    id: "tr.review.repair-limit", fromStageId: "stage.review.decision", toStageId: "stage.pause.awaiting-user",
    label: "自动修复额度已达 15", graphLabel: "LIMIT 15", lane: "pause", tone: "red", bend: 26,
    condition: "仍有 blocker，且进入决策时 autoRepairRounds >= 15。",
    explanation: "不会创建第 16 个自动 Revision；owning Host 可显式给予一组新额度或取消。",
    before: { phase: "REVIEWING", autoRepairRounds: "15" }, after: { phase: "PAUSED", pauseCode: "AUTOMATIC_REPAIR_LIMIT" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.review.decision", "data.pause.record", "data.run.record"],
    payloadExample: "options: ['resume_review_decision', 'cancel']",
    changes: ["phase: REVIEWING → PAUSED", "autoRepairRounds remains 15"],
    sources: [
      source("packages/review/src/review-decision.ts", "REPAIR_ROUND_LIMIT"),
      source("apps/daemon/src/review-coordinator.ts", "ReviewCoordinator.finalizeReview")
    ]
  }),
  transition({
    id: "tr.review.source-drift", fromStageId: "stage.review.active", toStageId: "stage.pause.awaiting-user",
    label: "Review 信任边界发现任务源漂移", graphLabel: "源漂移 · PAUSE", lane: "pause", tone: "red", bend: -48,
    condition: "begin/finalize 边界 observed task source 与 approved hash 不一致。",
    explanation: "清理活动 HostTurn、刷新 Review Action，并记录恢复到 REVIEW_PENDING 的 phase。",
    before: { phase: "REVIEWING", approvedSource: "matches old hash" }, after: { phase: "PAUSED", pauseCode: "APPROVED_SOURCE_DRIFT" },
    actorIds: ["host", "daemon", "ledger"], dataDetailIds: ["data.approval.snapshot", "data.review.host-action", "data.pause.record"],
    payloadExample: "approvedSourceDrift { detectedFromPhase: REVIEWING, resumePhase: REVIEW_PENDING }",
    changes: ["phase: REVIEWING → PAUSED", "hostTurn: cleared", "pendingAction: refreshed"],
    sources: [source("apps/daemon/src/review-coordinator.ts", "pauseForApprovedSourceDrift")]
  }),
  transition({
    id: "tr.review.host-unavailable", fromStageId: "stage.review.active", toStageId: "stage.pause.awaiting-user",
    label: "Reviewer callback 不可用或 30 分钟超时", graphLabel: "HOST 超时", lane: "pause", tone: "red", bend: 48,
    condition: "Host 明示 unavailable，或 durable review deadline 到期。",
    explanation: "保留/刷新 Review Action 并进入 HOST_REVIEW_UNAVAILABLE pause，不偷偷换 Reviewer。",
    before: { phase: "REVIEWING", hostTurn: "AWAITING_REVIEW" }, after: { phase: "PAUSED", pauseCode: "HOST_REVIEW_UNAVAILABLE" },
    actorIds: ["host", "daemon", "ledger"], dataDetailIds: ["data.review.host-action", "data.pause.record"],
    payloadExample: "resumeActions: ['retry_host_review', 'cancel']",
    changes: ["phase: REVIEWING → PAUSED", "hostTurn: AWAITING_REVIEW → AWAITING_USER_INPUT"],
    sources: [
      source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.recoverRun"),
      source("apps/daemon/src/review-coordinator.ts", "pauseForHostUnavailable")
    ]
  }),
  transition({
    id: "tr.repair.no-progress", fromStageId: "stage.repair.fixing", toStageId: "stage.pause.awaiting-user",
    label: "连续 15 次无法证明修复进展", graphLabel: "NO PROGRESS 15", lane: "pause", tone: "red", bend: -32,
    condition: "blocker 不是严格子集或相关路径未变化，noProgressCount 达到 15。",
    explanation: "仅重新运行一轮不算进展；系统展示 fingerprint 与路径证据后暂停。",
    before: { phase: "FIXING", noProgressCount: "14" }, after: { phase: "PAUSED", pauseCode: "REPAIR_NO_PROGRESS" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.repair.round", "data.pause.record"],
    payloadExample: "{ findings, relevantPathHashes, noProgressCount: 15 }",
    changes: ["phase: FIXING → PAUSED", "noProgressCount: 14 → 15"],
    sources: [
      source("packages/review/src/repair-loop.ts", "assessRepairProgress"),
      source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.pause")
    ]
  }),
  transition({
    id: "tr.repair.require-user-approval", fromStageId: "stage.repair.prepare-revision", toStageId: "stage.pause.awaiting-user",
    label: "无法证明修复仍在批准范围", graphLabel: "USER 批准", lane: "pause", tone: "red", bend: 34,
    condition: "deriveRepairApproval() 返回 USER，例如改删旧任务、criterion 越界或配置改变。",
    explanation: "保存 repair draft 和差异，等待用户确认新的 manifest revision。",
    before: { phase: "FIXING", approval: "unproved" }, after: { phase: "PAUSED", pauseCode: "REPAIR_USER_APPROVAL_REQUIRED" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.repair.round", "data.revision.manifest", "data.pause.record"],
    payloadExample: "requiredInput: confirm approve_new_manifest_revision",
    changes: ["phase: FIXING → PAUSED", "repairDraft: — → ArtifactRef", "approval.kind: — → USER"],
    sources: [source("apps/daemon/src/repair-coordinator.ts", "RepairCoordinator.prepare")]
  }),
  transition({
    id: "tr.pause.resume-repair-budget", fromStageId: "stage.pause.awaiting-user", toStageId: "stage.repair.fixing",
    label: "Host 明确给予新自动修复额度", graphLabel: "新额度 → FIX", lane: "repair", tone: "amber", bend: -42,
    condition: "owning Host 用相同 turnToken 回答 resume_review_decision。",
    explanation: "使用已保存 Review 重新计算，autoRepairRounds 重置后下一次 repair 记为 1。",
    before: { phase: "PAUSED", pauseCode: "AUTOMATIC_REPAIR_LIMIT", autoRepairRounds: "15" }, after: { phase: "FIXING", autoRepairRounds: "1" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.pause.record", "data.review.decision", "data.run.record"],
    payloadExample: "answer: { action: 'resume_review_decision' }",
    changes: ["phase: PAUSED → FIXING", "autoRepairRounds: 15 → 1", "hostTurn: cleared"],
    sources: [source("apps/daemon/src/host-turn-coordinator.ts", "resumeReviewDecision")]
  }),
  transition({
    id: "tr.pause.approve-new-revision", fromStageId: "stage.pause.awaiting-user", toStageId: "stage.run.preparing",
    label: "用户批准 Revision N+1", graphLabel: "批准新 Revision", lane: "repair", tone: "amber", bend: 70,
    condition: "tasksPath、approvedSourceHash 与 USER approval envelope 均有效。",
    explanation: "显式用户批准后调用 createApprovedRevision，回到 PREPARING。",
    before: { phase: "PAUSED", revision: "N", approval: "USER pending" }, after: { phase: "PREPARING", revision: "N+1", approval: "USER" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.pause.record", "data.revision.manifest", "data.run.record"],
    payloadExample: "approve_new_manifest_revision { tasksPath, approvedSourceHash, approval }",
    changes: ["phase: PAUSED → PREPARING", "revision: N → N+1", "pause: cleared"],
    sources: [
      source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.resume"),
      source("apps/daemon/src/approved-revision.ts", "createApprovedRevision")
    ]
  }),
  transition({
    id: "tr.pause.restore-approved-source", fromStageId: "stage.pause.awaiting-user", toStageId: "stage.review.pending",
    label: "恢复原批准任务字节", graphLabel: "恢复批准源", lane: "recovery", tone: "violet", bend: -86,
    condition: "原批准内容已恢复且重新观察的 hash 匹配。",
    explanation: "Reviewing 漂移会安全回到 REVIEW_PENDING，以新的 HostTurn 再开始 Review。",
    before: { phase: "PAUSED", pauseCode: "APPROVED_SOURCE_DRIFT" }, after: { phase: "REVIEW_PENDING", approvedSource: "restored" },
    actorIds: ["host", "daemon", "ledger"], dataDetailIds: ["data.approval.snapshot", "data.pause.record", "data.review.host-action"],
    payloadExample: "restore_approved_tasks → refreshed ReviewHostAction",
    changes: ["phase: PAUSED → REVIEW_PENDING", "approvedSourceDrift: cleared"],
    sources: [source("apps/daemon/src/project-runtime.ts", "clearApprovedSourceDrift")]
  }),
  transition({
    id: "tr.pause.retry-host-review", fromStageId: "stage.pause.awaiting-user", toStageId: "stage.review.pending",
    label: "重新交付 Review Action", graphLabel: "重试 Host Review", lane: "recovery", tone: "violet", bend: -44,
    condition: "HOST_REVIEW_UNAVAILABLE pause 允许 retry_host_review。",
    explanation: "返回 REVIEW_PENDING 再创建 durable HostTurn；已有 Reviewer binding 时仍必须 RESUME。",
    before: { phase: "PAUSED", pauseCode: "HOST_REVIEW_UNAVAILABLE" }, after: { phase: "REVIEW_PENDING", pendingAction: "refreshed" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.pause.record", "data.review.host-action"],
    payloadExample: "retry_host_review → REVIEW_PENDING",
    changes: ["phase: PAUSED → REVIEW_PENDING", "hostTurn: cleared", "ReviewHostAction: refreshed"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.resume")]
  }),
  transition({
    id: "tr.publish.precheck-conflict", fromStageId: "stage.publish.preflight", toStageId: "stage.pause.awaiting-user",
    label: "任一路径 old hash / mode 不匹配", graphLabel: "0 写入冲突", lane: "pause", tone: "red", bend: -58,
    condition: "全路径 preflight 发现至少一个并发修改。",
    explanation: "在 apply 前停止，publishedCount 固定为 0；durable pause 暴露 retry/export/cancel。",
    before: { phase: "PUBLISHING", projectWrites: "0", preflight: "checking" }, after: { phase: "PAUSED", pauseCode: "PUBLISH_CONFLICT", projectWrites: "0" },
    actorIds: ["daemon", "project", "ledger", "host"], dataDetailIds: ["data.publish.bundle", "data.publish.result", "data.pause.record"],
    payloadExample: "PublishResult { status: PRECHECK_CONFLICT, publishedCount: 0 }",
    changes: ["phase: PUBLISHING → PAUSED", "publishedCount remains 0", "conflicts[]: + paths"],
    sources: [
      source("packages/publish/src/preflight.ts", "preflightOperations"),
      source("packages/publish/src/publish-service.ts", "PublishService.publish")
    ]
  }),
  transition({
    id: "tr.publish.recovery-blocked", fromStageId: "stage.publish.apply", toStageId: "stage.pause.awaiting-user",
    label: "Publish 返回 PARTIAL / UNKNOWN", graphLabel: "Publish 未知", lane: "pause", tone: "red", bend: -76,
    condition: "Adapter 结果无法证明完整 COMMITTED 或安全 CONFLICT。",
    explanation: "以稳定 operationId 保存证据并暂停；UNKNOWN 永远不会被标为 COMPLETED。",
    before: { phase: "PUBLISHING", result: "PARTIAL / UNKNOWN" }, after: { phase: "PAUSED", pauseCode: "PUBLISH_RECOVERY_BLOCKED" },
    actorIds: ["daemon", "project", "ledger", "host"], dataDetailIds: ["data.publish.bundle", "data.publish.result", "data.pause.record"],
    payloadExample: "resumeActions: ['inspect_recovery', 'retry_publish', 'cancel']",
    changes: ["phase: PUBLISHING → PAUSED", "operationId retained for reconcile"],
    sources: [
      source("packages/publish/src/publish-service.ts", "PublishService.recover"),
      source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverPublish")
    ]
  }),
  transition({
    id: "tr.cancel.request", fromStageId: "stage.pause.awaiting-user", toStageId: "stage.cancel.running",
    label: "用户选择取消", graphLabel: "CANCEL", lane: "cancel", tone: "red", bend: -14,
    condition: "当前 pause/composite turn 暴露 cancel，且 Host identity 与 version/revision 匹配。",
    explanation: "进入 CANCELING，开始核销所有可能继续产生副作用的身份。",
    before: { phase: "PAUSED", cancel: "requested" }, after: { phase: "CANCELING", cancel: "reconciling" },
    actorIds: ["host", "mcp", "daemon", "ledger"], dataDetailIds: ["data.pause.record", "data.cancel.record"],
    payloadExample: "cancel { expectedRevision, expectedStateVersion, reason }",
    changes: ["phase: PAUSED → CANCELING", "CancellationRecord: — → requested"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.cancel")]
  }),
  transition({
    id: "tr.cancel.complete", fromStageId: "stage.cancel.running", toStageId: "stage.terminal.canceled",
    label: "所有未决身份完成核销", graphLabel: "CANCELED", lane: "cancel", tone: "red",
    condition: "Worker 已停止，Review continuation 已失效，Publish 没有未知未决副作用。",
    explanation: "完成核销后进入 CANCELED 终态并释放任务路径占用。",
    before: { phase: "CANCELING", identities: "pending" }, after: { phase: "CANCELED", identities: "settled" },
    actorIds: ["daemon", "ledger", "worker", "project"], dataDetailIds: ["data.cancel.record", "data.run.record"],
    payloadExample: "CancellationRecord { workerStatus: STOPPED, completedAt }",
    changes: ["phase: CANCELING → CANCELED", "active task binding: released"],
    sources: [
      source("apps/daemon/src/cancel-manager.ts", "CancelManager"),
      source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverCancellation")
    ]
  })
];

const RECOVERY = [
  transition({
    id: "tr.recovery.enter-preparing", fromStageId: "stage.run.preparing", toStageId: "stage.recovery.reconcile",
    label: "Daemon 在 PREPARING 重启", graphLabel: "restart", lane: "recovery", tone: "violet", bend: -36,
    condition: "启动时读取到非终态 Run 仍处于 PREPARING。",
    explanation: "推进 runtime fence，并重新调度 workspace/pipeline；不创建额外 Revision。",
    before: { phase: "PREPARING", runtime: "old epoch" }, after: { phase: "PREPARING", runtime: "new epoch" },
    actorIds: ["daemon", "ledger"], dataDetailIds: ["data.recovery.epoch", "data.run.record"],
    payloadExample: "RecoveryResult { phase: PREPARING, action: reschedule }",
    changes: ["projectFence: n → n+1", "phase remains PREPARING"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recover")]
  }),
  transition({
    id: "tr.recovery.resume-preparing", fromStageId: "stage.recovery.reconcile", toStageId: "stage.run.preparing",
    label: "重新调度 PREPARING pipeline", graphLabel: "resume PREP", lane: "recovery", tone: "violet", bend: 38,
    condition: "没有需要先核销的未知外部副作用。",
    explanation: "恢复到同一 Revision 的统一 PREPARING 入口。",
    before: { phase: "PREPARING", scheduler: "lost" }, after: { phase: "PREPARING", scheduler: "restored" },
    actorIds: ["daemon", "ledger"], dataDetailIds: ["data.recovery.epoch", "data.run.record"],
    payloadExample: "same revision + new runtime fence",
    changes: ["pipeline schedule: absent → queued"],
    sources: [source("apps/daemon/src/project-runtime.ts", "ProjectRuntime.recover")]
  }),
  transition({
    id: "tr.recovery.enter-worker", fromStageId: "stage.worker.running", toStageId: "stage.recovery.reconcile",
    label: "Daemon 在 Worker 活动时重启", graphLabel: "reconcile Worker", lane: "recovery", tone: "violet", bend: -66,
    condition: "持久化 phase=RUNNING 且存在最近 Worker Attempt。",
    explanation: "用 process identity 和 containment 检查旧进程，不直接复用会话。",
    before: { phase: "RUNNING", process: "unknown after restart" }, after: { phase: "RUNNING", process: "inspected" },
    actorIds: ["daemon", "ledger", "worker"], dataDetailIds: ["data.worker.attempt", "data.recovery.epoch"],
    payloadExample: "inspectWorker { pid, startToken, containmentId }",
    changes: ["projectFence: n → n+1", "worker process: unknown → STOPPED or UNKNOWN"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverWorker")]
  }),
  transition({
    id: "tr.recovery.worker-stopped", fromStageId: "stage.recovery.reconcile", toStageId: "stage.run.preparing",
    label: "旧 Worker 已停止，创建新 Attempt", graphLabel: "STOPPED → PREP", lane: "recovery", tone: "violet", bend: 78,
    condition: "production inspectWorker 可证明旧进程树已停止。",
    explanation: "同一 Revision 回到 PREPARING，旧 Attempt 标记失败，下一 generation 使用新 Attempt。",
    before: { phase: "RUNNING", oldAttempt: "stopped" }, after: { phase: "PREPARING", nextAttempt: "new generation" },
    actorIds: ["daemon", "ledger", "worker"], dataDetailIds: ["data.worker.attempt", "data.recovery.epoch", "data.run.record"],
    payloadExample: "old attempt FAILED → new attempt scheduled",
    changes: ["phase: RUNNING → PREPARING", "old attempt: active → FAILED", "generation: n → n+1"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverWorker")]
  }),
  transition({
    id: "tr.recovery.worker-unknown", fromStageId: "stage.recovery.reconcile", toStageId: "stage.pause.awaiting-user",
    label: "无法证明旧 Worker 已停止", graphLabel: "UNKNOWN → PAUSE", lane: "recovery", tone: "violet", bend: -28,
    condition: "process identity 或 containment 无法安全核对。",
    explanation: "进入 PAUSED_PROCESS_RECONCILIATION，禁止同时启动第二个 Worker。",
    before: { phase: "RUNNING", process: "UNKNOWN" }, after: { phase: "PAUSED", pauseCode: "PAUSED_PROCESS_RECONCILIATION" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.worker.attempt", "data.recovery.epoch", "data.pause.record"],
    payloadExample: "inspectionOptions: ['inspect_processes']",
    changes: ["phase: RUNNING → PAUSED", "new Worker start: forbidden"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverWorker")]
  }),
  transition({
    id: "tr.recovery.enter-review", fromStageId: "stage.review.active", toStageId: "stage.recovery.reconcile",
    label: "Daemon 在 REVIEWING 重启", graphLabel: "reconcile Review", lane: "recovery", tone: "violet", bend: 62,
    condition: "durable HostTurn=AWAITING_REVIEW 且 deadline 尚未到期。",
    explanation: "恢复 deadline timer 并继续等待同一 Host/Reviewer identity，不创建重复 Reviewer。",
    before: { phase: "REVIEWING", timer: "lost", hostTurn: "durable" }, after: { phase: "REVIEWING", timer: "restored", hostTurn: "same" },
    actorIds: ["daemon", "ledger", "host", "reviewer"], dataDetailIds: ["data.review.host-action", "data.recovery.epoch"],
    payloadExample: "same turnToken + reviewAttemptId + reviewer mode",
    changes: ["runtime timer: absent → scheduled", "phase remains REVIEWING"],
    sources: [
      source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recover"),
      source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.recoverRun")
    ]
  }),
  transition({
    id: "tr.recovery.review-wait", fromStageId: "stage.recovery.reconcile", toStageId: "stage.review.active",
    label: "恢复同一 Review wait", graphLabel: "same Review", lane: "recovery", tone: "violet", bend: -64,
    condition: "HostTurn identity 完整且 30 分钟 deadline 未过。",
    explanation: "重新返回相同 REVIEW_REQUIRED 上下文；如果超时则走 HOST_REVIEW_UNAVAILABLE pause。",
    before: { phase: "REVIEWING", runtime: "reconciling" }, after: { phase: "REVIEWING", hostTurn: "AWAITING_REVIEW" },
    actorIds: ["daemon", "ledger", "host"], dataDetailIds: ["data.review.host-action", "data.recovery.epoch"],
    payloadExample: "REVIEW_REQUIRED { same reviewAttemptId, same binding }",
    changes: ["phase remains REVIEWING", "review deadline timer restored"],
    sources: [source("apps/daemon/src/host-turn-coordinator.ts", "HostTurnCoordinator.recoverRun")]
  }),
  transition({
    id: "tr.recovery.enter-publish", fromStageId: "stage.publish.apply", toStageId: "stage.recovery.reconcile",
    label: "Publish 响应丢失后重启", graphLabel: "reconcile Publish", lane: "recovery", tone: "violet", bend: 70,
    condition: "persisted phase=PUBLISHING 且存在稳定 operationId。",
    explanation: "先查询 Adapter 对相同 operationId 的真实结果，绝不盲目重放操作。",
    before: { phase: "PUBLISHING", result: "response lost" }, after: { phase: "PUBLISHING", result: "queried" },
    actorIds: ["daemon", "ledger", "project"], dataDetailIds: ["data.publish.bundle", "data.recovery.epoch"],
    payloadExample: "reconcile(operationId: 'publish-f14c')",
    changes: ["projectFence: n → n+1", "publish result: UNKNOWN → reconciled"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverPublish")]
  }),
  transition({
    id: "tr.recovery.publish-committed", fromStageId: "stage.recovery.reconcile", toStageId: "stage.terminal.completed",
    label: "对账确认 Publish 已 COMMITTED", graphLabel: "COMMITTED", lane: "recovery", tone: "violet", bend: 96,
    condition: "Adapter 返回与 operationId/operationsHash 一致的完整 COMMITTED 结果。",
    explanation: "即使原响应丢失，只要全部路径可证明提交，恢复流程可以安全进入 COMPLETED。",
    before: { phase: "PUBLISHING", result: "unknown" }, after: { phase: "COMPLETED", result: "COMMITTED" },
    actorIds: ["daemon", "ledger", "project"], dataDetailIds: ["data.publish.result", "data.recovery.epoch", "data.run.record"],
    payloadExample: "reconciled PublishResult { status: COMMITTED }",
    changes: ["phase: PUBLISHING → COMPLETED", "publish result: unknown → COMMITTED"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverPublish")]
  }),
  transition({
    id: "tr.recovery.publish-conflict", fromStageId: "stage.recovery.reconcile", toStageId: "stage.pause.awaiting-user",
    label: "对账确认 Conflict / 不完整结果", graphLabel: "CONFLICT → PAUSE", lane: "recovery", tone: "violet", bend: 28,
    condition: "Adapter 对账为有效 CONFLICT，或仍不能证明完整提交。",
    explanation: "写入 PUBLISH_CONFLICT / PUBLISH_RECOVERY_BLOCKED pause，交由用户检查、重试、导出或取消。",
    before: { phase: "PUBLISHING", result: "unknown" }, after: { phase: "PAUSED", pauseCode: "PUBLISH_CONFLICT" },
    actorIds: ["daemon", "ledger", "project", "host"], dataDetailIds: ["data.publish.result", "data.recovery.epoch", "data.pause.record"],
    payloadExample: "USER_INPUT_REQUIRED { pause.code: 'PUBLISH_CONFLICT' }",
    changes: ["phase: PUBLISHING → PAUSED", "conflict/recovery evidence retained"],
    sources: [source("apps/daemon/src/recovery-manager.ts", "RecoveryManager.recoverPublish")]
  })
];

export const TRANSITIONS = Object.freeze([...MAIN, ...REPAIR, ...BRANCHES, ...RECOVERY]);

const TO_DECISION_CREATE = [
  "tr.execute.create-run", "tr.pipeline.materialize", "tr.pipeline.start-worker",
  "tr.worker.freeze-candidate", "tr.worker.candidate-ready", "tr.review.begin",
  "tr.reviewer.create", "tr.review.submit"
];
const TO_REVIEW_ACTIVE = TO_DECISION_CREATE.slice(0, 6);
const FROM_PREPARING_TO_DECISION_CREATE = TO_DECISION_CREATE.slice(1);
const FROM_PREPARING_TO_DECISION_RESUME = [
  "tr.pipeline.materialize", "tr.pipeline.start-worker", "tr.worker.freeze-candidate",
  "tr.worker.candidate-ready", "tr.review.begin", "tr.reviewer.resume", "tr.review.submit"
];
const ACCEPT_TO_DONE = [
  "tr.review.accept", "tr.publish.start", "tr.publish.preflight-ok",
  "tr.publish.commit", "tr.turn.done"
];
const CANCEL = ["tr.cancel.request", "tr.cancel.complete"];

export const SCENARIOS = Object.freeze({
  repair: scenario({
    id: "repair", category: "核心路径", name: "自动修复一轮后成功", shortName: "REPAIR LOOP",
    description: "第一轮 Review 发现 blocker，创建 Revision 2，回到 PREPARING 并 RESUME 同一 Reviewer。",
    outcome: "COMPLETED · REVISION 2", tone: "amber", repairRounds: 1,
    transitionPath: [
      ...TO_DECISION_CREATE,
      "tr.review.request-repair", "tr.repair.prepare-draft", "tr.repair.create-scoped-revision",
      ...FROM_PREPARING_TO_DECISION_RESUME,
      ...ACCEPT_TO_DONE
    ]
  }),
  success: scenario({
    id: "success", category: "核心路径", name: "首轮 Review 通过", shortName: "HAPPY PATH",
    description: "一次 Worker、一次独立 Review，通过全路径预检后发布。",
    outcome: "COMPLETED · REVISION 1", tone: "green", repairRounds: 0,
    transitionPath: [...TO_DECISION_CREATE, ...ACCEPT_TO_DONE]
  }),
  repairLimit: scenario({
    id: "repairLimit", category: "暂停与恢复", name: "修复 15 轮后由 Host 给新额度", shortName: "REPAIR LIMIT",
    description: "第 16 次不会自动开始；Host 明确回答后以新额度创建下一 Revision。",
    outcome: "PAUSED → FIXING → COMPLETED", tone: "amber", repairRounds: 1,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.repair-limit", "tr.pause.resume-repair-budget",
      "tr.repair.prepare-draft", "tr.repair.create-scoped-revision",
      ...FROM_PREPARING_TO_DECISION_RESUME, ...ACCEPT_TO_DONE
    ]
  }),
  sourceDrift: scenario({
    id: "sourceDrift", category: "暂停与恢复", name: "Review 边界源漂移后恢复", shortName: "SOURCE DRIFT",
    description: "Review 已开始时任务源漂移，暂停并恢复原批准字节，再从 REVIEW_PENDING 重启。",
    outcome: "PAUSED → REVIEW_PENDING → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      ...TO_REVIEW_ACTIVE, "tr.review.source-drift", "tr.pause.restore-approved-source",
      "tr.review.begin", "tr.reviewer.create", "tr.review.submit", ...ACCEPT_TO_DONE
    ]
  }),
  hostUnavailable: scenario({
    id: "hostUnavailable", category: "暂停与恢复", name: "Host Reviewer 超时后重试", shortName: "HOST RETRY",
    description: "30 分钟 callback 到期后 typed pause，重新交付 Review Action。",
    outcome: "PAUSED → REVIEW_PENDING → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      ...TO_REVIEW_ACTIVE, "tr.review.host-unavailable", "tr.pause.retry-host-review",
      "tr.review.begin", "tr.reviewer.create", "tr.review.submit", ...ACCEPT_TO_DONE
    ]
  }),
  userApproval: scenario({
    id: "userApproval", category: "暂停与恢复", name: "修复越界，用户批准新 Revision", shortName: "USER APPROVAL",
    description: "无法证明 LEADER_REPAIR 安全时保存 draft，用户确认后回到 PREPARING。",
    outcome: "PAUSED → REVISION 2 → COMPLETED", tone: "amber", repairRounds: 1,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.request-repair", "tr.repair.prepare-draft",
      "tr.repair.require-user-approval", "tr.pause.approve-new-revision",
      ...FROM_PREPARING_TO_DECISION_RESUME, ...ACCEPT_TO_DONE
    ]
  }),
  noProgress: scenario({
    id: "noProgress", category: "安全出口", name: "修复无进展后取消", shortName: "NO PROGRESS",
    description: "blocker 未严格缩小且相关路径无变化，计数达到 15 后暂停。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 1,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.request-repair", "tr.repair.no-progress", ...CANCEL
    ]
  }),
  invalidReview: scenario({
    id: "invalidReview", category: "安全出口", name: "无可执行 blocker 的 Review", shortName: "INVALID REVIEW",
    description: "Review 未通过但无法安全构造 repairItems，立即暂停而不是猜测。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [...TO_DECISION_CREATE, "tr.review.invalid", ...CANCEL]
  }),
  workerEmpty: scenario({
    id: "workerEmpty", category: "Worker 分支", name: "空 Candidate 自动修复", shortName: "EMPTY CANDIDATE",
    description: "Worker 没有改动且不允许 no-change，生成 typed finding 并创建下一 Revision。",
    outcome: "FIXING → REVISION 2 → COMPLETED", tone: "amber", repairRounds: 0,
    transitionPath: [
      "tr.execute.create-run", "tr.pipeline.materialize", "tr.pipeline.start-worker",
      "tr.worker.empty-candidate", "tr.repair.prepare-draft", "tr.repair.create-scoped-revision",
      ...FROM_PREPARING_TO_DECISION_CREATE, ...ACCEPT_TO_DONE
    ]
  }),
  workerFailure: scenario({
    id: "workerFailure", category: "Worker 分支", name: "Worker timeout 后取消", shortName: "WORKER PAUSE",
    description: "Attempt 或 containment 无法安全继续，持久化证据后进入 PAUSED。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [
      "tr.execute.create-run", "tr.pipeline.materialize", "tr.pipeline.start-worker",
      "tr.worker.failure-pause", ...CANCEL
    ]
  }),
  providerUnavailable: scenario({
    id: "providerUnavailable", category: "Worker 分支", name: "Provider Probe 不通过", shortName: "PROVIDER PAUSE",
    description: "能力未证明前不启动 Worker，进入 typed pause。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: ["tr.execute.create-run", "tr.pipeline.provider-unavailable", ...CANCEL]
  }),
  publishConflict: scenario({
    id: "publishConflict", category: "Publish 分支", name: "全路径预检冲突", shortName: "0 WRITE CONFLICT",
    description: "Review 后原项目变化，第一笔 SmartFlow 写入前以 publishedCount=0 暂停。",
    outcome: "PAUSED · 0 FILES CHANGED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.accept", "tr.publish.start",
      "tr.publish.precheck-conflict", ...CANCEL
    ]
  }),
  publishBlocked: scenario({
    id: "publishBlocked", category: "Publish 分支", name: "Publish PARTIAL / UNKNOWN", shortName: "RECOVERY BLOCKED",
    description: "Apply 后无法证明完整结果，保留 operationId 并暂停。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.accept", "tr.publish.start", "tr.publish.preflight-ok",
      "tr.publish.recovery-blocked", ...CANCEL
    ]
  }),
  workerRecovery: scenario({
    id: "workerRecovery", category: "重启恢复", name: "RUNNING 重启后开新 Attempt", shortName: "WORKER RECOVERY",
    description: "旧进程已停止，同一 Revision 回 PREPARING 并启动新 generation。",
    outcome: "RUNNING → PREPARING → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      "tr.execute.create-run", "tr.pipeline.materialize", "tr.pipeline.start-worker",
      "tr.recovery.enter-worker", "tr.recovery.worker-stopped",
      ...FROM_PREPARING_TO_DECISION_CREATE, ...ACCEPT_TO_DONE
    ]
  }),
  workerUnknown: scenario({
    id: "workerUnknown", category: "重启恢复", name: "旧 Worker 身份不明", shortName: "PROCESS UNKNOWN",
    description: "无法证明旧进程停止时禁止新 Attempt，并进入人工检查。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [
      "tr.execute.create-run", "tr.pipeline.materialize", "tr.pipeline.start-worker",
      "tr.recovery.enter-worker", "tr.recovery.worker-unknown", ...CANCEL
    ]
  }),
  reviewRecovery: scenario({
    id: "reviewRecovery", category: "重启恢复", name: "REVIEWING 重启后继续等待", shortName: "REVIEW RECOVERY",
    description: "恢复相同 HostTurn、deadline 与 Reviewer identity，不重复创建 Review。",
    outcome: "REVIEWING → REVIEWING → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      ...TO_REVIEW_ACTIVE, "tr.recovery.enter-review", "tr.recovery.review-wait",
      "tr.reviewer.create", "tr.review.submit", ...ACCEPT_TO_DONE
    ]
  }),
  publishRecovery: scenario({
    id: "publishRecovery", category: "重启恢复", name: "Publish 响应丢失但已提交", shortName: "PUBLISH RECOVERY",
    description: "查询稳定 operationId，确认 COMMITTED 后进入 COMPLETED。",
    outcome: "PUBLISHING → RECONCILE → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.accept", "tr.publish.start", "tr.publish.preflight-ok",
      "tr.recovery.enter-publish", "tr.recovery.publish-committed", "tr.turn.done"
    ]
  }),
  publishRecoveryConflict: scenario({
    id: "publishRecoveryConflict", category: "重启恢复", name: "Publish 对账为冲突", shortName: "RECOVERY CONFLICT",
    description: "operationId 对账不能证明完整提交，进入 typed pause。",
    outcome: "PAUSED → CANCELED", tone: "red", repairRounds: 0,
    transitionPath: [
      ...TO_DECISION_CREATE, "tr.review.accept", "tr.publish.start", "tr.publish.preflight-ok",
      "tr.recovery.enter-publish", "tr.recovery.publish-conflict", ...CANCEL
    ]
  }),
  preparingRecovery: scenario({
    id: "preparingRecovery", category: "重启恢复", name: "PREPARING 重启重调度", shortName: "PREP RECOVERY",
    description: "同一 Revision 推进 fence 并重新调度 pipeline。",
    outcome: "PREPARING → PREPARING → COMPLETED", tone: "violet", repairRounds: 0,
    transitionPath: [
      "tr.execute.create-run", "tr.recovery.enter-preparing", "tr.recovery.resume-preparing",
      ...FROM_PREPARING_TO_DECISION_CREATE, ...ACCEPT_TO_DONE
    ]
  }),
  executeRejected: scenario({
    id: "executeRejected", category: "创建前拒绝", name: "execute 前任务源漂移", shortName: "NO RUN",
    description: "批准后任务字节变化，不创建 jobId，也不存在可恢复 Run。",
    outcome: "REJECTED · NO RUN CREATED", tone: "red", repairRounds: 0,
    transitionPath: ["tr.execute.reject-source-drift"]
  })
});

export const PUBLIC_TOOLS = Object.freeze([
  { id: "execute", name: "smartflow_execute", role: "创建 Run", direction: "Host → Daemon", description: "验证批准源并原子创建 Revision 1。" },
  { id: "review-turn", name: "smartflow_review_turn*", role: "唯一评审主循环", direction: "Host ↔ Daemon", description: "返回 NOT_READY、REVIEW_REQUIRED、USER_INPUT_REQUIRED 或 DONE。" },
  { id: "status", name: "smartflow_status", role: "只读状态", direction: "Host ← Daemon", description: "读取 phase、revision 与进度，不推进状态。" },
  { id: "resume", name: "smartflow_resume", role: "独立恢复", direction: "Host → Daemon", description: "恢复没有活动 composite HostTurn 的 PAUSED Run。" },
  { id: "cancel", name: "smartflow_cancel", role: "取消", direction: "Host → Daemon", description: "进入 CANCELING 并核销活动身份。" },
  { id: "result", name: "smartflow_result", role: "只读结果", direction: "Host ← Daemon", description: "投影 durable artifacts、结果和 next actions。" }
]);

export const OWNERSHIP = Object.freeze([
  { object: "Approved task bytes", owner: "Host → TaskSource Artifact", rule: "SHA-256 绑定用户真正批准的字节" },
  { object: "Run state", owner: "Daemon / StateStore", rule: "schema v5 · CAS · fence · request receipts" },
  { object: "Worker workspace", owner: "Daemon", rule: "Pi 只能写当前 Run 的私有 sandbox" },
  { object: "Candidate", owner: "StateStore Artifacts", rule: "始终是 Run baseline → 当前 result 的累计差异" },
  { object: "Reviewer session", owner: "Host", rule: "首轮 CREATE；修复轮 RESUME 唯一绑定" },
  { object: "Original project writes", owner: "Publish Adapter", rule: "全路径 preflight 后按 operationId 应用和对账" }
]);

export const INVARIANTS = Object.freeze([
  "当前 durable 主线是 PREPARING → RUNNING → REVIEW_PENDING → REVIEWING → READY_TO_PUBLISH → PUBLISHING → COMPLETED。",
  "Review finalize 在一次 mutation 中直接进入发布、FIXING 或 PAUSED；CLAIMING 与 LEADER_DECISION 不是现行主干 checkpoint。",
  "自动 repair 的回边固定指向 PREPARING(revision N+1)；安全 repair 不经过 REPAIR_TASKS_READY pause。",
  "每个 Revision 使用新的 Worker Attempt；修复轮必须 RESUME 同一个 Reviewer session。",
  "autoRepairRounds 与 noProgressCount 都有 15 的安全边界，但含义不同。",
  "任何 Publish PARTIAL/UNKNOWN 都不是成功；只有完整 COMMITTED 证据才能进入 COMPLETED。",
  "DONE 是 ReviewTurnOutput.kind，不是 RunPhase；FAILED 虽在 schema 中定义，但当前普通 production 路径未定位主动 producer。"
]);

export const FLOW = Object.freeze({
  meta: FLOW_META,
  actors: ACTORS,
  stages: STAGES,
  transitions: TRANSITIONS,
  scenarios: SCENARIOS,
  dataDetails: DATA_DETAILS
});
