import type { CaptureStateSnapshot } from "./CaptureEngine";
import type { LocalRecordingCaptureEngine } from "./LocalRecordingCaptureEngine";
import {
  DEFAULT_NATIVE_CAPTURE_POLICY,
  NativeCaptureError,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureKind,
  type NativeCapturePolicy,
  type NativeCaptureSession,
  type NativeCaptureStateSnapshot,
  type NativeMeetingCaptureAbortRequest,
  type NativeMeetingCaptureStartRequest,
  type NativeMeetingCaptureStopRequest,
} from "./NativeCaptureAdapter";
import { StorageError } from "../storage/errors";

interface ActiveNativeCapture {
  localCaptureId: string;
  meetingId: string;
  nativeSession: NativeCaptureSession;
  nativeAdapterId: string;
  capability: NativeCaptureKind;
  sourceId?: string;
  pump: Promise<void>;
  nextSequence: number;
  failed?: NativeCaptureError;
  flowId?: string;
}

export interface NativeCaptureCoordinatorOptions {
  policy?: Partial<NativeCapturePolicy>;
  /** Optional callback invoked when an active native session fails while streaming. */
  onSourceFailed?: (info: { captureId: string; meetingId: string; capability: NativeCaptureKind; error: NativeCaptureError }) => void;
}

/**
 * Orchestrates a real native capture session into the local recording pipeline.
 * It does not capture bytes itself; it owns meeting/session coordination and
 * feeds native chunks into LocalRecordingCaptureEngine in-order.
 */
export class NativeCaptureCoordinator {
  private readonly policy: NativeCapturePolicy;
  private readonly activeByCaptureId = new Map<string, ActiveNativeCapture>();
  /** Active single-capture guard: meetingId -> local captureId (today's one-capture-per-meeting path). */
  private readonly activeByMeetingId = new Map<string, string>();
  /** Active flow occupancy: meetingId -> flowId. One flow per meeting, many independent sources per flow. */
  private readonly activeFlowMeetingIds = new Map<string, string>();
  private readonly onSourceFailed: NativeCaptureCoordinatorOptions["onSourceFailed"];

  public constructor(
    private readonly nativeAdapter: NativeCaptureAdapter,
    private readonly localCapture: LocalRecordingCaptureEngine,
    options: NativeCaptureCoordinatorOptions = {},
  ) {
    this.policy = { ...DEFAULT_NATIVE_CAPTURE_POLICY, ...options.policy };
    this.onSourceFailed = options.onSourceFailed;
  }

  public discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    return this.nativeAdapter.discoverCapabilities();
  }

  public async startCapture(request: NativeMeetingCaptureStartRequest): Promise<NativeCaptureStateSnapshot> {
    assertNoCallerPath(request);
    if (this.activeByMeetingId.has(request.meetingId)) {
      throw new StorageError(`A native capture is already active for meeting ${request.meetingId}.`);
    }
    const occupantFlowId = this.activeFlowMeetingIds.get(request.meetingId);
    if (request.flowId === undefined ? occupantFlowId !== undefined : occupantFlowId !== undefined && occupantFlowId !== request.flowId) {
      throw new StorageError(`A native capture is already active for meeting ${request.meetingId}.`);
    }
    this.assertPolicyAllows(request.capability);
    const capabilities = await this.nativeAdapter.discoverCapabilities();
    const capability = capabilities.capabilities[request.capability];
    if (!capabilities.supported || capability === undefined || !capability.available) {
      throw new NativeCaptureError(capability?.error ?? {
        code: capabilities.supported ? "NATIVE_CAPABILITY_UNAVAILABLE" : "NATIVE_PLATFORM_UNSUPPORTED",
        message: capabilities.supported
          ? `Native capture capability is unavailable: ${request.capability}.`
          : `Native capture is unsupported on platform ${capabilities.platform}.`,
        capability: request.capability,
        retryable: capabilities.supported,
      });
    }
    if (request.sourceId !== undefined && capability.sources !== undefined && !capability.sources.some((source) => source.sourceId === request.sourceId)) {
      throw new NativeCaptureError({
        code: "NATIVE_CAPABILITY_UNAVAILABLE",
        message: `Native capture source is unavailable for ${request.capability}.`,
        capability: request.capability,
        retryable: true,
      });
    }

    const nativeSession = await this.nativeAdapter.startCapture({
      capability: request.capability,
      format: request.format,
      mimeType: request.mimeType,
      ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    });

    let localState: NativeCaptureStateSnapshot | undefined;
    try {
      const started = await this.localCapture.startCapture({
        meetingId: request.meetingId,
        format: nativeSession.format,
        mimeType: nativeSession.mimeType,
        estimatedBytes: request.estimatedBytes,
        startedAt: nativeSession.startedAt,
        captureSource: `${this.nativeAdapter.adapterId}:${request.capability}`,
        diskMonitor: request.diskMonitor,
        ...(request.flowId === undefined ? {} : { flowId: request.flowId }),
      });
      const active: ActiveNativeCapture = {
        localCaptureId: started.captureId,
        meetingId: request.meetingId,
        nativeSession,
        nativeAdapterId: this.nativeAdapter.adapterId,
        capability: request.capability,
        ...(nativeSession.sourceId === undefined ? {} : { sourceId: nativeSession.sourceId }),
        ...(request.flowId === undefined ? {} : { flowId: request.flowId }),
        nextSequence: 0,
        pump: Promise.resolve(),
      };
      if (started.state !== "RECORDING") {
        await nativeSession.abort(`Local capture did not enter RECORDING: ${started.state}.`).catch(() => undefined);
        localState = nativeSnapshot(started, active);
        return localState;
      }
      active.pump = this.pumpNativeChunks(active);
      this.activeByCaptureId.set(started.captureId, active);
      if (request.flowId === undefined) {
        this.activeByMeetingId.set(request.meetingId, started.captureId);
      } else {
        this.activeFlowMeetingIds.set(request.meetingId, request.flowId);
      }
      localState = nativeSnapshot(started, active);
      return localState;
    } catch (error: unknown) {
      await nativeSession.abort(error instanceof Error ? error.message : String(error)).catch(() => undefined);
      throw error;
    }
  }

  public getCaptureState(captureId: string): NativeCaptureStateSnapshot {
    const active = this.requireActiveCapture(captureId);
    return nativeSnapshot(this.localCapture.getCaptureState(captureId), active);
  }

  public async stopCapture(request: NativeMeetingCaptureStopRequest): Promise<NativeCaptureStateSnapshot> {
    const active = this.requireActiveCapture(request.captureId);
    this.assertMeetingOwner(active, request.meetingId);
    try {
      await active.nativeSession.stop();
    } catch (error: unknown) {
      const stopError = error instanceof NativeCaptureError
        ? error
        : new NativeCaptureError({
            code: "NATIVE_CAPTURE_STOP_FAILED",
            message: error instanceof Error ? error.message : String(error),
            capability: active.capability,
            retryable: true,
          }, { cause: error });
      active.failed = stopError;
      await active.nativeSession.abort(stopError.message).catch(() => undefined);
      await active.pump.catch(() => undefined);
      try {
        await this.localCapture.abortCapture({
          captureId: active.localCaptureId,
          meetingId: active.meetingId,
          reason: stopError.message,
        });
      } finally {
        this.clearActive(active);
      }
      throw stopError;
    }
    await active.pump;
    if (active.failed !== undefined) {
      this.clearActive(active);
      throw active.failed;
    }
    try {
      const finalized = await this.localCapture.finalizeCapture({
        captureId: request.captureId,
        meetingId: request.meetingId,
        endedAt: request.endedAt,
      });
      this.clearActive(active);
      return nativeSnapshot(finalized, active);
    } catch (error: unknown) {
      this.clearActive(active);
      throw error;
    }
  }

  public async abortCapture(request: NativeMeetingCaptureAbortRequest): Promise<NativeCaptureStateSnapshot> {
    const active = this.requireActiveCapture(request.captureId);
    this.assertMeetingOwner(active, request.meetingId);
    await active.nativeSession.abort(request.reason).catch(() => undefined);
    await active.pump.catch(() => undefined);
    const aborted = await this.localCapture.abortCapture({
      captureId: request.captureId,
      meetingId: request.meetingId,
      reason: request.reason,
    });
    this.clearActive(active);
    return nativeSnapshot(aborted, active);
  }

  public async abortAllActive(reason: string): Promise<void> {
    const actives = [...this.activeByCaptureId.values()];
    for (const active of actives) {
      await this.abortCapture({
        captureId: active.localCaptureId,
        meetingId: active.meetingId,
        reason,
      }).catch(() => undefined);
    }
  }

  private async pumpNativeChunks(active: ActiveNativeCapture): Promise<void> {
    try {
      for await (const chunk of active.nativeSession.chunks) {
        await this.localCapture.appendChunk({
          captureId: active.localCaptureId,
          meetingId: active.meetingId,
          chunk,
          sequence: active.nextSequence,
        });
        active.nextSequence += 1;
      }
    } catch (error: unknown) {
      const nativeError = error instanceof NativeCaptureError
        ? error
        : new NativeCaptureError({
            code: "NATIVE_CAPTURE_STREAM_FAILED",
            message: error instanceof Error ? error.message : String(error),
            capability: active.capability,
            retryable: true,
          }, { cause: error });
      active.failed = nativeError;
      await this.localCapture.abortCapture({
        captureId: active.localCaptureId,
        meetingId: active.meetingId,
        reason: nativeError.message,
      });
      await active.nativeSession.abort(nativeError.message).catch(() => undefined);
      this.onSourceFailed?.({
        captureId: active.localCaptureId,
        meetingId: active.meetingId,
        capability: active.capability,
        error: nativeError,
      });
    }
  }

  private assertPolicyAllows(capability: NativeCaptureKind): void {
    if (this.policy[capability] !== "ALLOW") {
      throw new NativeCaptureError({
        code: "NATIVE_CAPTURE_POLICY_DENIED",
        message: `Native capture policy denies ${capability}.`,
        capability,
        retryable: false,
      });
    }
  }

  private requireActiveCapture(captureId: string): ActiveNativeCapture {
    const active = this.activeByCaptureId.get(captureId);
    if (active === undefined) {
      throw new NativeCaptureError({
        code: "NATIVE_CAPTURE_SESSION_NOT_FOUND",
        message: `Native capture session not found: ${captureId}.`,
        retryable: false,
      });
    }
    return active;
  }

  private assertMeetingOwner(active: ActiveNativeCapture, meetingId: string): void {
    if (active.meetingId !== meetingId) {
      throw new StorageError("Native capture meeting ID does not match the session owner.");
    }
  }

  private clearActive(active: ActiveNativeCapture): void {
    this.activeByCaptureId.delete(active.localCaptureId);
    if (active.flowId === undefined) {
      this.activeByMeetingId.delete(active.meetingId);
    } else {
      this.activeFlowMeetingIds.delete(active.meetingId);
    }
  }
}

function nativeSnapshot(state: CaptureStateSnapshot, active: ActiveNativeCapture): NativeCaptureStateSnapshot {
  const snapshot: NativeCaptureStateSnapshot = {
    ...state,
    nativeSessionId: active.nativeSession.nativeSessionId,
    capability: active.capability,
    nativeAdapterId: active.nativeAdapterId,
  };
  addOptional(snapshot, "sourceId", active.sourceId);
  addOptional(snapshot, "nativeError", active.failed?.toJSON());
  return snapshot;
}

function assertNoCallerPath(request: NativeMeetingCaptureStartRequest): void {
  const unsafe = request as NativeMeetingCaptureStartRequest & { outputPath?: unknown; sourcePath?: unknown; relativePath?: unknown };
  if (unsafe.outputPath !== undefined || unsafe.sourcePath !== undefined || unsafe.relativePath !== undefined) {
    throw new StorageError("Native capture output paths are owned by AI WorkMate and cannot be supplied by callers.");
  }
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
