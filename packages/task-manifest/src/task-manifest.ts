import { TaskManifestError } from "./errors.js";
import { canonicalStringify, hashCanonical, sha256Bytes } from "./canonicalize.js";
import {
  parseTasksDocument,
  selectEnabledTasks,
  type ParsedTask
} from "./tasks-parser.js";
import {
  taskManifestSchema,
  type ManifestTask,
  type TaskManifest
} from "./schema.js";
import { validateTaskSelection } from "./validator.js";

export interface ManifestApproval {
  kind: "USER" | "LEADER_REPAIR";
  approvedAt: string;
  parentRevision: number | null;
  authorizedCriterionIds: string[];
}

export interface CompileTaskManifestOptions {
  projectId: string;
  jobId: string;
  revision: number;
  canonicalTaskPath: string;
  providerRuntimeConfig: unknown;
  allowNoChange?: boolean;
  approval: ManifestApproval;
}

export interface CompiledTaskManifest {
  manifest: TaskManifest;
  manifestHash: string;
  artifactBytes: Uint8Array;
}

function providerRuntimeConfigHash(input: unknown): string {
  return hashCanonical(input);
}

function toManifestTask(task: ParsedTask): ManifestTask {
  return {
    id: task.id,
    module: task.module,
    parallel: task.parallel,
    description: task.description,
    filePaths: task.filePaths,
    acceptanceCriteria: task.acceptanceCriteria
  };
}

export function compileTaskManifest(
  source: string | Uint8Array,
  options: CompileTaskManifestOptions
): CompiledTaskManifest {
  if (options.providerRuntimeConfig === undefined) {
    throw new TaskManifestError(
      "PROVIDER_RUNTIME_CONFIG_MISSING",
      "A frozen provider runtime configuration is required"
    );
  }
  const document = parseTasksDocument(source);
  if (options.canonicalTaskPath.trim().length === 0) {
    throw new TaskManifestError("TASKS_PATH_INVALID", "A canonical task path is required");
  }
  const enabledTasks = selectEnabledTasks(document);
  const allowNoChange = options.allowNoChange ?? false;
  const issues = validateTaskSelection(enabledTasks, allowNoChange);
  const firstIssue = issues[0];
  if (firstIssue !== undefined) throw new TaskManifestError(firstIssue.code, firstIssue.message);

  const tasks = enabledTasks.map((task) => toManifestTask(task));
  const enabledTaskIds = tasks.map((task) => task.id);
  const tasksHash = hashCanonical({
    enabledTaskIds,
    allowNoChange,
    tasks
  });
  const frozenProviderRuntimeConfigHash = providerRuntimeConfigHash(options.providerRuntimeConfig);
  const sourceHash = sha256Bytes(document.sourceBytes);
  const manifest = taskManifestSchema.parse({
    schemaVersion: 3,
    projectId: options.projectId,
    jobId: options.jobId,
    runId: options.jobId,
    revision: options.revision,
    revisionId: `${options.jobId}:revision-${String(options.revision)}`,
    canonicalTaskPath: options.canonicalTaskPath,
    taskSourceArtifact: {
      relativePath: `runs/${options.jobId}/revision-${String(options.revision)}/task-source.md`,
      sha256: sourceHash,
      size: document.sourceBytes.byteLength
    },
    sourceHash,
    tasksSha256: sourceHash,
    tasksHash,
    allowNoChange,
    providerRuntimeConfigHash: frozenProviderRuntimeConfigHash,
    enabledTaskIds,
    tasks,
    approval: options.approval
  });
  const serialized = canonicalStringify(manifest);
  const artifactBytes = Buffer.from(serialized, "utf8");
  return {
    manifest,
    manifestHash: sha256Bytes(artifactBytes),
    artifactBytes
  };
}
