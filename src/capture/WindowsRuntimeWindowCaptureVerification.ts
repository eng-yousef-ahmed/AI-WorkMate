import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NativeCaptureError,
  type NativeCaptureErrorState,
  type NativeCaptureSourceDescriptor,
} from "./NativeCaptureAdapter";
import {
  WINDOWS_SCREEN_CAPTURE_FORMAT,
  WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
  resolveWindowsScreenHelperPath,
} from "./WindowsNativeScreenProvider";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { removeDirectoryAfterSqliteClose } from "../storage/sqlite-lifecycle";

export const WINDOWS_RUNTIME_WINDOW_CAPTURE_VERIFY_DURATION_MS = 3_000;

/**
 * Windows-only production-path verification for Windows Graphics Capture of a
 * real enumerated HWND. Mirrors the SCREEN (DXGI Desktop Duplication) runtime
 * verification: isolated temp DATA_ROOT/config, abort journal check, real
 * capture committed through StorageRuntime, JPEG JSONL inspection, and no
 * SCREEN fallback (WGC failure is a verification failure, never a fallback).
 */
export interface WindowsRuntimeWindowCaptureCaseResult {
  capability: "WINDOW";
  success: boolean;
  sourceId?: string;
  sourceLabel?: string;
  format?: string;
  mimeType?: string;
  frameWidth?: number;
  frameHeight?: number;
  chunkCount?: number;
  firstSequence?: number;
  lastSequence?: number;
  totalBytes?: number;
  sha256?: string;
  recordingId?: string;
  meetingId?: string;
  captureId?: string;
  meetingStatus?: string;
  artifactJournalState?: string;
  sqliteRecordingStatus?: string;
  finalArtifactExists?: boolean;
  finalArtifactSize?: number;
  jpegFrames?: number;
  failureCode?: string;
  failureMessage?: string;
  /** Structured WGC pipeline state attached by the native helper to its error record. */
  nativeCaptureState?: NativeCaptureErrorState;
}

export interface WindowsRuntimeWindowCaptureVerificationResult {
  success: boolean;
  windowsVerified: boolean;
  platform: NodeJS.Platform | string;
  helperPath?: string;
  helperFound: boolean;
  durationMs: number;
  isolatedWorkspace: true;
  userDataUntouched: true;
  cloudServiceUsed: false;
  abort: {
    success: boolean;
    meetingStatus?: string;
    artifactJournalState?: string;
    sqliteRecordingCount?: number;
    failureCode?: string;
    failureMessage?: string;
  };
  capture?: WindowsRuntimeWindowCaptureCaseResult;
  enumeratedWindows?: number;
  selectedSourceId?: string;
  selectedSourceLabel?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsRuntimeWindowCaptureVerificationOptions {
  durationMs?: number;
  keepWorkspace?: boolean;
  /** Injected so unit tests can pin the fail-closed off-Windows contract. */
  platform?: NodeJS.Platform | string;
}

/** Shell desktop window whose HWND is not a representative WGC target. */
const SHELL_DESKTOP_LABELS = new Set(["program manager"]);

/**
 * Deterministic selection of a real capturable window. The helper already
 * filters enumeration to visible windows with a title that are not cloaked or
 * tool windows. Selection prefers ordinary application windows over the shell
 * desktop ("Program Manager") and orders candidates by numeric HWND so the
 * same desktop state always picks the same window. No mock/fake frames.
 */
export function selectDeterministicWindowSource(
  sources: NativeCaptureSourceDescriptor[] | undefined,
): NativeCaptureSourceDescriptor | undefined {
  if (sources === undefined || sources.length === 0) {
    return undefined;
  }
  const sorted = [...sources].sort((left, right) => windowSourceOrder(left.sourceId) - windowSourceOrder(right.sourceId));
  const preferred = sorted.filter(
    (source) => source.label === undefined || !SHELL_DESKTOP_LABELS.has(source.label.trim().toLowerCase()),
  );
  return (preferred.length > 0 ? preferred : sorted)[0];
}

/**
 * Windows-only production-path verification for WGC window capture.
 * Isolated temp DATA_ROOT/config. Off Windows it fail-closes.
 */
export async function runWindowsRuntimeWindowCaptureVerification(
  options: WindowsRuntimeWindowCaptureVerificationOptions = {},
): Promise<WindowsRuntimeWindowCaptureVerificationResult> {
  const durationMs = options.durationMs ?? WINDOWS_RUNTIME_WINDOW_CAPTURE_VERIFY_DURATION_MS;
  const platform = options.platform ?? process.platform;
  const helperPath = await resolveWindowsScreenHelperPath();
  const base: Omit<WindowsRuntimeWindowCaptureVerificationResult, "success" | "windowsVerified" | "abort"> = {
    platform,
    helperFound: helperPath !== undefined,
    durationMs,
    isolatedWorkspace: true,
    userDataUntouched: true,
    cloudServiceUsed: false,
  };
  if (helperPath !== undefined) {
    (base as WindowsRuntimeWindowCaptureVerificationResult).helperPath = helperPath;
  }

  if (platform !== "win32") {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort: { success: false, failureCode: "NATIVE_PLATFORM_UNSUPPORTED", failureMessage: `Windows window capture verification requires win32, not ${platform}.` },
      failureCode: "NATIVE_PLATFORM_UNSUPPORTED",
      failureMessage: `Windows window capture verification requires win32, not ${platform}.`,
    };
  }
  if (helperPath === undefined) {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort: { success: false, failureCode: "NATIVE_PROVIDER_NOT_CONFIGURED", failureMessage: "Windows native screen helper was not found." },
      failureCode: "NATIVE_PROVIDER_NOT_CONFIGURED",
      failureMessage: "Windows native screen helper was not found. Run npm run build:native:win first.",
    };
  }

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-window-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-window-verify-data-"));
  const runtime = new StorageRuntime(new StorageConfigService(join(appConfigRoot, "storage-config.json")));
  let abort: WindowsRuntimeWindowCaptureVerificationResult["abort"] = { success: false };
  let capture: WindowsRuntimeWindowCaptureCaseResult | undefined;
  let enumeratedWindows = 0;
  let chosen: NativeCaptureSourceDescriptor | undefined;
  try {
    await runtime.configureFirstRun(dataRoot);
    const discovered = await runtime.discoverNativeCaptureCapabilities();
    enumeratedWindows = discovered.capabilities.WINDOW.sources?.length ?? 0;
    chosen = selectDeterministicWindowSource(discovered.capabilities.WINDOW.sources);
    abort = await verifyAbort(runtime, chosen);
    capture = await verifyCapture(runtime, dataRoot, durationMs, chosen);
    const completed = abort.success && capture.success && enumeratedWindows > 0;
    const windowsVerified = platform === "win32" && helperPath !== undefined && completed === true
      && durationMs >= WINDOWS_RUNTIME_WINDOW_CAPTURE_VERIFY_DURATION_MS;
    return {
      ...base,
      success: windowsVerified,
      windowsVerified,
      abort,
      capture,
      enumeratedWindows,
      ...(chosen === undefined ? {} : { selectedSourceId: chosen.sourceId }),
      ...(chosen?.label === undefined ? {} : { selectedSourceLabel: chosen.label }),
      ...(windowsVerified ? {} : { failureCode: "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE", failureMessage: "One or more Windows window capture checks failed." }),
    };
  } catch (error: unknown) {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort,
      capture,
      enumeratedWindows,
      ...(chosen === undefined ? {} : { selectedSourceId: chosen.sourceId }),
      ...(chosen?.label === undefined ? {} : { selectedSourceLabel: chosen.label }),
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_START_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.close();
    if (options.keepWorkspace !== true) {
      await removeDirectoryAfterSqliteClose(appConfigRoot);
      await removeDirectoryAfterSqliteClose(dataRoot);
    }
  }
}

async function verifyAbort(
  runtime: StorageRuntime,
  chosen: NativeCaptureSourceDescriptor | undefined,
): Promise<WindowsRuntimeWindowCaptureVerificationResult["abort"]> {
  const meeting = await runtime.store?.createMeeting({ title: "Window abort verify", meetingDate: "2026-09-06" });
  if (meeting === undefined) {
    return { success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Abort verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const windows = capabilities.capabilities.WINDOW;
    if (!windows.available) {
      return {
        success: false,
        failureCode: windows.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: windows.error?.message ?? "No capturable window is available for abort verification.",
      };
    }
    const source = chosen ?? selectDeterministicWindowSource(windows.sources);
    if (source === undefined) {
      return {
        success: false,
        failureCode: "NATIVE_DEVICE_UNAVAILABLE",
        failureMessage: "No capturable window is available for abort verification.",
      };
    }
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "WINDOW",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
      sourceId: source.sourceId,
    });
    const aborted = await runtime.abortNativeCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      reason: "window-capture-abort-verification",
    });
    const journal = runtime.store?.database.listArtifactOperations().filter((operation) => operation.meetingId === meeting.meetingId).at(-1);
    const recordings = runtime.store?.database.listRecordings(meeting.meetingId) ?? [];
    const success = aborted.state === "INCOMPLETE" && journal?.state === "INCOMPLETE" && recordings.length === 0;
    return {
      success,
      meetingStatus: runtime.store?.getMeeting(meeting.meetingId)?.status,
      artifactJournalState: journal?.state,
      sqliteRecordingCount: recordings.length,
      ...(success ? {} : { failureCode: "NATIVE_CAPTURE_ABORTED", failureMessage: "Abort did not leave an incomplete journal without a recording row." }),
    };
  } catch (error: unknown) {
    return {
      success: false,
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_ABORTED",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyCapture(
  runtime: StorageRuntime,
  dataRoot: string,
  durationMs: number,
  chosen: NativeCaptureSourceDescriptor | undefined,
): Promise<WindowsRuntimeWindowCaptureCaseResult> {
  const meeting = await runtime.store?.createMeeting({ title: "Window capture verify", meetingDate: "2026-09-06" });
  if (meeting === undefined) {
    return { capability: "WINDOW", success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Capture verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const windows = capabilities.capabilities.WINDOW;
    if (!windows.available) {
      return {
        capability: "WINDOW",
        success: false,
        meetingId: meeting.meetingId,
        failureCode: windows.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: windows.error?.message ?? "WINDOW is unavailable.",
      };
    }
    const source = chosen ?? selectDeterministicWindowSource(windows.sources);
    if (source === undefined) {
      return {
        capability: "WINDOW",
        success: false,
        meetingId: meeting.meetingId,
        failureCode: "NATIVE_DEVICE_UNAVAILABLE",
        failureMessage: "No visible capturable window was enumerated. Open an ordinary application window and re-run.",
      };
    }
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "WINDOW",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
      sourceId: source.sourceId,
    });
    await wait(durationMs);
    let stopped;
    try {
      stopped = await runtime.stopNativeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    } catch (error: unknown) {
      return stopFailureResult(meeting.meetingId, started.captureId, source, error);
    }
    const relativePath = stopped.relativePath;
    if (relativePath === undefined) {
      return {
        capability: "WINDOW",
        success: false,
        meetingId: meeting.meetingId,
        captureId: started.captureId,
        failureCode: "NATIVE_CAPTURE_STOP_FAILED",
        failureMessage: "Finalized capture did not return a relative artifact path.",
      };
    }
    const absolutePath = join(dataRoot, relativePath);
    const file = await stat(absolutePath);
    const contents = await readFile(absolutePath);
    const stream = inspectJsonl(contents.toString("utf8"));
    const journal = runtime.store?.database.listArtifactOperations().filter((operation) => operation.meetingId === meeting.meetingId).at(-1);
    const recording = runtime.store?.database.listRecordings(meeting.meetingId)[0];
    const meetingStatus = runtime.store?.getMeeting(meeting.meetingId)?.status;
    const success = stopped.state === "COMPLETED" &&
      meetingStatus === "PROCESSING" &&
      journal?.state === "COMMITTED" &&
      recording?.finalStatus === "COMMITTED" &&
      recording.meetingId === meeting.meetingId &&
      recording.sha256 === stopped.sha256 &&
      file.size > 0 &&
      (stream.chunkCount ?? 0) > 0 &&
      (stream.jpegFrames ?? 0) > 0 &&
      stream.firstSequence === 0 &&
      stream.lastSequence === (stream.chunkCount ?? 0) - 1;
    const result: WindowsRuntimeWindowCaptureCaseResult = {
      capability: "WINDOW",
      success,
      sourceId: source.sourceId,
      format: stopped.format,
      mimeType: stopped.mimeType,
      chunkCount: stream.chunkCount,
      firstSequence: stream.firstSequence,
      lastSequence: stream.lastSequence,
      totalBytes: file.size,
      sha256: stopped.sha256,
      recordingId: recording?.recordingId,
      meetingId: meeting.meetingId,
      captureId: started.captureId,
      meetingStatus,
      artifactJournalState: journal?.state,
      sqliteRecordingStatus: recording?.finalStatus,
      finalArtifactExists: true,
      finalArtifactSize: file.size,
      jpegFrames: stream.jpegFrames,
    };
    addOptional(result, "sourceLabel", source.label);
    addOptional(result, "frameWidth", stream.width);
    addOptional(result, "frameHeight", stream.height);
    if (!success) {
      result.failureCode = "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE";
      result.failureMessage = stream.chunkCount === 0
        ? `Windows Graphics Capture produced no frames for window "${source.label ?? source.sourceId}" (${source.sourceId}); it may be minimized, protected (DRM), or otherwise ineligible. Window verification never falls back to SCREEN capture.`
        : "Capture completed but journal, metadata, or JPEG frame checks failed.";
    }
    return result;
  } catch (error: unknown) {
    const state = error instanceof NativeCaptureError ? error.state : undefined;
    return {
      capability: "WINDOW",
      success: false,
      meetingId: meeting.meetingId,
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_STREAM_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
      ...(state === undefined ? {} : { nativeCaptureState: state }),
    };
  }
}

function stopFailureResult(
  meetingId: string,
  captureId: string,
  source: NativeCaptureSourceDescriptor,
  error: unknown,
): WindowsRuntimeWindowCaptureCaseResult {
  const message = error instanceof Error ? error.message : String(error);
  const failureCode = error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_STREAM_FAILED";
  const state = error instanceof NativeCaptureError ? error.state : undefined;
  if (message.includes("empty recording capture")) {
    return {
      capability: "WINDOW",
      success: false,
      meetingId,
      captureId,
      failureCode: "NATIVE_CAPTURE_STREAM_FAILED",
      failureMessage: `Windows Graphics Capture produced no frames for window "${source.label ?? source.sourceId}" (${source.sourceId}); the window may be minimized, protected (DRM), or otherwise ineligible. Window verification never falls back to SCREEN capture. Restore or switch to an ordinary visible window and re-run.`,
      ...(state === undefined ? {} : { nativeCaptureState: state }),
    };
  }
  return {
    capability: "WINDOW",
    success: false,
    meetingId,
    captureId,
    failureCode,
    failureMessage: `Windows Graphics Capture failed for window "${source.label ?? source.sourceId}" (${source.sourceId}): ${message}`,
    ...(state === undefined ? {} : { nativeCaptureState: state }),
  };
}

function inspectJsonl(text: string): { chunkCount?: number; firstSequence?: number; lastSequence?: number; width?: number; height?: number; jpegFrames?: number } {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  let chunkCount = 0;
  let jpegFrames = 0;
  let firstSequence: number | undefined;
  let lastSequence: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const record = value as {
      recordType?: unknown;
      sequence?: unknown;
      dataBase64?: unknown;
      format?: { width?: unknown; height?: unknown; encoding?: unknown };
    };
    if (record.recordType === "format" && record.format !== undefined) {
      if (typeof record.format.width === "number") width = record.format.width;
      if (typeof record.format.height === "number") height = record.format.height;
    }
    if (record.recordType === "chunk" && typeof record.sequence === "number") {
      if (firstSequence === undefined) firstSequence = record.sequence;
      lastSequence = record.sequence;
      chunkCount += 1;
      if (typeof record.dataBase64 === "string") {
        const bytes = Buffer.from(record.dataBase64, "base64");
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
          jpegFrames += 1;
        }
      }
    }
  }
  return { chunkCount, firstSequence, lastSequence, width, height, jpegFrames };
}

function windowSourceOrder(sourceId: string): number {
  const digits = sourceId.startsWith("hwnd:") ? sourceId.slice("hwnd:".length) : sourceId;
  const numeric = Number.parseInt(digits, 16);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
