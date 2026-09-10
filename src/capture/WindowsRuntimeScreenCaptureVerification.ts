import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NativeCaptureError, type NativeCaptureKind } from "./NativeCaptureAdapter";
import {
  WINDOWS_SCREEN_CAPTURE_FORMAT,
  WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
  resolveWindowsScreenHelperPath,
} from "./WindowsNativeScreenProvider";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { removeDirectoryAfterSqliteClose } from "../storage/sqlite-lifecycle";

export const WINDOWS_RUNTIME_SCREEN_CAPTURE_VERIFY_DURATION_MS = 3_000;

export interface WindowsRuntimeScreenCaptureCaseResult {
  capability: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">;
  success: boolean;
  sourceLabel?: string;
  sourceIsDefault?: boolean;
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
}

export interface WindowsRuntimeScreenCaptureVerificationResult {
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
  capture?: WindowsRuntimeScreenCaptureCaseResult;
  enumeratedDisplays?: number;
  enumeratedWindows?: number;
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsRuntimeScreenCaptureVerificationOptions {
  durationMs?: number;
  keepWorkspace?: boolean;
  /** Injected so unit tests can pin the fail-closed off-Windows contract. */
  platform?: NodeJS.Platform | string;
}

/**
 * Windows-only production-path verification for DXGI display capture.
 * Isolated temp DATA_ROOT/config. Off Windows it fail-closes.
 */
export async function runWindowsRuntimeScreenCaptureVerification(
  options: WindowsRuntimeScreenCaptureVerificationOptions = {},
): Promise<WindowsRuntimeScreenCaptureVerificationResult> {
  const durationMs = options.durationMs ?? WINDOWS_RUNTIME_SCREEN_CAPTURE_VERIFY_DURATION_MS;
  const platform = options.platform ?? process.platform;
  const helperPath = await resolveWindowsScreenHelperPath();
  const base: Omit<WindowsRuntimeScreenCaptureVerificationResult, "success" | "windowsVerified" | "abort"> = {
    platform,
    helperFound: helperPath !== undefined,
    durationMs,
    isolatedWorkspace: true,
    userDataUntouched: true,
    cloudServiceUsed: false,
  };
  if (helperPath !== undefined) {
    (base as WindowsRuntimeScreenCaptureVerificationResult).helperPath = helperPath;
  }

  if (platform !== "win32") {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort: { success: false, failureCode: "NATIVE_PLATFORM_UNSUPPORTED", failureMessage: `Windows screen capture verification requires win32, not ${platform}.` },
      failureCode: "NATIVE_PLATFORM_UNSUPPORTED",
      failureMessage: `Windows screen capture verification requires win32, not ${platform}.`,
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

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-screen-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-screen-verify-data-"));
  const runtime = new StorageRuntime(new StorageConfigService(join(appConfigRoot, "storage-config.json")));
  let abort: WindowsRuntimeScreenCaptureVerificationResult["abort"] = { success: false };
  let capture: WindowsRuntimeScreenCaptureCaseResult | undefined;
  let enumeratedDisplays = 0;
  let enumeratedWindows = 0;
  try {
    await runtime.configureFirstRun(dataRoot);
    const discovered = await runtime.discoverNativeCaptureCapabilities();
    enumeratedDisplays = discovered.capabilities.SCREEN.sources?.length ?? 0;
    enumeratedWindows = discovered.capabilities.WINDOW.sources?.length ?? 0;
    abort = await verifyAbort(runtime);
    capture = await verifyCapture(runtime, dataRoot, durationMs);
    const completed = abort.success && capture.success && enumeratedDisplays > 0;
    const windowsVerified = completed === true && durationMs >= WINDOWS_RUNTIME_SCREEN_CAPTURE_VERIFY_DURATION_MS;
    return {
      ...base,
      success: windowsVerified,
      windowsVerified,
      abort,
      capture,
      enumeratedDisplays,
      enumeratedWindows,
      ...(windowsVerified ? {} : { failureCode: "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE", failureMessage: "One or more Windows screen capture checks failed." }),
    };
  } catch (error: unknown) {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort,
      capture,
      enumeratedDisplays,
      enumeratedWindows,
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

async function verifyAbort(runtime: StorageRuntime): Promise<WindowsRuntimeScreenCaptureVerificationResult["abort"]> {
  const meeting = await runtime.store?.createMeeting({ title: "Screen abort verify", meetingDate: "2026-09-03" });
  if (meeting === undefined) {
    return { success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Abort verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const screen = capabilities.capabilities.SCREEN;
    if (!screen.available) {
      return {
        success: false,
        failureCode: screen.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: screen.error?.message ?? "No display is available for abort verification.",
      };
    }
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "SCREEN",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
      ...(defaultSourceId(screen) === undefined ? {} : { sourceId: defaultSourceId(screen) }),
    });
    const aborted = await runtime.abortNativeCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      reason: "screen-capture-abort-verification",
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

async function verifyCapture(runtime: StorageRuntime, dataRoot: string, durationMs: number): Promise<WindowsRuntimeScreenCaptureCaseResult> {
  const meeting = await runtime.store?.createMeeting({ title: "Screen capture verify", meetingDate: "2026-09-03" });
  if (meeting === undefined) {
    return { capability: "SCREEN", success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Capture verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const capabilityInfo = capabilities.capabilities.SCREEN;
    if (!capabilityInfo.available) {
      return {
        capability: "SCREEN",
        success: false,
        meetingId: meeting.meetingId,
        failureCode: capabilityInfo.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: capabilityInfo.error?.message ?? "SCREEN is unavailable.",
      };
    }
    const source = capabilityInfo.sources?.find((item) => item.isDefault === true) ?? capabilityInfo.sources?.[0];
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "SCREEN",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
      ...(source?.sourceId === undefined ? {} : { sourceId: source.sourceId }),
    });
    await wait(durationMs);
    const stopped = await runtime.stopNativeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    const relativePath = stopped.relativePath;
    if (relativePath === undefined) {
      return {
        capability: "SCREEN",
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
    const result: WindowsRuntimeScreenCaptureCaseResult = {
      capability: "SCREEN",
      success,
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
    addOptional(result, "sourceLabel", source?.label);
    addOptional(result, "sourceIsDefault", source?.isDefault);
    addOptional(result, "frameWidth", stream.width);
    addOptional(result, "frameHeight", stream.height);
    if (!success) {
      result.failureCode = "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE";
      result.failureMessage = "Capture completed but journal, metadata, or JPEG frame checks failed.";
    }
    return result;
  } catch (error: unknown) {
    return {
      capability: "SCREEN",
      success: false,
      meetingId: meeting.meetingId,
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_STREAM_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
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

/**
 * Deterministic default-source selection for SCREEN (and by extension the audio
 * device kinds): the capability's isDefault source when present, else the first
 * listed source. Shared so the meeting-capture orchestrator resolves SCREEN and
 * audio sources through the same validated path used by Windows verification.
 */
export function defaultSourceId(capability: { sources?: Array<{ sourceId: string; isDefault?: boolean }> }): string | undefined {
  return capability.sources?.find((source) => source.isDefault === true)?.sourceId ?? capability.sources?.[0]?.sourceId;
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
