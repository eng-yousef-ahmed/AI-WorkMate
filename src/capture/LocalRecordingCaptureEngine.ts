import { createHash, randomUUID } from "node:crypto";

import type { Artifact } from "../domain/models";
import type { LocalFirstStore, RecordingCaptureOperation } from "../storage/LocalFirstStore";
import type { RecordingDiskMonitor } from "../storage/RecordingDiskMonitor";
import type { StagedArtifactWrite } from "../storage/LocalStorageService";
import { DataRootValidationError, StorageError } from "../storage/errors";
import type {
  CaptureAbortRequest,
  CaptureChunkRequest,
  CaptureEngine,
  CaptureErrorInfo,
  CaptureFinalizeRequest,
  CaptureSessionState,
  CaptureStartRequest,
  CaptureStreamRequest,
  CaptureStateSnapshot,
} from "./CaptureEngine";

const DEFAULT_CAPTURE_SOURCE = "LOCAL_CHUNK_CAPTURE";

interface ActiveCaptureSession {
  captureId: string;
  operation: RecordingCaptureOperation;
  stage: StagedArtifactWrite;
  state: CaptureSessionState;
  hash: ReturnType<typeof createHash>;
  sha256?: string;
  bytesWritten: number;
  chunksWritten: number;
  endedAt?: string;
  durationMs?: number;
  artifact?: Artifact;
  error?: CaptureErrorInfo;
  monitor?: RecordingDiskMonitor;
  pending: Promise<void>;
}

/**
 * Local chunk/file-backed capture adapter. It accepts bytes from a real capture
 * source, materializes them into a LocalStorageService-owned staged artifact,
 * and commits only through LocalFirstStore so SQLite/artifact journals remain
 * authoritative.
 */
export class LocalRecordingCaptureEngine implements CaptureEngine {
  private readonly sessions = new Map<string, ActiveCaptureSession>();
  private readonly activeMeetingIds = new Map<string, string>();

  public constructor(
    private readonly store: LocalFirstStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async startCapture(request: CaptureStartRequest): Promise<CaptureStateSnapshot> {
    assertNoCallerPath(request);
    const format = normalizeFormat(request.format);
    const mimeType = normalizeMimeType(request.mimeType);
    validateDiskMonitorRequest(request.diskMonitor);
    if (this.activeMeetingIds.has(request.meetingId)) {
      throw new StorageError(`A capture is already active for meeting ${request.meetingId}.`);
    }
    const operation = await this.store.beginRecordingCapture({
      meetingId: request.meetingId,
      extension: format,
      mimeType,
      estimatedBytes: request.estimatedBytes,
      captureSource: request.captureSource ?? DEFAULT_CAPTURE_SOURCE,
      startedAt: request.startedAt,
    });

    let stage: StagedArtifactWrite;
    try {
      stage = await this.store.storage.beginStagedArtifactWrite(operation.relativePath);
      this.store.markRecordingCaptureWriting(operation.operationId);
    } catch (error: unknown) {
      this.store.failRecordingCapture({
        meetingId: operation.meetingId,
        operationId: operation.operationId,
        reason: errorMessage(error),
        failed: true,
      });
      throw error;
    }

    const session: ActiveCaptureSession = {
      captureId: randomUUID(),
      operation,
      stage,
      state: "RECORDING",
      hash: createHash("sha256"),
      bytesWritten: 0,
      chunksWritten: 0,
      pending: Promise.resolve(),
    };
    this.sessions.set(session.captureId, session);
    this.activeMeetingIds.set(operation.meetingId, session.captureId);

    if (request.diskMonitor !== undefined) {
      session.monitor = this.store.createRecordingDiskMonitor(operation.meetingId, {
        criticalFreeBytes: request.diskMonitor.criticalFreeBytes,
        intervalMs: request.diskMonitor.intervalMs,
        onCritical: (availableBytes) => {
          void this.enqueue(session, async () => {
            if (session.state === "RECORDING") {
              await this.failSession(session, false, `Critical disk-space threshold reached: ${availableBytes ?? "unknown"} bytes available.`);
            }
          }).catch(() => undefined);
        },
      });
      try {
        await session.monitor.start();
        await session.pending;
      } catch (error: unknown) {
        await this.failSession(session, true, errorMessage(error));
        throw error;
      }
    }

    return snapshot(session);
  }

  public getCaptureState(captureId: string): CaptureStateSnapshot {
    return snapshot(this.requireSession(captureId));
  }

  public async appendChunk(request: CaptureChunkRequest): Promise<CaptureStateSnapshot> {
    const session = this.requireSession(request.captureId);
    return this.enqueue(session, async () => {
      this.assertSessionWritable(session, request.meetingId);
      const chunk = normalizeChunk(request.chunk);
      if (request.sequence !== undefined && request.sequence !== session.chunksWritten) {
        throw new StorageError(`Capture chunk sequence ${request.sequence} does not match expected sequence ${session.chunksWritten}.`);
      }
      try {
        await this.store.storage.checkDiskSpace(chunk.byteLength);
        await this.store.storage.appendToStagedArtifact(session.stage, chunk);
      } catch (error: unknown) {
        await this.failSession(session, false, errorMessage(error));
        throw error;
      }
      session.hash.update(chunk);
      session.bytesWritten += chunk.byteLength;
      session.chunksWritten += 1;
      return snapshot(session);
    });
  }

  public async appendStream(request: CaptureStreamRequest): Promise<CaptureStateSnapshot> {
    let sequence = request.startingSequence;
    let latest = this.getCaptureState(request.captureId);
    for await (const chunk of request.stream) {
      latest = await this.appendChunk({
        captureId: request.captureId,
        meetingId: request.meetingId,
        chunk,
        ...(sequence === undefined ? {} : { sequence }),
      });
      if (sequence !== undefined) {
        sequence += 1;
      }
    }
    return latest;
  }

  public async finalizeCapture(request: CaptureFinalizeRequest): Promise<CaptureStateSnapshot> {
    const session = this.requireSession(request.captureId);
    return this.enqueue(session, async () => {
      if (session.operation.meetingId !== request.meetingId) {
        throw new StorageError("Capture meeting ID does not match the session owner.");
      }
      if (session.state === "COMPLETED") {
        throw new StorageError("Capture has already been finalized.");
      }
      if (session.state !== "RECORDING") {
        throw new StorageError(`Capture cannot be finalized while ${session.state}.`);
      }
      if (session.bytesWritten === 0) {
        const error = new DataRootValidationError("Cannot finalize an empty recording capture.");
        await this.failSession(session, false, error.message);
        throw error;
      }
      session.state = "FINALIZING";
      session.monitor?.stop();
      session.sha256 = session.hash.digest("hex");
      const endedAt = request.endedAt ?? this.clock().toISOString();
      session.endedAt = endedAt;
      session.durationMs = durationMs(session.operation.startedAt, endedAt);
      try {
        const verification = await this.store.storage.finalizeStagedArtifact(session.stage, session.sha256);
        if (verification.sha256 === undefined || verification.modifiedAt === undefined) {
          throw new StorageError("Finalized capture artifact verification did not return required metadata.");
        }
        session.artifact = this.store.commitRecordingCapture({
          ...session.operation,
          verification: { ...verification, sha256: verification.sha256, modifiedAt: verification.modifiedAt },
          endedAt,
          durationMs: session.durationMs,
        });
        session.state = "COMPLETED";
        this.activeMeetingIds.delete(session.operation.meetingId);
        return snapshot(session);
      } catch (error: unknown) {
        await this.failSession(session, true, errorMessage(error));
        throw error;
      }
    });
  }

  public async abortCapture(request: CaptureAbortRequest): Promise<CaptureStateSnapshot> {
    const session = this.requireSession(request.captureId);
    return this.enqueue(session, async () => {
      if (session.operation.meetingId !== request.meetingId) {
        throw new StorageError("Capture meeting ID does not match the session owner.");
      }
      if (session.state === "COMPLETED") {
        throw new StorageError("A completed capture cannot be aborted.");
      }
      if (session.state === "INCOMPLETE" || session.state === "FAILED") {
        return snapshot(session);
      }
      await this.failSession(session, false, request.reason);
      return snapshot(session);
    });
  }

  private async enqueue<T>(session: ActiveCaptureSession, work: () => Promise<T>): Promise<T> {
    const next = session.pending.then(work, work);
    session.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private assertSessionWritable(session: ActiveCaptureSession, meetingId: string): void {
    if (session.operation.meetingId !== meetingId) {
      throw new StorageError("Capture meeting ID does not match the session owner.");
    }
    if (session.state !== "RECORDING") {
      throw new StorageError(`Capture is not writable while ${session.state}.`);
    }
  }

  private async failSession(session: ActiveCaptureSession, failed: boolean, message: string): Promise<void> {
    session.monitor?.stop();
    await this.store.storage.discardStagedArtifact(session.stage);
    session.state = failed ? "FAILED" : "INCOMPLETE";
    session.error = { code: failed ? "CAPTURE_FAILED" : "CAPTURE_INCOMPLETE", message };
    this.activeMeetingIds.delete(session.operation.meetingId);
    this.store.failRecordingCapture({
      meetingId: session.operation.meetingId,
      operationId: session.operation.operationId,
      reason: message,
      failed,
    });
  }

  private requireSession(captureId: string): ActiveCaptureSession {
    const session = this.sessions.get(captureId);
    if (session === undefined) {
      throw new StorageError(`Capture session not found: ${captureId}`);
    }
    return session;
  }
}

function validateDiskMonitorRequest(value: CaptureStartRequest["diskMonitor"]): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value.criticalFreeBytes) || value.criticalFreeBytes < 0) {
    throw new DataRootValidationError("Capture disk monitor criticalFreeBytes must be a non-negative finite number.");
  }
  if (value.intervalMs !== undefined && (!Number.isFinite(value.intervalMs) || value.intervalMs <= 0)) {
    throw new DataRootValidationError("Capture disk monitor intervalMs must be a positive finite number.");
  }
}

function snapshot(session: ActiveCaptureSession): CaptureStateSnapshot {
  const state: CaptureStateSnapshot = {
    captureId: session.captureId,
    meetingId: session.operation.meetingId,
    state: session.state,
    startedAt: session.operation.startedAt,
    bytesWritten: session.bytesWritten,
    chunksWritten: session.chunksWritten,
    format: session.operation.extension,
    mimeType: session.operation.mimeType,
    captureSource: session.operation.captureSource,
    relativePath: session.operation.relativePath,
  };
  addOptional(state, "endedAt", session.endedAt);
  addOptional(state, "durationMs", session.durationMs);
  addOptional(state, "sha256", session.sha256);
  addOptional(state, "artifact", session.artifact);
  addOptional(state, "error", session.error);
  return state;
}

function normalizeFormat(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  if (!/^[a-z0-9]{1,12}$/.test(normalized)) {
    throw new DataRootValidationError("Capture format must be a safe container/extension.");
  }
  return normalized;
}

function normalizeMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[ a-z0-9=.+-]+)?$/.test(normalized)) {
    throw new DataRootValidationError("Capture MIME type is invalid.");
  }
  return normalized;
}

function normalizeChunk(value: unknown): Uint8Array {
  let chunk: Uint8Array;
  if (value instanceof Uint8Array) {
    chunk = value;
  } else if (value instanceof ArrayBuffer) {
    chunk = new Uint8Array(value);
  } else {
    throw new DataRootValidationError("Capture chunks must be binary Uint8Array data.");
  }
  if (chunk.byteLength === 0) {
    throw new DataRootValidationError("Capture chunks cannot be empty.");
  }
  return chunk;
}

function assertNoCallerPath(request: CaptureStartRequest): void {
  const unsafe = request as CaptureStartRequest & { outputPath?: unknown; sourcePath?: unknown; relativePath?: unknown };
  if (unsafe.outputPath !== undefined || unsafe.sourcePath !== undefined || unsafe.relativePath !== undefined) {
    throw new StorageError("Capture output paths are owned by AI WorkMate and cannot be supplied by callers.");
  }
}

function durationMs(startedAt: string, endedAt: string): number | undefined {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
