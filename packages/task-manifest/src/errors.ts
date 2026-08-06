export type TaskManifestErrorCode =
  | "NO_CHANGE_ALLOWANCE_UNBOUND"
  | "PROVIDER_RUNTIME_CONFIG_MISSING"
  | "TARGET_PATH_MISSING"
  | "TASKS_EMPTY"
  | "TASKS_METADATA_UNSUPPORTED"
  | "TASKS_PATH_INVALID"
  | "TASK_ACCEPTANCE_MISSING"
  | "TASK_FORMAT_INVALID"
  | "TASK_ID_DUPLICATE"
  | "TASK_ID_MISSING"
  | "TASK_MODULE_MISMATCH"
  | "TASK_TAG_INVALID";

export class TaskManifestError extends Error {
  public readonly code: TaskManifestErrorCode;

  public constructor(code: TaskManifestErrorCode, message: string) {
    super(message);
    this.name = "TaskManifestError";
    this.code = code;
  }
}
