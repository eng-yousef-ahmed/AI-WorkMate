import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { TranscriptionError } from "./TranscriptionEngine";
import {
  resolveWindowsWhisperCliPath,
  resolveWindowsWhisperModelPath,
  WindowsLocalWhisperEngine,
} from "./WindowsLocalWhisperEngine";

export interface WindowsLocalTranscriptionVerificationResult {
  success: boolean;
  windowsVerified: boolean;
  platform: NodeJS.Platform | string;
  helperFound: boolean;
  modelFound: boolean;
  isolatedWorkspace: true;
  userDataUntouched: true;
  cloudContacted: false;
  meetingStatus?: string;
  artifactJournalState?: string;
  transcriptSha256?: string;
  recordingSha256?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsLocalTranscriptionVerificationOptions {
  keepWorkspace?: boolean;
}

/**
 * Windows-only production-path check. Off Windows, or without whisper.cpp +
 * ggml model, it fail-closes and never claims WINDOWS-VERIFIED.
 */
export async function runWindowsLocalTranscriptionVerification(
  options: WindowsLocalTranscriptionVerificationOptions = {},
): Promise<WindowsLocalTranscriptionVerificationResult> {
  const platform = process.platform;
  const helperPath = await resolveWindowsWhisperCliPath();
  const modelPath = await resolveWindowsWhisperModelPath();
  const base: WindowsLocalTranscriptionVerificationResult = {
    success: false,
    windowsVerified: false,
    platform,
    helperFound: helperPath !== undefined,
    modelFound: modelPath !== undefined,
    isolatedWorkspace: true,
    userDataUntouched: true,
    cloudContacted: false,
  };
  if (platform !== "win32") {
    return {
      ...base,
      failureCode: "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      failureMessage: `Windows local transcription verification requires win32, not ${platform}.`,
    };
  }
  if (helperPath === undefined || modelPath === undefined) {
    return {
      ...base,
      failureCode: "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      failureMessage: "whisper.cpp CLI or local ggml/gguf model was not found under %LOCALAPPDATA%\\AI-WorkMate.",
    };
  }

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase7b-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase7b-verify-data-"));
  const runtime = new StorageRuntime(
    new StorageConfigService(join(appConfigRoot, "storage-config.json")),
    () => new Date(),
    undefined,
    { spaceSafetyMarginBytes: 0 },
    { transcriptionEngine: new WindowsLocalWhisperEngine() },
  );
  try {
    await runtime.configureFirstRun(dataRoot);
    const meeting = await runtime.store?.createMeeting({ title: "Phase 7B whisper verify", meetingDate: "2026-09-02" });
    if (meeting === undefined || runtime.store === undefined) {
      return { ...base, failureCode: "TRANSCRIPTION_ENGINE_FAILED", failureMessage: "Verification could not create a meeting." };
    }
    const pcm = Buffer.alloc(32_000, 0);
    const format = {
      container: "AIWPCM_JSONL",
      encoding: "PCM",
      sampleRateHz: 16_000,
      channels: 1,
      bitsPerSample: 16,
      blockAlign: 2,
      averageBytesPerSecond: 32_000,
    };
    const chunkSha = createHash("sha256").update(pcm).digest("hex");
    const jsonl = `${JSON.stringify({
      recordType: "format",
      source: "MICROPHONE_AUDIO",
      startedAt: "2026-09-02T10:00:00.000Z",
      format,
    })}\n${JSON.stringify({
      recordType: "chunk",
      sequence: 0,
      timestamp: "2026-09-02T10:00:01.000Z",
      source: "MICROPHONE_AUDIO",
      format,
      byteLength: pcm.byteLength,
      sha256: chunkSha,
      dataBase64: pcm.toString("base64"),
    })}\n`;
    const artifact = await runtime.store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "aiwpcm",
      mimeType: "application/x-ai-workmate-pcm-jsonl",
      contents: Buffer.from(jsonl, "utf8"),
    });
    const recording = runtime.store.database.listRecordings(meeting.meetingId)[0];
    if (recording === undefined) {
      return { ...base, failureCode: "TRANSCRIPTION_RECORDING_NOT_FOUND", failureMessage: "Verification recording was not indexed." };
    }
    const saved = await runtime.transcribeRecording(meeting.meetingId, recording.recordingId);
    const meetingStatus = runtime.store.getMeeting(meeting.meetingId)?.status;
    const journal = runtime.store.database.listArtifactOperations().filter((operation) => operation.artifactType.startsWith("TRANSCRIPT_")).at(-1);
    const transcripts = runtime.store.database.listTranscripts(meeting.meetingId);
    const success = meetingStatus === "COMPLETED" &&
      journal?.state === "COMMITTED" &&
      transcripts.length === 1 &&
      transcripts[0]?.recordingId === recording.recordingId &&
      saved.sha256.length === 64;
    return {
      ...base,
      success,
      windowsVerified: success,
      meetingStatus,
      artifactJournalState: journal?.state,
      transcriptSha256: saved.sha256,
      recordingSha256: artifact.sha256,
      ...(success ? {} : { failureCode: "TRANSCRIPTION_ENGINE_FAILED", failureMessage: "Transcript was not committed with COMPLETED lifecycle." }),
    };
  } catch (error: unknown) {
    return {
      ...base,
      failureCode: error instanceof TranscriptionError ? error.code : "TRANSCRIPTION_ENGINE_FAILED",
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
