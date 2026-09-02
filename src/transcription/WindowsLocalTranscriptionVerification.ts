import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { encodeAiwpcm, loadSpeechFixtureWav, speechFixtureToWasapiPcm, WHISPER_SPEECH_FIXTURE_RELATIVE } from "./SpeechFixture";
import { TranscriptionError } from "./TranscriptionEngine";
import { discoverWhisperRuntime } from "./WhisperRuntimeDiscovery";
import { WindowsLocalWhisperEngine } from "./WindowsLocalWhisperEngine";

export interface WindowsLocalTranscriptionVerificationResult {
  success: boolean;
  windowsVerified: boolean;
  platform: NodeJS.Platform | string;
  helperFound: boolean;
  modelFound: boolean;
  helperName?: string;
  modelName?: string;
  modelPath?: string;
  modelSha256?: string;
  engineVersion?: string;
  audioFixture: string;
  audioFormat: "48000Hz-2ch-32bit";
  transcriptionStarted: boolean;
  transcriptionCompleted: boolean;
  recognizedText?: string;
  transcriptArtifact?: string;
  artifactSha256?: string;
  sqliteStatus?: string;
  journalStatus?: string;
  meetingStatus?: string;
  isolatedWorkspace: true;
  userDataUntouched: true;
  cloudServiceUsed: false;
  failureCode?: string;
  failureMessage?: string;
}

export interface WindowsLocalTranscriptionVerificationOptions {
  keepWorkspace?: boolean;
  repoRoot?: string;
  platform?: NodeJS.Platform | string;
}

/**
 * Windows-only real whisper.cpp verification using a spoken WAV fixture rebuilt
 * as 48 kHz / 2 ch / 32-bit AIWPCM. Off Windows it fail-closes.
 */
export async function runWindowsLocalTranscriptionVerification(
  options: WindowsLocalTranscriptionVerificationOptions = {},
): Promise<WindowsLocalTranscriptionVerificationResult> {
  const discovery = await discoverWhisperRuntime({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const base: WindowsLocalTranscriptionVerificationResult = {
    success: false,
    windowsVerified: false,
    platform: discovery.platform,
    helperFound: discovery.helperFound,
    modelFound: discovery.modelFound,
    audioFixture: WHISPER_SPEECH_FIXTURE_RELATIVE,
    audioFormat: "48000Hz-2ch-32bit",
    transcriptionStarted: false,
    transcriptionCompleted: false,
    isolatedWorkspace: true,
    userDataUntouched: true,
    cloudServiceUsed: false,
  };
  addOptional(base, "helperName", discovery.helperName);
  addOptional(base, "modelName", discovery.modelName);
  addOptional(base, "modelPath", discovery.relativeModelLocation);
  addOptional(base, "modelSha256", discovery.modelSha256);
  addOptional(base, "engineVersion", discovery.engineVersion);

  if (discovery.platform !== "win32" || !discovery.helperFound || !discovery.modelFound) {
    addOptional(base, "failureCode", discovery.failureCode ?? "TRANSCRIPTION_ENGINE_UNAVAILABLE");
    addOptional(base, "failureMessage", discovery.failureMessage ?? "whisper.cpp runtime is unavailable.");
    return base;
  }

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase7c-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-phase7c-verify-data-"));
  const runtime = new StorageRuntime(
    new StorageConfigService(join(appConfigRoot, "storage-config.json")),
    () => new Date(),
    undefined,
    { spaceSafetyMarginBytes: 0 },
    { transcriptionEngine: new WindowsLocalWhisperEngine() },
  );
  try {
    await runtime.configureFirstRun(dataRoot);
    const meeting = await runtime.store?.createMeeting({ title: "Phase 7C whisper verify", meetingDate: "2026-09-02" });
    if (meeting === undefined || runtime.store === undefined) {
      addOptional(base, "failureCode", "TRANSCRIPTION_ENGINE_FAILED");
      addOptional(base, "failureMessage", "Verification could not create a meeting.");
      return base;
    }
    const wav = await loadSpeechFixtureWav(options.repoRoot);
    const wasapi = speechFixtureToWasapiPcm(wav);
    await runtime.store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "aiwpcm",
      mimeType: "application/x-ai-workmate-pcm-jsonl",
      contents: encodeAiwpcm(wasapi.pcm, wasapi.format),
    });
    const recording = runtime.store.database.listRecordings(meeting.meetingId)[0];
    if (recording === undefined) {
      addOptional(base, "failureCode", "TRANSCRIPTION_RECORDING_NOT_FOUND");
      addOptional(base, "failureMessage", "Verification recording was not indexed.");
      return base;
    }
    base.transcriptionStarted = true;
    const saved = await runtime.transcribeRecording(meeting.meetingId, recording.recordingId);
    base.transcriptionCompleted = true;
    const document = await runtime.store.storage.readJson<{ segments?: Array<{ text?: string }> }>(saved.relativePath);
    const recognizedText = (document.segments ?? []).map((segment) => segment.text ?? "").join(" ").trim();
    const meetingStatus = runtime.store.getMeeting(meeting.meetingId)?.status;
    const journal = runtime.store.database.listArtifactOperations().filter((operation) => operation.artifactType.startsWith("TRANSCRIPT_")).at(-1);
    const transcripts = runtime.store.database.listTranscripts(meeting.meetingId);
    const insideDataRoot = saved.relativePath.startsWith("Meetings/") && !saved.relativePath.includes("..");
    const hasSpeech = /[A-Za-z]{3,}/.test(recognizedText);
    const success = meetingStatus === "COMPLETED" &&
      journal?.state === "COMMITTED" &&
      transcripts.length === 1 &&
      transcripts[0]?.recordingId === recording.recordingId &&
      saved.sha256.length === 64 &&
      insideDataRoot &&
      hasSpeech;
    base.success = success;
    base.windowsVerified = success;
    addOptional(base, "recognizedText", recognizedText);
    addOptional(base, "transcriptArtifact", saved.relativePath.replace(/\\/g, "/").split("/").slice(-2).join("/"));
    addOptional(base, "artifactSha256", saved.sha256);
    addOptional(base, "sqliteStatus", transcripts[0] === undefined ? undefined : "COMMITTED");
    addOptional(base, "journalStatus", journal?.state);
    addOptional(base, "meetingStatus", meetingStatus);
    if (!success) {
      addOptional(base, "failureCode", "TRANSCRIPTION_ENGINE_FAILED");
      addOptional(base, "failureMessage", hasSpeech
        ? "Transcript was not committed with COMPLETED lifecycle."
        : "whisper.cpp did not return recognizable speech text.");
    }
    return base;
  } catch (error: unknown) {
    addOptional(base, "failureCode", error instanceof TranscriptionError ? error.code : "TRANSCRIPTION_ENGINE_FAILED");
    addOptional(base, "failureMessage", error instanceof Error ? error.message : String(error));
    return base;
  } finally {
    await runtime.close();
    if (options.keepWorkspace !== true) {
      await rm(appConfigRoot, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
