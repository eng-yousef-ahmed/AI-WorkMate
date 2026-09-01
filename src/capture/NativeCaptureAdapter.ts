import type { CaptureStateSnapshot } from "./CaptureEngine";

export type NativeCaptureKind = "MICROPHONE_AUDIO" | "SYSTEM_AUDIO" | "SCREEN" | "WINDOW";

export type NativeCaptureCapabilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "PERMISSION_DENIED";

export type NativeCaptureErrorCode =
  | "NATIVE_PLATFORM_UNSUPPORTED"
  | "NATIVE_PROVIDER_NOT_CONFIGURED"
  | "NATIVE_CAPABILITY_UNAVAILABLE"
  | "NATIVE_PERMISSION_DENIED"
  | "NATIVE_DEVICE_UNAVAILABLE"
  | "NATIVE_CAPTURE_START_FAILED"
  | "NATIVE_CAPTURE_STREAM_FAILED"
  | "NATIVE_CAPTURE_ABORTED"
  | "NATIVE_CAPTURE_POLICY_DENIED"
  | "NATIVE_CAPTURE_SESSION_NOT_FOUND";

export interface NativeCaptureErrorInfo {
  code: NativeCaptureErrorCode;
  message: string;
  capability?: NativeCaptureKind;
  retryable: boolean;
}

export interface NativeCaptureSourceDescriptor {
  sourceId: string;
  label?: string;
  kind: NativeCaptureKind;
  isDefault?: boolean;
}

export interface NativeCaptureCapability {
  kind: NativeCaptureKind;
  status: NativeCaptureCapabilityStatus;
  available: boolean;
  canListSources: boolean;
  requiresPermission: boolean;
  sources?: NativeCaptureSourceDescriptor[];
  error?: NativeCaptureErrorInfo;
}

export interface NativeCaptureCapabilities {
  platform: NodeJS.Platform | string;
  adapterId: string;
  checkedAt: string;
  supported: boolean;
  capabilities: Record<NativeCaptureKind, NativeCaptureCapability>;
}

export interface NativeCaptureStartRequest {
  capability: NativeCaptureKind;
  sourceId?: string;
  format: string;
  mimeType: string;
}

export interface NativeCaptureSession {
  nativeSessionId: string;
  capability: NativeCaptureKind;
  sourceId?: string;
  format: string;
  mimeType: string;
  startedAt: string;
  chunks: AsyncIterable<Uint8Array>;
  stop(): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface NativeCaptureAdapter {
  readonly adapterId: string;
  discoverCapabilities(): Promise<NativeCaptureCapabilities>;
  startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession>;
}

export type NativeCapturePolicyDecision = "ALLOW" | "DENY";

export type NativeCapturePolicy = Readonly<Record<NativeCaptureKind, NativeCapturePolicyDecision>>;

export const DEFAULT_NATIVE_CAPTURE_POLICY: NativeCapturePolicy = Object.freeze({
  MICROPHONE_AUDIO: "DENY",
  SYSTEM_AUDIO: "DENY",
  SCREEN: "DENY",
  WINDOW: "DENY",
});

export interface NativeMeetingCaptureStartRequest {
  meetingId: string;
  capability: NativeCaptureKind;
  sourceId?: string;
  format: string;
  mimeType: string;
  estimatedBytes?: number;
  diskMonitor?: {
    criticalFreeBytes: number;
    intervalMs?: number;
  };
}

export interface NativeMeetingCaptureStopRequest {
  captureId: string;
  meetingId: string;
  endedAt?: string;
}

export interface NativeMeetingCaptureAbortRequest {
  captureId: string;
  meetingId: string;
  reason: string;
}

export interface NativeCaptureStateSnapshot extends CaptureStateSnapshot {
  nativeSessionId: string;
  capability: NativeCaptureKind;
  sourceId?: string;
  nativeAdapterId: string;
  nativeError?: NativeCaptureErrorInfo;
}

export class NativeCaptureError extends Error {
  public readonly code: NativeCaptureErrorCode;
  public readonly capability: NativeCaptureKind | undefined;
  public readonly retryable: boolean;

  public constructor(info: NativeCaptureErrorInfo, options?: ErrorOptions) {
    super(info.message, options);
    this.name = "NativeCaptureError";
    this.code = info.code;
    this.capability = info.capability;
    this.retryable = info.retryable;
  }

  public toJSON(): NativeCaptureErrorInfo {
    const info: NativeCaptureErrorInfo = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.capability !== undefined) {
      info.capability = this.capability;
    }
    return info;
  }
}

export const NATIVE_CAPTURE_KINDS: readonly NativeCaptureKind[] = Object.freeze([
  "MICROPHONE_AUDIO",
  "SYSTEM_AUDIO",
  "SCREEN",
  "WINDOW",
]);

export function unavailableCapability(
  kind: NativeCaptureKind,
  status: NativeCaptureCapabilityStatus,
  error: NativeCaptureErrorInfo,
): NativeCaptureCapability {
  return {
    kind,
    status,
    available: false,
    canListSources: false,
    requiresPermission: status === "PERMISSION_DENIED",
    error,
  };
}

export function capabilityUnavailableError(
  capability: NativeCaptureKind,
  message: string,
  code: NativeCaptureErrorCode = "NATIVE_CAPABILITY_UNAVAILABLE",
  retryable = true,
): NativeCaptureError {
  return new NativeCaptureError({ code, message, capability, retryable });
}
