const field = (path, type, required, example, purpose) => Object.freeze({
  path,
  type,
  required,
  example,
  purpose
});

const detail = (id, definition) => Object.freeze({
  id,
  ...definition,
  fields: Object.freeze(definition.fields),
  sources: Object.freeze(definition.sources)
});

export const DATA_DETAILS = Object.freeze({
  "data.approval.snapshot": detail("data.approval.snapshot", {
    objectName: "ApprovedTasksSnapshot",
    category: "derived",
    producer: "Host",
    consumer: "smartflow_execute / ProjectRuntime",
    summary: "用户明确批准的任务原始字节及其 SHA-256 绑定。",
    purpose: "把授权固定到内容而不是文件名，防止批准后任务被替换。",
    transformation: "稳定读取的任务字节 → SHA-256 → approvedSourceHash",
    lifecycle: "execute 前存在于 Host；Run 创建后保存为 TaskSource Artifact。",
    fields: [
      field("tasksPath", "string", true, "specs/001-smartflow-mvp/tasks.md", "被批准任务源的项目内路径。"),
      field("sourceHash", "sha256", true, "sha256:9c72…e41b", "只授权与该摘要完全相同的字节。"),
      field("approvedAt", "ISO datetime", true, "2026-08-12T09:42:00Z", "记录用户批准发生的审计时间。")
    ],
    sources: [
      "apps/host-skill/src/approval.ts#readStableApprovedTasks",
      "apps/daemon/src/approved-source.ts#observeApprovedSource"
    ]
  }),

  "data.execute.input": detail("data.execute.input", {
    objectName: "ExecuteInput",
    category: "message",
    producer: "Host / MCP Gateway",
    consumer: "ProjectRuntime.execute",
    summary: "创建 Run 所需的公开协议输入。",
    purpose: "将项目、任务源、批准哈希和幂等请求绑定到一次可恢复执行。",
    transformation: "MCP schema parse → 路径规范化 → 批准源复算 → Run mutation",
    lifecycle: "请求本身短暂存在；requestId 回执会持久化以支持安全重试。",
    fields: [
      field("projectRoot", "absolute path", true, "/repo/AI-smart-flow", "限定项目身份与后续所有文件操作边界。"),
      field("tasksPath", "string", true, "specs/001-smartflow-mvp/tasks.md", "指向已批准任务源。"),
      field("approvedSourceHash", "sha256", true, "sha256:9c72…e41b", "必须与 Daemon 重新读取的字节一致。"),
      field("requestId", "identifier", true, "req-execute-001", "相同请求可重放但不会重复创建 Run。"),
      field("expectedStateVersion", "integer", false, "0", "可选 CAS 前置条件，防止覆盖并发状态。")
    ],
    sources: [
      "packages/protocol/src/schema/mcp-tools.ts#executeInputSchema",
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.execute"
    ]
  }),

  "data.run.record": detail("data.run.record", {
    objectName: "RunRecord / ProjectState",
    category: "durable-state",
    producer: "Daemon domain coordinators",
    consumer: "StateStore / recovery / status / result",
    summary: "schema v5 的持久化运行真相，记录 phase、revision、attempt、review、repair 与 publish。",
    purpose: "进程重启后不依赖内存猜测，所有推进都以 CAS 与 fence 为边界。",
    transformation: "domain mutation → expected stateVersion/fence 校验 → 原子替换 RunRecord",
    lifecycle: "从 PREPARING 创建，直到 COMPLETED、CANCELED 或 schema 定义的 FAILED 终态后仍保留证据。",
    fields: [
      field("phase", "RunPhase", true, "REVIEWING", "当前权威阶段。"),
      field("revision", "positive integer", true, "2", "当前已批准任务清单版本。"),
      field("stateVersion", "non-negative integer", true, "18", "每次成功 mutation 精确递增。"),
      field("fence", "positive integer", true, "2", "隔离旧 Daemon epoch 的迟到回调。"),
      field("autoRepairRounds", "non-negative integer", true, "1", "当前自动修复额度组已消费轮数。"),
      field("noProgressCount", "non-negative integer", true, "0", "连续无法证明进展的修复次数。")
    ],
    sources: [
      "packages/state-store/src/schema.ts#runRecordSchema",
      "packages/state-store/src/state-store.ts#StateStore"
    ]
  }),

  "data.workspace.snapshot": detail("data.workspace.snapshot", {
    objectName: "GitWorkspaceSnapshot / WorkspaceRef",
    category: "artifact",
    producer: "Workspace package / WorkerRunner",
    consumer: "Worker, Candidate builder, PublishCoordinator",
    summary: "原项目基线或上一 Revision 结果的内容寻址快照，以及其私有可写物化目录。",
    purpose: "让 Worker 只修改隔离副本，同时让每轮输入和最终累计差异可验证。",
    transformation: "受控 Git 树 → snapshot Artifact → Daemon 私有 worktree",
    lifecycle: "快照作为 Artifact 保留；runtime worktree 可在终态后清理。",
    fields: [
      field("snapshotKind", "enum", true, "RUN_BASELINE", "区分初始基线和 Revision 结果。"),
      field("treeId", "git object id", true, "18a4…", "目录树内容身份。"),
      field("snapshotHash", "sha256", true, "sha256:81c0…", "绑定规范化快照元数据。"),
      field("workspace.relativePath", "relative path", true, "workspaces/r2", "Daemon 数据目录下的私有工作区。"),
      field("workspace.sandboxId", "identifier", true, "sandbox-r2-b", "把目录与进程 containment 绑定。")
    ],
    sources: [
      "packages/workspace/src/git-snapshot.ts#captureGitSnapshot",
      "apps/daemon/src/worker-runner.ts#WorkerRunner.prepareWorkspace"
    ]
  }),

  "data.worker.attempt": detail("data.worker.attempt", {
    objectName: "WorkerStartInput / PiWorkerAttempt",
    category: "message-and-state",
    producer: "WorkerRunner",
    consumer: "Provider / Pi Worker / RecoveryManager",
    summary: "每个 Revision 的全新 Worker Attempt 及其 containment、session 和终态证据。",
    purpose: "隔离迟到事件，证明旧进程已停止，并禁止把 Worker 会话冒充 Reviewer。",
    transformation: "approved manifest + private workspace → WorkerStartInput → durable terminal attempt",
    lifecycle: "每轮创建新 attemptId；production recovery 可证明停止后会启动新 Attempt，不复用旧 Pi session。",
    fields: [
      field("attemptId", "identifier", true, "attempt-b77", "唯一执行尝试身份。"),
      field("revision", "positive integer", true, "2", "该 Attempt 实现的批准 Revision。"),
      field("generation", "non-negative integer", true, "1", "重试世代，用于拒绝旧事件。"),
      field("piSessionId", "identifier", false, "pi-session-82", "Worker Provider 会话身份。"),
      field("status", "enum", true, "COMPLETED", "STARTED 后的权威终态。"),
      field("processIdentity", "object", false, "{ pid: 48122, startToken: 'proc-91' }", "恢复时核对真实进程实例。")
    ],
    sources: [
      "packages/provider-core/src/worker-provider.ts#WorkerStartInput",
      "apps/daemon/src/worker-runner.ts#WorkerRunner",
      "apps/daemon/src/recovery-manager.ts#RecoveryManager.recoverWorker"
    ]
  }),

  "data.candidate.bundle": detail("data.candidate.bundle", {
    objectName: "Candidate",
    category: "artifact",
    producer: "WorkerRunner.captureCandidate",
    consumer: "Reviewer / ReviewCoordinator / PublishCoordinator",
    summary: "从 Run 初始基线到当前 Revision 结果的累计、不可变交付候选。",
    purpose: "确保复审与发布看到完整最终结果，而不是只看到本轮增量补丁。",
    transformation: "run baseline + current result snapshot → cumulative operations + evidence",
    lifecycle: "每个 Revision 冻结新 Candidate；旧 Candidate 留在 review history 证据链。",
    fields: [
      field("hash", "sha256", true, "sha256:92af…", "Candidate 规范化内容身份。"),
      field("revision", "positive integer", true, "2", "Candidate 所属 Revision。"),
      field("changedPaths[]", "string[]", true, "['src/app.ts']", "Reviewer 和 Publish 的受控路径集合。"),
      field("operations[]", "path operation[]", true, "MODIFY src/app.ts", "从 old blob/mode 到 new blob/mode 的精确操作。"),
      field("resultSnapshot", "ArtifactRef", true, "revision-2/result.json", "当前 Revision 的完整结果快照。")
    ],
    sources: [
      "apps/daemon/src/worker-runner.ts#WorkerRunner.captureCandidate",
      "packages/workspace/src/git-snapshot.ts"
    ]
  }),

  "data.review.host-action": detail("data.review.host-action", {
    objectName: "ReviewHostAction / HostTurn",
    category: "durable-state",
    producer: "WorkerRunner + ReviewCoordinator",
    consumer: "Host / independent Reviewer",
    summary: "把 Candidate、Reviewer 模式和 30 分钟 Host 回调窗口绑定到一次 Review。",
    purpose: "在披露 worktree 前原子进入 REVIEWING，并防止 stale Host 或错误 Reviewer 提交。",
    transformation: "REVIEW_PENDING action → beginReview atomic mutation → REVIEW_REQUIRED output",
    lifecycle: "Review 完成或暂停时清理/刷新；当前 hostTurn 只有 AWAITING_REVIEW 或 AWAITING_USER_INPUT。",
    fields: [
      field("turnToken", "identifier", true, "turn-review-r2", "Host continuation 与所有回答的绑定。"),
      field("reviewAttemptId", "identifier", true, "review-attempt-r2", "本轮评审身份。"),
      field("candidateHash", "sha256", true, "sha256:92af…", "锁定 Reviewer 必须检查的 Candidate。"),
      field("reviewerSession.mode", "CREATE | RESUME", true, "RESUME", "首轮创建，修复轮恢复同一 Reviewer。"),
      field("reviewerSessionId", "identifier", false, "reviewer-session-r9", "RESUME 时必须匹配历史唯一绑定。"),
      field("deadlineAt", "ISO datetime", true, "2026-08-12T10:12:00Z", "Host Reviewer 的 30 分钟回调截止时间。")
    ],
    sources: [
      "apps/daemon/src/host-turn-coordinator.ts#HostTurnCoordinator.beginReview",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.beginReview",
      "packages/state-store/src/schema.ts#hostTurnSchema"
    ]
  }),

  "data.review.submission": detail("data.review.submission", {
    objectName: "ReviewSubmission",
    category: "message",
    producer: "Independent Reviewer through Host",
    consumer: "ReviewCoordinator.finalizeReview",
    summary: "Reviewer 对 Manifest 中每个 Task 的完成度、结论和 finding。",
    purpose: "让完成判断可逐任务核验，而不是只提交一个模糊的通过/失败布尔值。",
    transformation: "Reviewer result → normalize every enabled task → evaluateReviewGate",
    lifecycle: "提交后写为 hash-bound Review Artifact，并追加 reviewHistory。",
    fields: [
      field("reviewerSessionId", "identifier", true, "reviewer-session-r9", "必须符合 CREATE/RESUME 绑定规则。"),
      field("result.tasks[]", "task score[]", true, "[{ taskId: 'T1', score: 100 }]", "每个启用 Task 恰好出现一次。"),
      field("result.completionPercentage", "0..100 integer", true, "100", "所有任务分数的四舍五入算术平均。"),
      field("result.verdict", "APPROVE | REQUEST_CHANGES", true, "APPROVE", "Reviewer 的整体结论。"),
      field("result.findings[]", "finding[]", true, "[]", "带路径、criterion 和 fingerprint 的具体问题。")
    ],
    sources: [
      "packages/protocol/src/schema/mcp-tools.ts#reviewTurnInputSchema",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.finalizeReview"
    ]
  }),

  "data.review.decision": detail("data.review.decision", {
    objectName: "DurableReviewDecision + DurableLeaderDecision",
    category: "artifact",
    producer: "ReviewCoordinator / deterministic policy",
    consumer: "PublishCoordinator or RepairCoordinator",
    summary: "Review 证据及 accept、repair、pause 的确定性决策，二者以 reviewHash 绑定。",
    purpose: "只有 APPROVE、100% 且无阻塞 finding 才发布；其它结果不能由 Host 随意改写。",
    transformation: "normalized review gate + repair counter → accept | repair | pause",
    lifecycle: "与 Candidate 和 Reviewer session 一起永久保存；当前 finalize mutation 直接进入下一 phase。",
    fields: [
      field("reviewHash", "sha256", true, "sha256:bc19…", "绑定任务、Candidate、Reviewer 和逐项结果。"),
      field("decision", "accept | repair | pause", true, "repair", "冻结策略输出。"),
      field("repairItems[]", "repair item[]", true, "[findingFingerprint]", "repair 时仅选择可证明的阻塞项。"),
      field("reason", "string", true, "2 blocking findings", "解释策略为何选择该出口。"),
      field("decisionHash", "sha256", true, "sha256:449a…", "LeaderDecision Artifact 的内容身份。")
    ],
    sources: [
      "packages/review/src/review-decision.ts#planReviewDecision",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.finalizeReview"
    ]
  }),

  "data.repair.round": detail("data.repair.round", {
    objectName: "RepairRound",
    category: "derived-state",
    producer: "RepairCoordinator",
    consumer: "repair progress policy / manifest compiler",
    summary: "本轮阻塞问题、相关路径哈希和进展判定。",
    purpose: "只修 Reviewer 指出的范围，并防止无进展的无限循环。",
    transformation: "selected finding fingerprints + Candidate path hashes → scoped repair tasks",
    lifecycle: "作为 recovery.repairRound 持久化；下一轮比较严格子集和真实路径变化。",
    fields: [
      field("findings[]", "normalized finding[]", true, "[P1 blocker]", "当前必须解决的阻塞集合。"),
      field("relevantPathHashes", "record<string, sha256>", true, "src/app.ts → sha256:…", "证明相关文件确实发生变化。"),
      field("noProgressCount", "non-negative integer", true, "0", "未严格缩小 blocker 或路径未变化时增加。"),
      field("authorizedCriterionIds[]", "string[]", true, "['T1']", "限制自动追加任务可触及的原验收标准。")
    ],
    sources: [
      "packages/review/src/repair-loop.ts#assessRepairProgress",
      "apps/daemon/src/repair-coordinator.ts#RepairCoordinator.prepare"
    ]
  }),

  "data.revision.manifest": detail("data.revision.manifest", {
    objectName: "Approved Revision / TaskManifest",
    category: "artifact",
    producer: "RepairCoordinator + createApprovedRevision",
    consumer: "next Worker Attempt",
    summary: "在原批准范围内追加修复任务后形成的 Revision N+1。",
    purpose: "把自动修复变成新的受约束任务版本，而不是给 Worker 无限自由。",
    transformation: "parent manifest + scoped repair tasks + approval envelope → new immutable manifest",
    lifecycle: "LEADER_REPAIR 可直接创建；无法证明范围安全时先 PAUSED 等待 USER approval。",
    fields: [
      field("revision", "positive integer", true, "2", "新批准版本号。"),
      field("sourceHash", "sha256", true, "sha256:41aa…", "追加修复任务后的完整任务源摘要。"),
      field("approval.kind", "LEADER_REPAIR | USER", true, "LEADER_REPAIR", "决定可自动继续还是必须让用户确认。"),
      field("approval.parentRevision", "positive integer", true, "1", "绑定被修复的父 Revision。"),
      field("inputSnapshot", "ArtifactRef", true, "revision-1/result.json", "下一 Worker 从上一轮结果继续，而不是重读原项目。")
    ],
    sources: [
      "apps/daemon/src/approved-revision.ts#createApprovedRevision",
      "apps/daemon/src/repair-coordinator.ts#RepairCoordinator.prepare",
      "packages/task-manifest/src/index.ts#compileTaskManifest"
    ]
  }),

  "data.pause.record": detail("data.pause.record", {
    objectName: "PauseRecord / UserInputRequired",
    category: "durable-state",
    producer: "Daemon boundary coordinators",
    consumer: "Host / smartflow_review_turn / smartflow_resume",
    summary: "无法安全自动推进时的明确原因、证据和允许动作。",
    purpose: "未知、冲突、越界或额度耗尽永远不会被猜成成功。",
    transformation: "typed failure → PAUSED + code + resumeActions + optional HostTurn",
    lifecycle: "用户选择合法恢复动作、取消，或恢复条件被证明后清除。",
    fields: [
      field("code", "pause code", true, "AUTOMATIC_REPAIR_LIMIT", "机器可判定的暂停原因。"),
      field("message", "string", true, "15 automatic repairs consumed", "供用户理解的具体上下文。"),
      field("resumeActions[]", "action[]", true, "['resume_review_decision', 'cancel']", "当前状态唯一允许的可变动作。"),
      field("hostTurn.stage", "AWAITING_USER_INPUT", false, "AWAITING_USER_INPUT", "composite review turn 拥有该暂停时的 continuation。"),
      field("lastError.artifacts[]", "ArtifactRef[]", false, "[publish-result.json]", "检查和恢复所需的证据引用。")
    ],
    sources: [
      "packages/state-store/src/schema.ts#pauseRecordSchema",
      "apps/daemon/src/host-turn-coordinator.ts#HostTurnCoordinator.requireUserInput"
    ]
  }),

  "data.publish.bundle": detail("data.publish.bundle", {
    objectName: "DeliveryBundle / ApplyOperation[] / PublishAttempt",
    category: "artifact-and-state",
    producer: "PublishCoordinator",
    consumer: "PublishService / workspace apply adapter",
    summary: "把已接受 Candidate 转换为带 expected-old 条件的全部文件操作。",
    purpose: "任何路径冲突都必须在第一笔写入前被发现，并支持响应丢失后的对账。",
    transformation: "accepted Candidate + Review + Decision → signed operations + stable operationId",
    lifecycle: "PREPARED → SUBMITTED → COMMITTED/CONFLICT/UNKNOWN；终态证据持续保存。",
    fields: [
      field("operationId", "identifier", true, "publish-f14c", "重试与恢复对账使用的稳定身份。"),
      field("operationsHash", "sha256", true, "sha256:770e…", "绑定完整有序操作集合。"),
      field("operations[].expectedOldHash", "sha256 | null", true, "sha256:old…", "全路径 preflight 的 CAS 前置内容。"),
      field("operations[].expectedOldMode", "file mode | null", true, "100644", "同时保护权限位。"),
      field("status", "publish status", true, "PREPARED", "当前 durable 发布阶段。")
    ],
    sources: [
      "apps/daemon/src/publish-coordinator.ts#PublishCoordinator.publish",
      "packages/publish/src/preflight.ts#preflightOperations",
      "packages/publish/src/publish-service.ts#PublishService.publish"
    ]
  }),

  "data.publish.result": detail("data.publish.result", {
    objectName: "PublishResult",
    category: "side-effect-receipt",
    producer: "Workspace apply adapter",
    consumer: "PublishService / RecoveryManager",
    summary: "逐路径写入或对账的最终回执。",
    purpose: "只有全部路径的 hash 与 mode 可证明匹配，Run 才能进入 COMPLETED。",
    transformation: "operationId + path receipts → COMMITTED | CONFLICT | PARTIAL | UNKNOWN",
    lifecycle: "COMMITTED 进入终态；CONFLICT/PARTIAL/UNKNOWN 进入 PAUSED 或 recovery reconcile。",
    fields: [
      field("status", "publish result status", true, "COMMITTED", "发布是否已被完全证明。"),
      field("operationId", "identifier", true, "publish-f14c", "必须与 durable Attempt 一致。"),
      field("publishedCount", "non-negative integer", true, "7", "成功验证的路径数；precheck conflict 必须为 0。"),
      field("paths[]", "path receipt[]", true, "[{ path: 'src/app.ts', status: 'APPLIED' }]", "逐路径最终 hash 与 mode 证据。"),
      field("conflicts[]", "conflict[]", false, "[]", "old hash/mode/absence 不匹配的路径。")
    ],
    sources: [
      "packages/publish/src/publish-service.ts#PublishService.finish",
      "apps/daemon/src/recovery-manager.ts#RecoveryManager.recoverPublish"
    ]
  }),

  "data.recovery.epoch": detail("data.recovery.epoch", {
    objectName: "Recovery epoch / reconciliation evidence",
    category: "durable-state",
    producer: "RecoveryManager",
    consumer: "ProjectRuntime scheduler / Host",
    summary: "Daemon 重启后按原 durable phase 对 Worker、Review 或 Publish 的未决身份进行对账。",
    purpose: "响应丢失不等于操作未提交；必须先查证，再重启、等待、完成或暂停。",
    transformation: "persisted phase + fence + external identity inspection → safe next phase",
    lifecycle: "每次 Daemon 所有权变更推进 fence；reconcile 结果回写 RunRecord。",
    fields: [
      field("projectFence", "positive integer", true, "2", "使旧 runtime callback 失效。"),
      field("detectedFromPhase", "RunPhase", true, "PUBLISHING", "决定应使用哪一种恢复策略。"),
      field("processIdentity", "object", false, "{ pid: 48122, startToken: 'proc-91' }", "Worker 恢复时证明进程是否仍是同一实例。"),
      field("operationId", "identifier", false, "publish-f14c", "Publish 恢复时查询而非盲目重放。"),
      field("outcome", "recovery outcome", true, "COMMITTED", "恢复后继续、完成或暂停的证据结论。")
    ],
    sources: [
      "apps/daemon/src/recovery-manager.ts#RecoveryManager.recover",
      "apps/daemon/src/runtime-composition.ts#ProductionRuntimeComposition.inspectWorker"
    ]
  }),

  "data.cancel.record": detail("data.cancel.record", {
    objectName: "CancellationRecord",
    category: "durable-state",
    producer: "ProjectRuntime / CancelManager",
    consumer: "Worker provider / Review / Publish recovery",
    summary: "取消请求及所有未决执行身份的核销证据。",
    purpose: "确保停止不是只改一个状态字段，而是确认 Worker、Review 和 Publish 不会继续产生副作用。",
    transformation: "authorized cancel → CANCELING → reconcile all identities → CANCELED",
    lifecycle: "CANCELED 后作为审计证据保留。",
    fields: [
      field("requestedAt", "ISO datetime", true, "2026-08-12T10:04:00Z", "取消开始时间。"),
      field("requestedBy", "Host identity", true, "host-turn-1", "证明拥有取消权限的调用者。"),
      field("workerStatus", "reconcile status", true, "STOPPED", "活动 Worker 是否已核销。"),
      field("publishStatus", "reconcile status", true, "NOT_SUBMITTED", "发布是否可能存在未决写入。"),
      field("completedAt", "ISO datetime", false, "2026-08-12T10:04:04Z", "全部核销完成后写入。")
    ],
    sources: [
      "apps/daemon/src/cancel-manager.ts#CancelManager",
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.cancel"
    ]
  }),

  "data.result.output": detail("data.result.output", {
    objectName: "ResultOutput / ReviewTurnOutput.DONE",
    category: "message",
    producer: "ProjectRuntime.result / HostTurnCoordinator.advance",
    consumer: "Host",
    summary: "终态 Run 的规范化结果，以及 review_turn 的 DONE 包装。",
    purpose: "区分 durable phase=COMPLETED 与协议 output.kind=DONE，避免把输出误画成新 RunPhase。",
    transformation: "terminal RunRecord + artifacts → canonical ResultOutput → { kind: DONE, result }",
    lifecycle: "可重复读取；不会再推进状态。",
    fields: [
      field("kind", "literal DONE", true, "DONE", "review_turn 的终态输出类型，不是 RunPhase。"),
      field("result.phase", "terminal RunPhase", true, "COMPLETED", "真正持久化的终态。"),
      field("result.revision", "positive integer", true, "2", "最终交付 Revision。"),
      field("result.artifacts[]", "ArtifactRef[]", true, "[candidate, review, publish]", "可审计的执行证据。"),
      field("result.nextActions[]", "action[]", true, "[]", "终态通常没有可变推进动作。")
    ],
    sources: [
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.result",
      "apps/daemon/src/host-turn-coordinator.ts#HostTurnCoordinator.advance",
      "packages/protocol/src/schema/mcp-tools.ts#reviewTurnOutputSchema"
    ]
  })
});

export function getDataDetail(id) {
  const result = DATA_DETAILS[id];
  if (result === undefined) throw new Error(`Unknown DataDetail id: ${id}`);
  return result;
}
