export type StateStoreErrorCode =
  | "ARTIFACT_HASH_MISMATCH"
  | "ARTIFACT_IMMUTABLE"
  | "ARTIFACT_OUTSIDE_DATA_DIR"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PROJECT_LOCKED"
  | "STALE_FENCE"
  | "STATE_INVALID"
  | "STATE_NOT_FOUND"
  | "STATE_VERSION_MISMATCH";

export class StateStoreError extends Error {
  public readonly code: StateStoreErrorCode;

  public constructor(code: StateStoreErrorCode, message: string) {
    super(message);
    this.name = "StateStoreError";
    this.code = code;
  }
}
