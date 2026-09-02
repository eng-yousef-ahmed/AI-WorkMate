import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WINDOWS_AUDIO_CAPTURE_FORMAT,
  WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  resolveWindowsAudioHelperPath,
} from "./WindowsNativeAudioProvider";
import type { NativeCaptureKind } from "./NativeCaptureAdapter";
import { NativeCaptureError } from "./NativeCaptureAdapter";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";

export const WINDOWS_RUNTIME_CAPTURE_VERIFY_DURATION_MS = 3_000;

export interface WindowsRuntimeCaptureCaseResult {
  capability: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">;
  success: boolean;
  sourceLabel?: string;
  sourceIsDefault?: boolean;
  format?: string;
  mimeType?: string;
  pcmSampleRateHz?: number;
  pcmChannels?: number;
  pcmBitsPerSample?: number;
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
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsRuntimeCaptureVerificationResult {
  success: boolean;
  windowsVerified: boolean;
  platform: NodeJS.Platform | string;
  helperPath?: string;
  helperFound: boolean;
  durationMs: number;
  isolatedWorkspace: true;
  userDataUntouched: true;
  abort: {
    success: boolean;
    meetingStatus?: string;
    artifactJournalState?: string;
    sqliteRecordingCount?: number;
    failureCode?: string;
    failureMessage?: string;
  };
  captures: WindowsRuntimeCaptureCaseResult[];
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsRuntimeCaptureVerificationOptions {
  durationMs?: number;
  keepWorkspace?: boolean;
}

/**
 * Windows-only production-path verification. It uses StorageRuntime and the
 * real native helper. Isolated temp DATA_ROOT/config are used so existing user
 * data is never touched. Off Windows it fail-closes without capturing.
 */
export async function runWindowsRuntimeCaptureVerification(
  options: WindowsRuntimeCaptureVerificationOptions = {},
): Promise<WindowsRuntimeCaptureVerificationResult> {
  const durationMs = options.durationMs ?? WINDOWS_RUNTIME_CAPTURE_VERIFY_DURATION_MS;
  const platform = process.platform;
  const helperPath = await resolveWindowsAudioHelperPath();
  const base: Omit<WindowsRuntimeCaptureVerificationResult, "success" | "windowsVerified" | "abort" | "captures"> = {
    platform,
    helperFound: helperPath !== undefined,
    durationMs,
    isolatedWorkspace: true,
    userDataUntouched: true,
  };
  if (helperPath !== undefined) {
    (base as WindowsRuntimeCaptureVerificationResult).helperPath = helperPath;
  }

  if (platform !== "win32") {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort: { success: false, failureCode: "NATIVE_PLATFORM_UNSUPPORTED", failureMessage: `Windows runtime capture verification requires win32, not ${platform}.` },
      captures: [],
      failureCode: "NATIVE_PLATFORM_UNSUPPORTED",
      failureMessage: `Windows runtime capture verification requires win32, not ${platform}.`,
    };
  }
  if (helperPath === undefined) {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort: { success: false, failureCode: "NATIVE_PROVIDER_NOT_CONFIGURED", failureMessage: "Windows native audio helper was not found." },
      captures: [],
      failureCode: "NATIVE_PROVIDER_NOT_CONFIGURED",
      failureMessage: "Windows native audio helper was not found. Run npm run build:native:win first.",
    };
  }

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase6c-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase6c-verify-data-"));
  const runtime = new StorageRuntime(new StorageConfigService(join(appConfigRoot, "storage-config.json")));
  const captures: WindowsRuntimeCaptureCaseResult[] = [];
  let abort: WindowsRuntimeCaptureVerificationResult["abort"] = { success: false };
  try {
    await runtime.configureFirstRun(dataRoot);
    abort = await verifyAbort(runtime);
    captures.push(await verifyCapture(runtime, dataRoot, "MICROPHONE_AUDIO", durationMs));
    captures.push(await verifyCapture(runtime, dataRoot, "SYSTEM_AUDIO", durationMs));
    const success = abort.success && captures.every((capture) => capture.success);
    return {
      ...base,
      success,
      windowsVerified: success,
      abort,
      captures,
      ...(success ? {} : { failureCode: "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE", failureMessage: "One or more Windows runtime capture checks failed." }),
    };
  } catch (error: unknown) {
    return {
      ...base,
      success: false,
      windowsVerified: false,
      abort,
      captures,
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_START_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.close();
    if (options.keepWorkspace !== true) {
      await rm(appConfigRoot, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}

async function verifyAbort(runtime: StorageRuntime): Promise<WindowsRuntimeCaptureVerificationResult["abort"]> {
  const meeting = await runtime.store?.createMeeting({ title: "Phase 6C abort verify", meetingDate: "2026-09-02" });
  if (meeting === undefined) {
    return { success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Abort verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const microphone = capabilities.capabilities.MICROPHONE_AUDIO;
    if (!microphone.available) {
      return {
        success: false,
        failureCode: microphone.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: microphone.error?.message ?? "Microphone is unavailable for abort verification.",
      };
    }
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      ...(defaultSourceId(microphone) === undefined ? {} : { sourceId: defaultSourceId(microphone) }),
    });
    const aborted = await runtime.abortNativeCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      reason: "phase-6c-abort-verification",
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
  capability: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">,
  durationMs: number,
): Promise<WindowsRuntimeCaptureCaseResult> {
  const meeting = await runtime.store?.createMeeting({
    title: capability === "MICROPHONE_AUDIO" ? "Phase 6C microphone verify" : "Phase 6C loopback verify",
    meetingDate: "2026-09-02",
  });
  if (meeting === undefined) {
    return { capability, success: false, failureCode: "NATIVE_CAPTURE_START_FAILED", failureMessage: "Capture verification could not create a meeting." };
  }
  try {
    const capabilities = await runtime.discoverNativeCaptureCapabilities();
    const capabilityInfo = capabilities.capabilities[capability];
    if (!capabilityInfo.available) {
      return {
        capability,
        success: false,
        meetingId: meeting.meetingId,
        failureCode: capabilityInfo.error?.code ?? "NATIVE_CAPABILITY_UNAVAILABLE",
        failureMessage: capabilityInfo.error?.message ?? `${capability} is unavailable.`,
      };
    }
    const source = capabilityInfo.sources?.find((item) => item.isDefault === true) ?? capabilityInfo.sources?.[0];
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability,
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      ...(source?.sourceId === undefined ? {} : { sourceId: source.sourceId }),
    });
    await wait(durationMs);
    const stopped = await runtime.stopNativeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    const relativePath = stopped.relativePath;
    if (relativePath === undefined) {
      return {
        capability,
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
      stream.firstSequence === 0 &&
      stream.lastSequence === (stream.chunkCount ?? 0) - 1;
    const result: WindowsRuntimeCaptureCaseResult = {
      capability,
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
    };
    addOptional(result, "sourceLabel", source?.label);
    addOptional(result, "sourceIsDefault", source?.isDefault);
    addOptional(result, "pcmSampleRateHz", stream.sampleRateHz);
    addOptional(result, "pcmChannels", stream.channels);
    addOptional(result, "pcmBitsPerSample", stream.bitsPerSample);
    if (!success) {
      result.failureCode = "WINDOWS_RUNTIME_CAPTURE_INCOMPLETE";
      result.failureMessage = "Capture completed but journal, metadata, or stream integrity checks failed.";
    }
    return result;
  } catch (error: unknown) {
    return {
      capability,
      success: false,
      meetingId: meeting.meetingId,
      failureCode: error instanceof NativeCaptureError ? error.code : "NATIVE_CAPTURE_STREAM_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectJsonl(text: string): { chunkCount?: number; firstSequence?: number; lastSequence?: number; sampleRateHz?: number; channels?: number; bitsPerSample?: number } {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  let chunkCount = 0;
  let firstSequence: number | undefined;
  let lastSequence: number | undefined;
  let sampleRateHz: number | undefined;
  let channels: number | undefined;
  let bitsPerSample: number | undefined;
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
    const record = value as { recordType?: unknown; sequence?: unknown; format?: { sampleRateHz?: unknown; channels?: unknown; bitsPerSample?: unknown } };
    if (record.recordType === "format" && record.format !== undefined) {
      if (typeof record.format.sampleRateHz === "number") sampleRateHz = record.format.sampleRateHz;
      if (typeof record.format.channels === "number") channels = record.format.channels;
      if (typeof record.format.bitsPerSample === "number") bitsPerSample = record.format.bitsPerSample;
    }
    if (record.recordType === "chunk" && typeof record.sequence === "number") {
      if (firstSequence === undefined) firstSequence = record.sequence;
      lastSequence = record.sequence;
      chunkCount += 1;
    }
  }
  return { chunkCount, firstSequence, lastSequence, sampleRateHz, channels, bitsPerSample };
}

function defaultSourceId(capability: { sources?: Array<{ sourceId: string; isDefault?: boolean }> }): string | undefined {
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
