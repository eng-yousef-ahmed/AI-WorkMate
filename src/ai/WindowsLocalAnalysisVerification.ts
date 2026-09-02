import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptDocument } from "../domain/models";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { ANALYSIS_TRANSCRIPT_FIXTURE_RELATIVE, loadAnalysisTranscriptFixture } from "./AnalysisTranscriptFixture";
import { LocalLlmError } from "./LocalLlmErrors";
import { LocalLlmProvider } from "./LocalLlmProvider";
import { discoverLocalLlmRuntime } from "./LocalLlmRuntimeDiscovery";

export interface WindowsLocalAnalysisVerificationResult {
  success: boolean;
  windowsVerified: boolean;
  realAiVerified: boolean;
  platform: NodeJS.Platform | string;
  helperFound: boolean;
  modelFound: boolean;
  helperName?: string;
  modelName?: string;
  modelPath?: string;
  modelSha256?: string;
  engineVersion?: string;
  transcriptFixture: string;
  analysisStarted: boolean;
  analysisCompleted: boolean;
  summaryText?: string;
  decisionText?: string;
  taskText?: string;
  analysisArtifact?: string;
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

export interface WindowsLocalAnalysisVerificationOptions {
  keepWorkspace?: boolean;
  repoRoot?: string;
  platform?: NodeJS.Platform | string;
}

/**
 * Windows-only real llama.cpp analysis verification using a meeting transcript
 * fixture. Off Windows it fail-closes and never fabricates analysis text.
 */
export async function runWindowsLocalAnalysisVerification(
  options: WindowsLocalAnalysisVerificationOptions = {},
): Promise<WindowsLocalAnalysisVerificationResult> {
  const discovery = await discoverLocalLlmRuntime({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const base: WindowsLocalAnalysisVerificationResult = {
    success: false,
    windowsVerified: false,
    realAiVerified: false,
    platform: discovery.platform,
    helperFound: discovery.helperFound,
    modelFound: discovery.modelFound,
    transcriptFixture: ANALYSIS_TRANSCRIPT_FIXTURE_RELATIVE,
    analysisStarted: false,
    analysisCompleted: false,
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
    addOptional(base, "failureCode", discovery.failureCode ?? "ANALYSIS_ENGINE_UNAVAILABLE");
    addOptional(base, "failureMessage", discovery.failureMessage ?? "llama.cpp runtime is unavailable.");
    return base;
  }

  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-local-ai-verify-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-local-ai-verify-data-"));
  const runtime = new StorageRuntime(
    new StorageConfigService(join(appConfigRoot, "storage-config.json")),
    () => new Date(),
    undefined,
    { spaceSafetyMarginBytes: 0 },
    { analysisProvider: new LocalLlmProvider() },
  );
  try {
    await runtime.configureFirstRun(dataRoot);
    await runtime.setAiProcessingPolicy("LOCAL_ONLY");
    const meeting = await runtime.store?.createMeeting({ title: "Phase local LLM verify", meetingDate: "2026-09-02" });
    if (meeting === undefined || runtime.store === undefined) {
      addOptional(base, "failureCode", "ANALYSIS_ENGINE_FAILED");
      addOptional(base, "failureMessage", "Verification could not create a meeting.");
      return base;
    }
    await runtime.store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "aiwpcm",
      mimeType: "application/x-ai-workmate-pcm-jsonl",
      contents: placeholderRecordingBytes(),
    });
    const recording = runtime.store.database.listRecordings(meeting.meetingId)[0];
    if (recording === undefined) {
      addOptional(base, "failureCode", "ANALYSIS_ENGINE_FAILED");
      addOptional(base, "failureMessage", "Verification recording was not indexed.");
      return base;
    }
    const fixture = await loadAnalysisTranscriptFixture(options.repoRoot);
    const document: TranscriptDocument = {
      ...fixture,
      meetingId: meeting.meetingId,
      recordingId: recording.recordingId,
      createdAt: "2026-09-02T11:00:00.000Z",
    };
    await runtime.store.saveTranscript(document, { recordingId: recording.recordingId, engineId: "fixture-transcript" });
    base.analysisStarted = true;
    const saved = await runtime.analyzeCommittedTranscript(meeting.meetingId, recording.recordingId);
    base.analysisCompleted = true;
    const meetingStatus = runtime.store.getMeeting(meeting.meetingId)?.status;
    const journal = runtime.store.database.listArtifactOperations().filter((operation) => operation.artifactType.startsWith("ANALYSIS_")).at(-1);
    const analyses = runtime.store.database.listAnalysis(meeting.meetingId);
    const insideDataRoot = saved.relativePath.startsWith("Meetings/") && !saved.relativePath.includes("..");
    const summaryHasSpeech = /[A-Za-z]{3,}/.test(saved.analysis.summary);
    const success = meetingStatus === "COMPLETED" &&
      journal?.state === "COMMITTED" &&
      analyses.length === 7 &&
      saved.sha256.length === 64 &&
      insideDataRoot &&
      summaryHasSpeech &&
      saved.analysis.meetingId === meeting.meetingId;
    base.success = success;
    base.windowsVerified = success;
    base.realAiVerified = success;
    addOptional(base, "summaryText", saved.analysis.summary);
    addOptional(base, "decisionText", saved.analysis.decisions[0]?.text);
    addOptional(base, "taskText", saved.analysis.tasks[0]?.text);
    addOptional(base, "analysisArtifact", saved.relativePath.replace(/\\/g, "/").split("/").slice(-2).join("/"));
    addOptional(base, "artifactSha256", saved.sha256);
    addOptional(base, "sqliteStatus", analyses.length === 0 ? undefined : "COMMITTED");
    addOptional(base, "journalStatus", journal?.state);
    addOptional(base, "meetingStatus", meetingStatus);
    if (!success) {
      addOptional(base, "failureCode", "ANALYSIS_ENGINE_FAILED");
      addOptional(base, "failureMessage", summaryHasSpeech
        ? "Analysis was not committed with COMPLETED lifecycle."
        : "llama.cpp did not return recognizable analysis text.");
    }
    return base;
  } catch (error: unknown) {
    addOptional(base, "failureCode", error instanceof LocalLlmError ? error.code : "ANALYSIS_ENGINE_FAILED");
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

function placeholderRecordingBytes(): Buffer {
  const pcm = Buffer.alloc(8, 1);
  const format = {
    container: "AIWPCM_JSONL",
    encoding: "PCM",
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
    averageBytesPerSecond: 32_000,
  };
  return Buffer.from(`${JSON.stringify({ recordType: "format", source: "MICROPHONE_AUDIO", startedAt: "2026-09-02T10:00:00.000Z", format })}\n${JSON.stringify({
    recordType: "chunk",
    sequence: 0,
    timestamp: "2026-09-02T10:00:01.000Z",
    source: "MICROPHONE_AUDIO",
    format,
    byteLength: pcm.byteLength,
    sha256: createHash("sha256").update(pcm).digest("hex"),
    dataBase64: pcm.toString("base64"),
  })}\n`, "utf8");
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
