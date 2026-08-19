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
    objectName: "Approved task source",
    category: "message-input",
    producer: "Host",
    consumer: "smartflow_execute / ProjectRuntime",
    summary: "用户明确批准的任务路径及其 SHA-256 内容绑定。",
    purpose: "把授权固定到内容而不是文件名，防止批准后任务被替换。",
    transformation: "Host 批准的任务字节 → SHA-256 → approvedSourceHash；Daemon 重新读取并比较",
    lifecycle: "Host 在 execute 前提供这两个输入；Run 创建后任务源保存为 TaskSource Artifact。",
    fields: [
      field("tasksPath", "string", true, "specs/001-smartflow-mvp/tasks.md", "被批准任务源的项目内路径。"),
      field("approvedSourceHash", "sha256", true, "sha256:9c72…e41b", "只授权与该摘要完全相同的字节。")
    ],
    sources: [
      "packages/protocol/src/schema/mcp-tools.ts#executeInputSchema",
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
    summary: "schema v6 的持久化运行真相，记录 phase、revision、attempt、review、repair 与 publish。",
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
    summary: "原项目基线或某一 Revision 的不可变输入/结果快照，以及其私有可写物化目录。",
    purpose: "让 Worker 只修改隔离副本，并让 Publish 绑定当前 revision 的 immutable REVISION_RESULT snapshot。",
    transformation: "受控 Git 树与 object store → snapshot Artifact → Daemon 私有 worktree 或 Publish source",
    lifecycle: "快照作为 Artifact 保留；runtime worktree 与 run Git object store 可在终态后清理。",
    fields: [
      field("snapshotKind", "enum", true, "REVISION_RESULT", "区分 RUN_BASELINE、REVISION_INPUT 与 Publish 必须绑定的 REVISION_RESULT。"),
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

  "data.candidate.artifact": detail("data.candidate.artifact", {
    objectName: "GitCandidateV3",
    category: "artifact",
    producer: "WorkerRunner.captureCandidate",
    consumer: "Reviewer / ReviewCoordinator / PublishCoordinator",
    summary: "从 Run 初始基线到当前 Revision 结果的精简、累计、不可变候选。",
    purpose: "确保复审与发布看到同一完整结果，并以 resultSnapshotHash 绑定当前 revision 的不可变结果快照。",
    transformation: "baseline/input/result snapshot hashes + cumulative operations → candidateHash",
    lifecycle: "每个 Revision 冻结新 Candidate；Publish 直接校验并转换其操作，当前证据链由 Candidate、snapshot 与 Git objects 构成。",
    fields: [
      field("schemaVersion", "literal 3", true, "3", "当前最小 Candidate 格式；读取仍兼容旧 v2。"),
      field("revision", "positive integer", true, "2", "Candidate 所属 Revision，必须等于 REVISION_RESULT revision。"),
      field("runBaselineSnapshotHash", "sha256", true, "sha256:81c0…", "绑定 Run 初始基线。"),
      field("inputSnapshotHash", "sha256", true, "sha256:18b2…", "绑定本 Revision 的输入。"),
      field("resultSnapshotHash", "sha256", true, "sha256:53ad…", "必须精确匹配 immutable REVISION_RESULT snapshotHash。"),
      field("operations[]", "path operation[]", true, "MODIFY src/app.ts", "从 baseline 到 result 的累计内容哈希与 mode 操作。"),
      field("candidateHash", "sha256", true, "sha256:92af…", "以上规范化字段的内容身份。")
    ],
    sources: [
      "apps/daemon/src/worker-runner.ts#WorkerRunner.captureCandidate",
      "packages/workspace/src/candidate-builder.ts#buildGitCandidate",
      "apps/daemon/src/git-publish-source.ts#gitPublishOperations"
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
    objectName: "Review continuation envelope",
    category: "message",
    producer: "Independent Reviewer through Host",
    consumer: "ReviewCoordinator.finalizeReview",
    summary: "Host 用 reviewerSessionId 提交严格 ReviewResult；ReviewResult 本身只包含 tasks。",
    purpose: "让每个未完成 Task 直接携带可修复问题，避免顶层关联字段和 Issue 身份。",
    transformation: "parse continuation envelope + strict ReviewResult { tasks } + exact enabled Task coverage → evaluateReviewGate",
    lifecycle: "合法提交写为 hash-bound Review Artifact，并追加 reviewHistory；非法提交不产生 durable 写入。",
    fields: [
      field("reviewerSessionId", "identifier", true, "reviewer-session-r9", "Continuation envelope 字段；必须符合 CREATE/RESUME 绑定规则。"),
      field("result", "ReviewResult", true, "{ tasks: [...] }", "严格结果对象，除 tasks 外不接受其他字段。"),
      field("result.tasks[].id", "Task identifier", true, "T001", "每个启用 Task 恰好出现一次。"),
      field("result.tasks[].completionPercentage", "0..100 integer", true, "75", "该 Task 的完成度；100 必须没有 issue。"),
      field("result.tasks[].issues[]", "ReviewIssue[]", true, "[{ path, message }]", "未完成 Task 至少一个；完成 Task 必须为空。"),
      field("result.tasks[].issues[].path", "path string with limited lexical checks", true, "src/app.ts", "trim 后必须非空；拒绝前导 `/`、反斜杠及空/`.`/`..` segment，但不另行识别 drive-qualified 形式，也不验证存在性、文件/目录类型或 symlink。"),
      field("result.tasks[].issues[].message", "string", true, "renderApp 在空输入时返回错误状态", "Reviewer prompt 要求描述具体函数或行为、触发条件与影响；schema 只校验非空。"),
      field("result.tasks[].issues[].suggestedFix", "string", false, "补充空输入分支", "可选修复建议，不作为 Issue 身份。")
    ],
    sources: [
      "packages/protocol/src/schema/run-state.ts#reviewResultSchema",
      "packages/protocol/src/schema/mcp-tools.ts#reviewTurnInputSchema",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.finalizeReview"
    ]
  }),

  "data.review.artifact": detail("data.review.artifact", {
    objectName: "DurableReviewDecisionV2",
    category: "artifact",
    producer: "ReviewCoordinator",
    consumer: "deterministic policy / PublishCoordinator / RepairCoordinator",
    summary: "保存 Review gate、完整 ReviewResult 和 Candidate、Task、session provenance。",
    purpose: "把 Reviewer 证据绑定到 revision 与 Candidate，并通过 reviewHash 供独立 Leader artifact 引用。",
    transformation: "validated continuation → strict v2 Review artifact",
    lifecycle: "写入后不可变；恢复、发布和修复均重新 strict parse 并校验 hash binding。",
    fields: [
      field("schemaVersion", "literal 2", true, "2", "strict parser 拒绝 v1 或未知字段。"),
      field("revision", "positive integer", true, "2", "绑定当前批准 Revision。"),
      field("claimId", "identifier", true, "turn-review-r2", "等于当前 Review turnToken，绑定本次 continuation。"),
      field("reviewAttemptId", "identifier", true, "review-attempt-r2", "绑定本轮 Review attempt。"),
      field("taskSourceHash", "unprefixed sha256", true, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "绑定批准任务源。"),
      field("candidateHash", "unprefixed sha256", true, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "绑定被检查的 Candidate。"),
      field("reviewerSessionId", "identifier", true, "reviewer-session-r9", "绑定独立 Reviewer session。"),
      field("piSessionId", "identifier", true, "pi-session-r2", "记录产生 Candidate 的 Pi session。"),
      field("gate", "DurableReviewGate", true, "{ accepted, allowedLeaderDecisions, result: { tasks: [...] } }", "保存固定 gate 输出及唯一 ReviewResult。"),
      field("reviewHash", "unprefixed sha256", true, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "Review artifact canonical body 的内容身份。")
    ],
    sources: [
      "packages/protocol/src/schema/run-state.ts#durableReviewDecisionSchema",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.finalizeReview"
    ]
  }),

  "data.review.decision": detail("data.review.decision", {
    objectName: "DurableLeaderDecisionV2",
    category: "artifact",
    producer: "deterministic policy",
    consumer: "PublishCoordinator or RepairCoordinator",
    summary: "通过 reviewHash 引用 Review 证据，并保存 accept、repair 或 pause 的确定性决策。",
    purpose: "只有全部 Task 都为 100% 才发布；任一嵌套 issue 都进入整组自动修复。",
    transformation: "Review gate + repair counter → accept | repair | pause",
    lifecycle: "写入后不可变；finalize mutation 依据该决策直接进入下一 phase。",
    fields: [
      field("schemaVersion", "literal 2", true, "2", "strict parser 拒绝旧 Leader Artifact。"),
      field("revision", "positive integer", true, "2", "绑定被决策的 Revision。"),
      field("reviewHash", "unprefixed sha256", true, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "引用独立 DurableReviewDecisionV2。"),
      field("decision", "accept | repair | pause", true, "repair", "冻结策略输出；repair 自动覆盖全部 issues。"),
      field("reason", "string", true, "Reviewer reported incomplete approved tasks", "解释策略为何选择该出口。"),
      field("decidedAt", "ISO datetime", true, "2026-08-12T10:15:00Z", "记录机械决策时间。"),
      field("decisionHash", "unprefixed sha256", true, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "Leader artifact canonical body 的内容身份。")
    ],
    sources: [
      "packages/protocol/src/schema/run-state.ts#durableLeaderDecisionSchema",
      "packages/review/src/review-decision.ts#planReviewDecision",
      "apps/daemon/src/review-coordinator.ts#ReviewCoordinator.finalizeReview"
    ]
  }),

  "data.repair.round": detail("data.repair.round", {
    objectName: "RepairRound",
    category: "derived-state",
    producer: "RepairCoordinator",
    consumer: "repair progress policy / manifest compiler",
    summary: "保存本轮稳定失败范围、逐 Task issues 与相关 Candidate 路径哈希。",
    purpose: "处理 Review 中全部 issues，并在不依赖 message 或 Issue ID 的情况下防止无限循环。",
    transformation: "tasks[].issues[] + Candidate operation hashes → RepairRound",
    lifecycle: "作为 run.recovery.repairRound 持久化；Run 的 noProgressCount 与 RepairAssessment 的 authorizedCriterionIds 位于该对象之外。",
    fields: [
      field("failureIds[]", "string[]", true, "['candidate:EMPTY']", "保存非 Review 来源的稳定失败范围。"),
      field("tasks[]", "TaskReview[]", true, "[{ id: 'T001', completionPercentage: 75, issues: [...] }]", "保存当前 Review 的完整嵌套问题。"),
      field("relevantPathHashes", "record<string, sha256 | 'DELETED'>", true, "src/app.ts → sha256:…", "来自 Candidate operations 的 newEntry.sha256 或 DELETED。")
    ],
    sources: [
      "packages/review/src/repair-loop.ts#RepairRound",
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
    summary: "无法安全自动推进时的明确原因、证据、允许动作，以及发布暂停所需的受控 Candidate worktree 路径。",
    purpose: "未知、冲突、越界或额度耗尽不会被猜成成功；人工发布也只能在 owning Host 的合法 continuation 中确认。",
    transformation: "typed failure → PAUSED + code + resumeActions + optional HostTurn/worktreePath",
    lifecycle: "用户选择合法恢复动作、取消，或恢复条件被证明后清除；检查动作只读。",
    fields: [
      field("code", "pause code", true, "PUBLISH_PRECHECK_CONFLICT", "机器可判定的暂停原因。"),
      field("message", "string", true, "Publishing requires user attention", "供用户理解的具体上下文。"),
      field("resumeActions[]", "action[]", true, "['retry_publish', 'confirm_manual_publish', 'cancel']", "当前状态唯一允许的可变动作。"),
      field("worktreePath", "absolute path", false, "/daemon-data/.../workspaces/r2", "仅发布相关 USER_INPUT_REQUIRED 可向 owning Host 披露的已审核 Candidate worktree；不是原项目或 StateStore 路径。"),
      field("hostTurn.stage", "AWAITING_USER_INPUT", false, "AWAITING_USER_INPUT", "composite review turn 拥有该暂停时的 continuation。"),
      field("result.publishPrecheck", "precheck projection", false, "{ publishedCount: 0, conflicts: [...] }", "让 Host 检查零写入冲突或人工确认不匹配事实。")
    ],
    sources: [
      "apps/daemon/src/host-turn-coordinator.ts#HostTurnCoordinator.userInputRequired",
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.result",
      "packages/state-store/src/schema.ts#pauseRecordSchema"
    ]
  }),

  "data.publish.operations-attempt": detail("data.publish.operations-attempt", {
    objectName: "ApplyOperation[] / PublishAttemptRecord",
    category: "derived-and-durable-state",
    producer: "gitPublishOperations + PublishService",
    consumer: "WorkspaceApplyAdapter / Publish recovery",
    summary: "由绑定 Candidate、immutable REVISION_RESULT snapshot 与 Run Git object store 确定性派生的发布操作和持久化尝试身份。",
    purpose: "用 expected-old CAS 保护每条路径，并让正常发布与恢复重建完全相同的操作、operationId 和 blob 内容。",
    transformation: "Candidate + REVISION_RESULT entries + Git blobs → ApplyOperation[] → operationsHash + stable operationId → PublishAttemptRecord",
    lifecycle: "操作可由不可变证据重建；PREPARED/SUBMITTED/结果 journal 持久化，Git blobRef 在终态清理前保持可读。",
    fields: [
      field("operations[].expectedOldKind", "ABSENT | FILE", true, "FILE", "区分创建与替换/删除的 CAS 前置状态。"),
      field("operations[].expectedOldHash", "sha256 | null", true, "sha256:old…", "全路径 preflight 的旧内容条件。"),
      field("operations[].expectedOldMode", "file mode | null", true, "420", "同时保护可执行位等 mode；数值 420 对应 0644。"),
      field("operations[].newHash", "sha256 | null", true, "sha256:new…", "目标内容；删除操作为 null。"),
      field("operations[].newMode", "file mode | null", true, "420", "目标 mode；删除操作为 null。"),
      field("operations[].blobRef", "ArtifactRef | null", true, "git-object-store/blobs/<blobId>", "新增/修改内容指向 Run Git object store，并在读取时校验 path、hash 与 size。"),
      field("operationsHash", "sha256", true, "sha256:770e…", "绑定完整有序操作集合。"),
      field("operationId", "identifier", true, "publish-f14c", "由 project/job/revision/Candidate/Review/operationsHash 稳定派生，连接 lease、apply、journal 与 recovery。"),
      field("status", "PREPARED | SUBMITTED | COMMITTED | CONFLICT | UNKNOWN", true, "PREPARED", "当前 durable 发布尝试状态。")
    ],
    sources: [
      "apps/daemon/src/git-publish-source.ts#gitPublishOperations",
      "apps/daemon/src/git-publish-source.ts#gitPublishBlobReader",
      "packages/publish/src/publish-service.ts#PublishService.publish",
      "apps/daemon/src/publish-coordinator.ts#StateStorePublishAttemptStore"
    ]
  }),

  "data.publish.precheck": detail("data.publish.precheck", {
    objectName: "PublishServiceResult.PRECHECK_CONFLICT / publishPrecheck",
    category: "derived-state",
    producer: "PublishService + PublishCoordinator",
    consumer: "Host / ProjectRuntime.result",
    summary: "第一笔 SmartFlow 写入前对全部 Candidate target paths 的冲突观察。",
    purpose: "证明冲突分支保持零写入，并给用户明确的路径事实用于重试或人工合并。",
    transformation: "ApplyOperation[] + original project observation → conflicts[] + 0/N projection",
    lifecycle: "PUBLISH_PRECHECK_CONFLICT 时写入 recovery.publishPrecheck；重试、成功或新的非冲突结果会清除。",
    fields: [
      field("status", "literal PRECHECK_CONFLICT", true, "PRECHECK_CONFLICT", "区分 apply 后的 PublishResult。"),
      field("conflicts[]", "PreflightConflict[]", true, "[{ path: 'src/app.ts', reason: 'HASH_MISMATCH' }]", "列出未满足 expected-old kind/hash/mode 的所有路径。"),
      field("publishedCount", "literal 0", true, "0", "确认没有 Candidate operation 被 SmartFlow 应用。"),
      field("totalCount", "non-negative integer", true, "7", "本次派生操作总数。"),
      field("activeWorkspaceChanged", "literal false", true, "false", "明确原项目未被该 SmartFlow publish 尝试改变。")
    ],
    sources: [
      "packages/publish/src/publish-service.ts#PublishService.publish",
      "apps/daemon/src/publish-coordinator.ts#PublishCoordinator.publish",
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.result"
    ]
  }),

  "data.publish.result": detail("data.publish.result", {
    objectName: "PublishResult / publishOutcome",
    category: "side-effect-receipt",
    producer: "Workspace apply adapter or manual target observation",
    consumer: "PublishService / PublishCoordinator / Host",
    summary: "与稳定操作身份绑定的逐路径最终观察回执。",
    purpose: "只有路径集合、status、hash 与 mode 全部精确匹配派生操作，Run 才能进入 COMPLETED。",
    transformation: "operationId + operationsHash + path receipts → COMMITTED | CONFLICT | PARTIAL | UNKNOWN",
    lifecycle: "完整 COMMITTED 进入终态；CONFLICT/PARTIAL/UNKNOWN 或无法查询的结果保持 PUBLISH_RECOVERY_BLOCKED。",
    fields: [
      field("operationId", "identifier", true, "publish-f14c", "必须与 durable Attempt 和 adapter journal 一致。"),
      field("operationsHash", "sha256", true, "sha256:770e…", "必须与本次 ApplyOperation[] 一致。"),
      field("status", "COMMITTED | CONFLICT | PARTIAL | UNKNOWN", true, "COMMITTED", "adapter 的批次结果；只有完整 COMMITTED 可成功。"),
      field("paths[]", "path receipt[]", true, "[{ path: 'src/app.ts', status: 'COMMITTED', observedHash: 'sha256:new…', observedMode: 420 }]", "每个 expected operation 恰好一个回执，不得重复或缺失。"),
      field("paths[].status", "COMMITTED | CONFLICT | UNRESOLVED", true, "COMMITTED", "单路径是否可证明达到目标。"),
      field("paths[].observedHash", "sha256 | null", true, "sha256:new…", "必须等于 operation.newHash。"),
      field("paths[].observedMode", "file mode | null", true, "420", "必须等于 operation.newMode。")
    ],
    sources: [
      "packages/publish/src/publish-service.ts#PublishService.finish",
      "packages/publish/src/publish-service.ts#PublishService.observeRecovery",
      "apps/daemon/src/publish-coordinator.ts#PublishCoordinator.confirmManualPublish"
    ]
  }),

  "data.publish.manual-confirmation": detail("data.publish.manual-confirmation", {
    objectName: "ManualPublishConfirmation / target-state observation",
    category: "message-and-durable-state",
    producer: "Owning Host + ProjectRuntime.resume",
    consumer: "PublishCoordinator.confirmManualPublish",
    summary: "用户从已审核 worktree 人工合并到原项目后，请求 SmartFlow 只读确认所有 Candidate target operations。",
    purpose: "在 adapter 不可用或零写入 precheck conflict 后允许人工落地，但绝不把用户声明当作成功证据。",
    transformation: "USER_INPUT_REQUIRED worktreePath + external merge + confirm_manual_publish → observeTargetState → synthetic COMMITTED receipt or mismatch pause",
    lifecycle: "REQUESTED marker 绑定 revision 与原 pauseCode；匹配后清除并写 manual-confirmation-v1 result，不匹配则保存 MISMATCH/conflicts 后继续 PAUSED。",
    fields: [
      field("worktreePath", "absolute path", true, "/daemon-data/.../workspaces/r2", "owning Host 用于读取已审核 Candidate 的受控路径。"),
      field("action", "literal confirm_manual_publish", true, "confirm_manual_publish", "请求观察目标，不授权 SmartFlow 写入。"),
      field("marker.status", "REQUESTED | MISMATCH", true, "REQUESTED", "确认请求及最近一次不匹配结论。"),
      field("marker.revision", "positive integer", true, "2", "阻止旧 revision 的确认作用于新 Candidate。"),
      field("marker.pauseCode", "PUBLISH_ADAPTER_UNAVAILABLE | PUBLISH_PRECHECK_CONFLICT", true, "PUBLISH_PRECHECK_CONFLICT", "保留人工流程的合法来源，即使上一轮已是 target mismatch。"),
      field("observation.matches", "boolean", true, "true", "只有全部 target path 的 kind/hash/mode 精确匹配才为 true。"),
      field("publish.adapterId", "literal manual-confirmation-v1", false, "manual-confirmation-v1", "精确匹配后合成的 committed attempt 来源。")
    ],
    sources: [
      "apps/daemon/src/host-turn-coordinator.ts#HostTurnCoordinator.userInputRequired",
      "apps/daemon/src/project-runtime.ts#ProjectRuntime.resume",
      "apps/daemon/src/publish-coordinator.ts#PublishCoordinator.confirmManualPublish"
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
    summary: "Run 的规范化结果投影，以及终态时 review_turn 的 DONE 包装。",
    purpose: "区分 durable phase、公开 publishOutcome/publishPrecheck 与协议 output.kind=DONE，避免把暂停或不确定结果误画成成功。",
    transformation: "RunRecord + referenced artifacts + publish state → canonical ResultOutput → terminal { kind: DONE, result }",
    lifecycle: "可重复只读；PAUSED 时携带 nextActions，只有终态才由 review_turn 包装为 DONE。",
    fields: [
      field("kind", "literal DONE", false, "DONE", "仅终态 review_turn 输出具备；不是 RunPhase。"),
      field("result.phase", "RunPhase", true, "COMPLETED", "真正持久化的阶段。"),
      field("result.status", "result status", true, "COMMITTED", "区分 RUNNING、PRECHECK_CONFLICT、MANUAL_PUBLISH_REQUIRED、PUBLISH_RECOVERY_BLOCKED 与终态。"),
      field("result.artifacts[]", "ArtifactRef[]", true, "[taskSource, candidate, review]", "Run 实际引用的可审计 Artifact；publish attempt 是状态投影而非伪造 ArtifactRef。"),
      field("result.publishOutcome", "PublishAttemptRecord", false, "{ operationId, status: 'COMMITTED', result }", "公开 durable publish attempt 与逐路径回执。"),
      field("result.publishPrecheck", "precheck projection", false, "{ conflicts, publishedCount: 0, totalCount, activeWorkspaceChanged: false }", "公开零写入冲突或人工确认不匹配事实。"),
      field("result.nextActions[]", "action[]", true, "['confirm_manual_publish', 'retry_publish', 'cancel']", "暂停状态当前允许的动作；终态通常为空。")
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
