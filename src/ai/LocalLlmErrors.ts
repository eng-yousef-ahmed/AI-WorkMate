import { StorageError } from "../storage/errors";

export type LocalLlmErrorCode =
  | "ANALYSIS_ENGINE_UNAVAILABLE"
  | "ANALYSIS_ENGINE_TIMEOUT"
  | "ANALYSIS_ENGINE_CRASHED"
  | "ANALYSIS_ENGINE_INVALID_OUTPUT"
  | "ANALYSIS_CANCELLED"
  | "ANALYSIS_PATH_REJECTED"
  | "ANALYSIS_ENGINE_FAILED";

export class LocalLlmError extends StorageError {
  public readonly code: LocalLlmErrorCode;
  public readonly retryable: boolean;

  public constructor(code: LocalLlmErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalLlmError";
    this.code = code;
    this.retryable = retryable;
  }
}
