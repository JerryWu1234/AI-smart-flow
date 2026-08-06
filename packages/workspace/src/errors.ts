export type WorkspaceErrorCode =
  | "BASELINE_UNSTABLE"
  | "EXTERNAL_SYMLINK"
  | "GIT_COMMAND_FAILED"
  | "GIT_NESTED_REPOSITORY_UNSUPPORTED"
  | "GIT_REPOSITORY_REQUIRED"
  | "GIT_SUBMODULE_UNSUPPORTED"
  | "GIT_UNAVAILABLE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_TRAVERSAL"
  | "SPECIAL_FILE_REJECTED"
  | "SYMLINK_REJECTED"
  | "WORKSPACE_COPY_DRIFT";

export class WorkspaceError extends Error {
  public readonly code: WorkspaceErrorCode;

  public constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
