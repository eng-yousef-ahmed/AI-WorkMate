import type { Artifact } from "../domain/models";

export type CaptureSessionState = "RECORDING" | "FINALIZING" | "COMPLETED" | "INCOMPLETE" | "FAILED";

export interface CaptureErrorInfo {
  code: string;
  message: string;
}

export interface CaptureStartRequest {
  meetingId: string;
  format: string;
  mimeType: string;
  estimatedBytes?: number;
  startedAt?: string;
  captureSource?: string;
  diskMonitor?: {
    criticalFreeBytes: number;
    intervalMs?: number;
  };
}

export interface CaptureChunkRequest {
  captureId: string;
  meetingId: string;
  chunk: unknown;
  sequence?: number;
}

export interface CaptureStreamRequest {
  captureId: string;
  meetingId: string;
  stream: AsyncIterable<unknown> | Iterable<unknown>;
  startingSequence?: number;
}

export interface CaptureFinalizeRequest {
  captureId: string;
  meetingId: string;
  endedAt?: string;
}

export interface CaptureAbortRequest {
  captureId: string;
  meetingId: string;
  reason: string;
}

export interface CaptureFailRequest {
  captureId: string;
  meetingId: string;
  reason: string;
}

export interface CaptureStateSnapshot {
  captureId: string;
  meetingId: string;
  state: CaptureSessionState;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  bytesWritten: number;
  chunksWritten: number;
  format: string;
  mimeType: string;
  captureSource: string;
  relativePath?: string;
  sha256?: string;
  artifact?: Artifact;
  error?: CaptureErrorInfo;
}

export interface CaptureEngine {
  startCapture(request: CaptureStartRequest): Promise<CaptureStateSnapshot>;
  getCaptureState(captureId: string): CaptureStateSnapshot;
  appendChunk(request: CaptureChunkRequest): Promise<CaptureStateSnapshot>;
  appendStream(request: CaptureStreamRequest): Promise<CaptureStateSnapshot>;
  finalizeCapture(request: CaptureFinalizeRequest): Promise<CaptureStateSnapshot>;
  abortCapture(request: CaptureAbortRequest): Promise<CaptureStateSnapshot>;
  failCapture(request: CaptureFailRequest): Promise<CaptureStateSnapshot>;
}
