import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { LocalFirstStore } from "../storage/LocalFirstStore";
import { removeDirectoryAfterSqliteClose } from "../storage/sqlite-lifecycle";
import { LocalRecordingCaptureEngine } from "../capture/LocalRecordingCaptureEngine";
import { MeetingCaptureOrchestrator } from "../capture/MeetingCaptureOrchestrator";
import type { MeetingCaptureFlowSnapshot, MeetingCaptureSourceSnapshot } from "../capture/MeetingCaptureOrchestrator";
import { NativeCaptureCoordinator } from "../capture/NativeCaptureCoordinator";
import { createNativeCaptureAdapter } from "../capture/WindowsCaptureAdapter";
import { WindowsLocalWhisperEngine } from "../transcription/WindowsLocalWhisperEngine";
import { LocalLlmProvider } from "../ai/LocalLlmProvider";
import { MeetingTranscriptionOrchestrator } from "./MeetingTranscriptionOrchestrator";
import { buildUnifiedTranscriptDocument } from "./sourceAttribution";
import { createSecureRendererPreferences } from "../desktop/window-security";
import { discoverWhisperRuntime } from "../transcription/WhisperRuntimeDiscovery";
import type { WhisperRuntimeDiscovery } from "../transcription/WhisperRuntimeDiscovery";
import { discoverLocalLlmRuntime } from "../ai/LocalLlmRuntimeDiscovery";
import type { LocalLlmRuntimeDiscovery } from "../ai/LocalLlmRuntimeDiscovery";
import { PRODUCTION_LOCAL_LLM_MODEL_ID } from "../ai/LocalLlmRuntimeCatalog";
import { evaluateAnalysisQuality } from "../ai/AnalysisQuality";
import type { TranscriptDocument, AnalysisDocument } from "../domain/models";
import type { TranscriptRecord } from "../storage/LocalDatabase";
import {
  VerificationPlaybackError,
  playWavThroughDefaultOutput,
  readWavPcmDuration,
  waitForDuration,
} from "./VerifySpeechPlayback";

/**
 * Phase 9 unified meeting-processing verifier (Windows-only pipeline).
 *
 * Unlike the earlier version of this verifier, every reported flag reflects a
 * real observation: the Whisper and llama.cpp runtimes are probed with the
 * existing discovery helpers before anything runs, capture sources, transcript
 * and analysis counts are read back from SQLite after each stage, and no
 * success flag is ever hardcoded. The quality evaluator is used unchanged.
 *
 * The deterministic speech input is the committed spoken WAV fixture whose
 * script contains the analysis quality corpus vocabulary. The WAV is played
 * through the real Windows default output device during a real Phase 8 capture
 * flow, so both recordings are real: the system loopback records the played
 * speech and the microphone records it acoustically. Nothing is copied into
 * recording artifacts and no transcript text is injected.
 */

export const MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE = "tests/fixtures/meeting-processing-speech.wav";
export const MEETING_PROCESSING_SPEECH_SCRIPT_FIXTURE_RELATIVE = "tests/fixtures/meeting-processing-speech.txt";
const WHISPER_ENGINE_ID = "windows-local-whisper";
const PLAYBACK_TAIL_MS = 750;
const PLAYBACK_START_SLACK_MS = 45_000;

export type MeetingProcessingVerificationStage =
  | "runtime-discovery"
  | "platform-gate"
  | "workspace"
  | "capture-start"
  | "playback"
  | "capture-stop"
  | "processing"
  | "artifact-verification"
  | "completed";

export interface MeetingProcessingCaptureSourceStatus {
  kind: string;
  capability: string;
  state: string;
  journalState: string;
  bytesWritten: number;
  sha256?: string;
  artifactCommitted: boolean;
  error?: { code: string; message: string };
}

export interface MeetingProcessingTranscriptDetail {
  capability: string;
  transcriptId: string;
  recordingId?: string;
  engineId?: string;
  sourceSha256?: string;
  sourceSha256MatchesRecording: boolean;
  jsonArtifact: string;
  artifactSha256Verified: boolean;
}

export interface MeetingProcessingAnalysisDetail {
  rows: number;
  kinds: string[];
  summaryArtifact: string;
  artifactsShaVerified: number;
  journalState: string;
  sourceTranscriptIds?: string;
  sourceTranscriptShas?: string;
}

export interface MeetingProcessingVerificationResult {
  platform: string;
  nativeRuntime: "real" | "none";
  windowsVerified: boolean;
  success: boolean;
  stage: string;
  meetingId?: string;
  meetingStatus?: string;
  sqliteStatus: string;
  journalStatus: string;
  realEngineFound: boolean;
  realModelFound: boolean;
  llmEngineFound: boolean;
  llmModelFound: boolean;
  llmModelIsProductionQwen7B: boolean;
  runtime: {
    whisper: WhisperRuntimeDiscovery;
    llm: LocalLlmRuntimeDiscovery;
  };
  speechFixture: {
    wav: string;
    script: string;
    durationMs?: number;
    sampleRateHz?: number;
    channels?: number;
    bitsPerSample?: number;
  };
  playback: {
    started: boolean;
    completed: boolean;
    playedMs?: number;
    captureTailMs: number;
  };
  capture: {
    requested: string[];
    sources: MeetingProcessingCaptureSourceStatus[];
  };
  cloudServiceUsed: false;
  isolatedWorkspace: true;
  userDataUntouched: boolean;
  rendererIsolation: { contextIsolation: boolean; sandbox: boolean };
  transcriptsCreated: number;
  transcriptDetails: MeetingProcessingTranscriptDetail[];
  analysisCreated: boolean;
  analysisDetail?: MeetingProcessingAnalysisDetail;
  qualityAcceptable: boolean;
  qualityReasons?: string[];
  workspace?: { kept: boolean; directoryName: string };
  failureCode?: string;
  failureMessage?: string;
}

export interface MeetingProcessingVerificationOptions {
  keepWorkspace?: boolean;
  repoRoot?: string;
  platform?: NodeJS.Platform | string;
  playbackTailMs?: number;
}

interface VerificationProgress {
  stage: MeetingProcessingVerificationStage;
  whisper?: WhisperRuntimeDiscovery;
  llm?: LocalLlmRuntimeDiscovery;
  meetingId?: string;
  meetingStatus?: string;
  sources: MeetingProcessingCaptureSourceStatus[];
  transcriptsCreated: number;
  transcriptDetails: MeetingProcessingTranscriptDetail[];
  analysisCreated: boolean;
  analysisDetail?: MeetingProcessingAnalysisDetail;
  qualityAcceptable: boolean;
  qualityReasons?: string[];
  playbackStarted: boolean;
  playbackCompleted: boolean;
  playbackPlayedMs?: number;
  sqliteStatus: string;
  journalStatus: string;
  userDataUntouched: boolean;
  speechFixtureDuration?: WavFixtureFacts;
}

interface WavFixtureFacts {
  durationMs: number;
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
}

export async function runMeetingProcessingVerification(
  options: MeetingProcessingVerificationOptions = {},
): Promise<MeetingProcessingVerificationResult> {
  const platform = options.platform ?? process.platform;
  const repoRoot = options.repoRoot ?? process.cwd();
  const playbackTailMs = options.playbackTailMs ?? PLAYBACK_TAIL_MS;
  const progress: VerificationProgress = {
    stage: "runtime-discovery",
    sources: [],
    transcriptsCreated: 0,
    transcriptDetails: [],
    analysisCreated: false,
    qualityAcceptable: false,
    playbackStarted: false,
    playbackCompleted: false,
    sqliteStatus: "UNKNOWN",
    journalStatus: "UNKNOWN",
    userDataUntouched: true,
  };
  let root: string | undefined;
  let store: LocalFirstStore | undefined;
  let outcome: MeetingProcessingVerificationResult | undefined;
  try {
    // 1. Discover the REAL runtimes first and report them honestly.
    const whisper = await discoverWhisperRuntime({ platform });
    const llm = await discoverLocalLlmRuntime({ platform });
    progress.whisper = whisper;
    progress.llm = llm;
    const realEngineFound = whisper.helperFound;
    const realModelFound = whisper.modelFound;
    const llmEngineFound = llm.helperFound;
    const llmModelFound = llm.modelFound;
    const llmModelIsProduction = llm.modelFound && llm.selectedModelId === PRODUCTION_LOCAL_LLM_MODEL_ID;

    const build = (success: boolean, failure?: { code: string; message: string }): MeetingProcessingVerificationResult => ({
      platform,
      nativeRuntime: platform === "win32" && realEngineFound && realModelFound && llmEngineFound && llmModelFound ? "real" : "none",
      windowsVerified: success,
      success,
      stage: progress.stage,
      ...(progress.meetingId === undefined ? {} : { meetingId: progress.meetingId }),
      ...(progress.meetingStatus === undefined ? {} : { meetingStatus: progress.meetingStatus }),
      sqliteStatus: progress.sqliteStatus,
      journalStatus: progress.journalStatus,
      realEngineFound,
      realModelFound,
      llmEngineFound,
      llmModelFound,
      llmModelIsProductionQwen7B: llmModelIsProduction,
      runtime: { whisper, llm },
      speechFixture: {
        wav: MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE,
        script: MEETING_PROCESSING_SPEECH_SCRIPT_FIXTURE_RELATIVE,
        ...(progress.speechFixtureDuration === undefined ? {} : { durationMs: progress.speechFixtureDuration.durationMs }),
        ...(progress.speechFixtureDuration === undefined ? {} : { sampleRateHz: progress.speechFixtureDuration.sampleRateHz }),
        ...(progress.speechFixtureDuration === undefined ? {} : { channels: progress.speechFixtureDuration.channels }),
        ...(progress.speechFixtureDuration === undefined ? {} : { bitsPerSample: progress.speechFixtureDuration.bitsPerSample }),
      },
      playback: {
        started: progress.playbackStarted,
        completed: progress.playbackCompleted,
        ...(progress.playbackPlayedMs === undefined ? {} : { playedMs: progress.playbackPlayedMs }),
        captureTailMs: playbackTailMs,
      },
      capture: {
        requested: ["MICROPHONE_AUDIO", "SYSTEM_AUDIO"],
        sources: progress.sources,
      },
      cloudServiceUsed: false,
      isolatedWorkspace: true,
      userDataUntouched: progress.userDataUntouched,
      rendererIsolation: rendererIsolation(),
      transcriptsCreated: progress.transcriptsCreated,
      transcriptDetails: progress.transcriptDetails,
      analysisCreated: progress.analysisCreated,
      ...(progress.analysisDetail === undefined ? {} : { analysisDetail: progress.analysisDetail }),
      qualityAcceptable: progress.qualityAcceptable,
      ...(progress.qualityReasons === undefined ? {} : { qualityReasons: progress.qualityReasons }),
      ...(failure === undefined ? {} : { failureCode: failure.code, failureMessage: failure.message }),
    });
    const fail = (code: string, message: string): MeetingProcessingVerificationResult => build(false, { code, message: sanitizeText(message, root, repoRoot) });

    // 2. Fail closed off Windows (after honest discovery so the report is truthful).
    if (platform !== "win32") {
      progress.stage = "platform-gate";
      return fail(
        "MEETING_PROCESSING_VERIFY_PLATFORM_UNSUPPORTED",
        "The unified meeting processing verifier runs the real local Whisper and Qwen models on Windows. On this platform it fail-closes without executing the pipeline.",
      );
    }

    // 3. Fail closed unless the real runtimes and the production Qwen 7B model are present.
    if (!realEngineFound || !realModelFound || progress.whisper.modelChecksumOk === false) {
      return fail(
        "MEETING_PROCESSING_VERIFY_WHISPER_RUNTIME_UNAVAILABLE",
        progress.whisper.failureMessage ?? "whisper.cpp runtime or model was not found under the managed LocalAppData locations.",
      );
    }
    if (!llmEngineFound || !llmModelFound || progress.llm.modelChecksumOk === false) {
      return fail(
        "MEETING_PROCESSING_VERIFY_LLM_RUNTIME_UNAVAILABLE",
        progress.llm.failureMessage ?? "llama.cpp runtime or model was not found under the managed LocalAppData locations.",
      );
    }
    if (!llmModelIsProduction) {
      return fail(
        "MEETING_PROCESSING_VERIFY_LLM_MODEL_NOT_PRODUCTION",
        `The production model ${PRODUCTION_LOCAL_LLM_MODEL_ID} is required; discovery selected ${progress.llm.selectedModelId ?? "no catalogued model"}.`,
      );
    }

    // 4. Isolated temporary DATA_ROOT; the user's DATA_ROOT is never touched.
    progress.stage = "workspace";
    root = await mkdtemp(join(tmpdir(), "ai-workmate-meeting-processing-verify-"));
    store = new LocalFirstStore(root);
    await store.initialize();

    const fixturePath = join(repoRoot, MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE);
    try {
      progress.speechFixtureDuration = await readWavPcmDuration(fixturePath);
    } catch (error: unknown) {
      return fail(
        "MEETING_PROCESSING_VERIFY_SPEECH_FIXTURE_UNAVAILABLE",
        `The deterministic speech fixture could not be used: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const captureEngine = new LocalRecordingCaptureEngine(store);
    const coordinator = new NativeCaptureCoordinator(createNativeCaptureAdapter({ platform }), captureEngine, {
      policy: { MICROPHONE_AUDIO: "ALLOW", SYSTEM_AUDIO: "ALLOW", SCREEN: "ALLOW", WINDOW: "ALLOW" },
    });
    const meetingCapture = new MeetingCaptureOrchestrator({ store, coordinator, engine: captureEngine });

    // 5. Start the real Phase 8 capture flow (microphone + system loopback only).
    progress.stage = "capture-start";
    const started = await meetingCapture.start(
      { microphone: true, systemLoopback: true, screen: false },
      { title: "Phase 9 meeting processing verification" },
    );
    progress.meetingId = started.meetingId;
    recordSources(progress, started);
    if (started.meetingStatus !== "RECORDING") {
      await meetingCapture.abort(started.meetingId).catch(() => undefined);
      return fail(
        "MEETING_PROCESSING_VERIFY_CAPTURE_START_FAILED",
        `Capture flow did not reach RECORDING: ${started.meetingStatus}${describeSources(progress)}`,
      );
    }

    // 6. Play the deterministic fixture through the real default output device.
    progress.stage = "playback";
    progress.playbackStarted = true;
    try {
      const playback = await playWavThroughDefaultOutput({
        wavPath: fixturePath,
        timeoutMs: (progress.speechFixtureDuration?.durationMs ?? 0) + PLAYBACK_START_SLACK_MS,
        platform,
      });
      progress.playbackCompleted = true;
      progress.playbackPlayedMs = playback.playedMs;
    } catch (error: unknown) {
      await meetingCapture.abort(started.meetingId).catch(() => undefined);
      const code = error instanceof VerificationPlaybackError ? error.code : "MEETING_PROCESSING_VERIFY_PLAYBACK_FAILED";
      return fail(code, error instanceof Error ? error.message : String(error));
    }
    await waitForDuration(playbackTailMs);

    // 7. Stop the real capture flow; both audio sources must commit non-empty artifacts.
    progress.stage = "capture-stop";
    const stopped = await meetingCapture.stop(started.meetingId);
    progress.meetingStatus = stopped.meetingStatus;
    recordSources(progress, stopped);
    const uncommitted = stopped.sources.filter((source) => !source.artifactCommitted || source.bytesWritten === 0 || source.journalState !== "COMMITTED");
    if (stopped.meetingStatus !== "COMPLETED" || uncommitted.length > 0) {
      return fail(
        "MEETING_PROCESSING_VERIFY_CAPTURE_DID_NOT_COMMIT",
        `Capture ended ${stopped.meetingStatus}; ${uncommitted.length === 0 ? "all sources committed" : `${uncommitted.length} source(s) did not commit`}${describeSources(progress)}`,
      );
    }

    // 8. Real production processing: real Whisper transcription + real Qwen 7B analysis.
    progress.stage = "processing";
    const meetingProcessing = new MeetingTranscriptionOrchestrator({
      store,
      transcriptionEngine: new WindowsLocalWhisperEngine(),
      analysisProvider: new LocalLlmProvider(),
      policy: "LOCAL_ONLY",
    });
    try {
      await meetingProcessing.processCompletedMeeting(started.meetingId);
    } catch (error: unknown) {
      readBackCounts(store, progress);
      const message = sanitizeText(error instanceof Error ? error.message : String(error), root, repoRoot);
      if (message.includes("Analysis quality rejected")) {
        progress.qualityReasons = parseQualityReasons(message);
        return fail("MEETING_PROCESSING_VERIFY_ANALYSIS_QUALITY_REJECTED", message);
      }
      return fail("MEETING_PROCESSING_VERIFY_PROCESSING_FAILED", message);
    }

    // 9. Verify every committed artifact from disk: existence, SHA, provenance, journal, SQLite.
    progress.stage = "artifact-verification";
    const verification = await verifyCommittedArtifacts(store, started.meetingId, root, progress, fail);
    if (verification !== undefined) {
      return verification;
    }

    progress.stage = "completed";
    outcome = build(true);
    return outcome;
  } catch (error: unknown) {
    if (store !== undefined && progress.meetingId !== undefined) {
      readBackCounts(store, progress);
    }
    const result: MeetingProcessingVerificationResult = {
      ...buildFallbackFailure(platform, progress),
      failureMessage: sanitizeText(error instanceof Error ? error.message : String(error), root, repoRoot),
    };
    outcome = result;
    return result;
  } finally {
    if (store !== undefined) {
      store.close();
    }
    if (root !== undefined) {
      if (options.keepWorkspace === true) {
        if (outcome !== undefined) {
          outcome.workspace = { kept: true, directoryName: basename(root) };
        }
      } else {
        await removeDirectoryAfterSqliteClose(root).catch(() => undefined);
      }
    }
  }
}

function buildFallbackFailure(platform: string, progress: VerificationProgress): MeetingProcessingVerificationResult {
  const realEngineFound = progress.whisper?.helperFound ?? false;
  const realModelFound = progress.whisper?.modelFound ?? false;
  const llmEngineFound = progress.llm?.helperFound ?? false;
  const llmModelFound = progress.llm?.modelFound ?? false;
  return {
    platform,
    nativeRuntime: platform === "win32" && realEngineFound && realModelFound && llmEngineFound && llmModelFound ? "real" : "none",
    windowsVerified: false,
    success: false,
    stage: progress.stage,
    ...(progress.meetingId === undefined ? {} : { meetingId: progress.meetingId }),
    ...(progress.meetingStatus === undefined ? {} : { meetingStatus: progress.meetingStatus }),
    sqliteStatus: progress.sqliteStatus,
    journalStatus: progress.journalStatus,
    realEngineFound,
    realModelFound,
    llmEngineFound,
    llmModelFound,
    llmModelIsProductionQwen7B: llmModelFound && progress.llm?.selectedModelId === PRODUCTION_LOCAL_LLM_MODEL_ID,
    runtime: {
      whisper: progress.whisper ?? { platform, helperFound: false, modelFound: false },
      llm: progress.llm ?? { platform, helperFound: false, modelFound: false },
    },
    speechFixture: {
      wav: MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE,
      script: MEETING_PROCESSING_SPEECH_SCRIPT_FIXTURE_RELATIVE,
      ...(progress.speechFixtureDuration === undefined ? {} : { durationMs: progress.speechFixtureDuration.durationMs }),
    },
    playback: {
      started: progress.playbackStarted,
      completed: progress.playbackCompleted,
      captureTailMs: PLAYBACK_TAIL_MS,
      ...(progress.playbackPlayedMs === undefined ? {} : { playedMs: progress.playbackPlayedMs }),
    },
    capture: { requested: ["MICROPHONE_AUDIO", "SYSTEM_AUDIO"], sources: progress.sources },
    cloudServiceUsed: false as const,
    isolatedWorkspace: true as const,
    userDataUntouched: progress.userDataUntouched,
    rendererIsolation: rendererIsolation(),
    transcriptsCreated: progress.transcriptsCreated,
    transcriptDetails: progress.transcriptDetails,
    analysisCreated: progress.analysisCreated,
    ...(progress.analysisDetail === undefined ? {} : { analysisDetail: progress.analysisDetail }),
    qualityAcceptable: progress.qualityAcceptable,
    ...(progress.qualityReasons === undefined ? {} : { qualityReasons: progress.qualityReasons }),
    failureCode: "MEETING_PROCESSING_VERIFY_FAILED",
  };
}

async function verifyCommittedArtifacts(
  store: LocalFirstStore,
  meetingId: string,
  workspaceRoot: string,
  progress: VerificationProgress,
  fail: (code: string, message: string) => MeetingProcessingVerificationResult,
): Promise<MeetingProcessingVerificationResult | undefined> {
  const meeting = store.getMeeting(meetingId);
  progress.meetingStatus = meeting?.status;

  const recordings = store.database.listRecordings(meetingId);
  const micRecording = recordings.find((r) => r.captureSource?.endsWith(":MICROPHONE_AUDIO") && r.finalStatus === "COMMITTED");
  const sysRecording = recordings.find((r) => r.captureSource?.endsWith(":SYSTEM_AUDIO") && r.finalStatus === "COMMITTED");
  if (micRecording === undefined || sysRecording === undefined) {
    readBackCounts(store, progress);
    return fail(
      "MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID",
      `Committed recordings missing (microphone: ${micRecording !== undefined}, system: ${sysRecording !== undefined}).`,
    );
  }

  const transcripts = store.database.listTranscripts(meetingId);
  progress.transcriptsCreated = transcripts.length;
  const micTranscript = transcripts.find((t) => t.sourceCapability === "MICROPHONE_AUDIO");
  const sysTranscript = transcripts.find((t) => t.sourceCapability === "SYSTEM_AUDIO");
  if (transcripts.length !== 2 || micTranscript === undefined || sysTranscript === undefined) {
    return fail(
      "MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID",
      `Expected one microphone and one system-audio transcript, found ${transcripts.length} (${transcripts.map((t) => t.sourceCapability ?? "?").join(", ")}).`,
    );
  }

  const expected: Array<{ transcript: TranscriptRecord; capability: string; recordingSha256?: string }> = [
    { transcript: micTranscript, capability: "MICROPHONE_AUDIO", recordingSha256: micRecording.sha256 },
    { transcript: sysTranscript, capability: "SYSTEM_AUDIO", recordingSha256: sysRecording.sha256 },
  ];
  for (const item of expected) {
    const detail = await verifyTranscriptProvenance(store, item.transcript, item.capability, item.recordingSha256);
    progress.transcriptDetails.push(detail);
    if (!detail.artifactSha256Verified || !detail.sourceSha256MatchesRecording || detail.engineId !== WHISPER_ENGINE_ID) {
      return fail(
        "MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID",
        `Transcript for ${item.capability} failed provenance verification (engine=${detail.engineId ?? "?"}, shaVerified=${detail.artifactSha256Verified}, sourceShaMatch=${detail.sourceSha256MatchesRecording}).`,
      );
    }
  }

  const operations = store.database.listArtifactOperations().filter((op) => op.meetingId === meetingId);
  progress.journalStatus = operations.length > 0 && operations.every((op) => op.state === "COMMITTED") ? "COMMITTED" : "INCOMPLETE";
  const jobs = store.database.listProcessingJobs(meetingId);
  const artifacts = store.database.listArtifacts(meetingId);
  progress.sqliteStatus = meeting?.status === "COMPLETED" && jobs.length > 0 && artifacts.length > 0 ? "COMMITTED" : "INCOMPLETE";
  if (progress.journalStatus !== "COMMITTED" || progress.sqliteStatus !== "COMMITTED") {
    return fail(
      "MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID",
      `Storage state invalid: journal=${progress.journalStatus}, sqlite=${progress.sqliteStatus}.`,
    );
  }

  // Rebuild the unified transcript and the analysis from the committed
  // artifacts on disk (never from the fixture) and re-run the unchanged
  // quality evaluator as the final quality gate.
  const micDoc = await loadTranscriptDocument(store, micTranscript);
  const sysDoc = await loadTranscriptDocument(store, sysTranscript);
  const unified = buildUnifiedTranscriptDocument(meetingId, micDoc, sysDoc);

  const analyses = store.database.listAnalysis(meetingId);
  progress.analysisCreated = analyses.length > 0;
  const summaryRow = analyses.find((a) => a.kind === "SUMMARY");
  if (summaryRow === undefined) {
    return fail("MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID", "No committed SUMMARY analysis row was found.");
  }
  let artifactsShaVerified = 0;
  for (const row of analyses) {
    const artifact = store.database.getArtifact(row.artifactId);
    if (artifact === undefined || artifact.status !== "AVAILABLE" || !artifact.sha256) {
      return fail("MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID", `Analysis artifact for kind ${row.kind} is missing or unavailable.`);
    }
    const verification = await store.storage.inspectFile(artifact.relativePath, artifact.sha256);
    if (verification.status !== "AVAILABLE") {
      return fail("MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID", `Analysis artifact SHA mismatch for kind ${row.kind}.`);
    }
    artifactsShaVerified += 1;
  }
  const summaryArtifact = store.database.getArtifact(summaryRow.artifactId);
  const analysisBytes = await store.readArtifactBytes(summaryArtifact?.relativePath ?? "");
  const analysisDocument = JSON.parse(Buffer.from(analysisBytes).toString("utf8")) as AnalysisDocument;
  const quality = evaluateAnalysisQuality(analysisDocument, unified);
  progress.qualityAcceptable = quality.acceptable;
  progress.qualityReasons = quality.reasons;
  const analysisJournal = store.database
    .listArtifactOperations()
    .filter((op) => op.meetingId === meetingId && op.artifactType.startsWith("ANALYSIS_"))
    .every((op) => op.state === "COMMITTED");
  progress.analysisDetail = {
    rows: analyses.length,
    kinds: analyses.map((a) => a.kind),
    summaryArtifact: (summaryArtifact?.relativePath ?? "").replace(/\\/g, "/").split("/").slice(-2).join("/"),
    artifactsShaVerified,
    journalState: analysisJournal ? "COMMITTED" : "INCOMPLETE",
    ...(summaryRow.sourceTranscriptIds === undefined ? {} : { sourceTranscriptIds: summaryRow.sourceTranscriptIds }),
    ...(summaryRow.sourceTranscriptShas === undefined ? {} : { sourceTranscriptShas: summaryRow.sourceTranscriptShas }),
  };
  if (!quality.acceptable) {
    return fail(
      "MEETING_PROCESSING_VERIFY_ANALYSIS_QUALITY_REJECTED",
      `Analysis quality rejected when re-verified from committed artifacts: ${quality.reasons.join(", ")}`,
    );
  }
  if (!analysisJournal) {
    return fail("MEETING_PROCESSING_VERIFY_ARTIFACTS_INVALID", "Analysis journal operations are not all COMMITTED.");
  }

  progress.userDataUntouched = await checkUserDataUntouched(store, workspaceRoot);
  if (!progress.userDataUntouched) {
    return fail("MEETING_PROCESSING_VERIFY_ISOLATION", "Artifact files were written outside the isolated verification DATA_ROOT.");
  }
  if (meeting?.status !== "COMPLETED") {
    return fail("MEETING_PROCESSING_VERIFY_FINAL_STATE_INVALID", `Meeting status is ${meeting?.status ?? "unknown"} after processing.`);
  }
  return undefined;
}

async function verifyTranscriptProvenance(
  store: LocalFirstStore,
  transcript: TranscriptRecord,
  capability: string,
  recordingSha256: string | undefined,
): Promise<MeetingProcessingTranscriptDetail> {
  const detail: MeetingProcessingTranscriptDetail = {
    capability,
    transcriptId: transcript.transcriptId,
    ...(transcript.recordingId === undefined ? {} : { recordingId: transcript.recordingId }),
    ...(transcript.engineId === undefined ? {} : { engineId: transcript.engineId }),
    ...(transcript.sourceSha256 === undefined ? {} : { sourceSha256: transcript.sourceSha256 }),
    sourceSha256MatchesRecording: transcript.sourceSha256 !== undefined && transcript.sourceSha256 === recordingSha256,
    jsonArtifact: "",
    artifactSha256Verified: false,
  };
  const artifact = store.database.getArtifact(transcript.jsonArtifactId);
  if (artifact === undefined) {
    return detail;
  }
  detail.jsonArtifact = artifact.relativePath.replace(/\\/g, "/").split("/").slice(-2).join("/");
  if (artifact.status === "AVAILABLE" && artifact.sha256) {
    const verification = await store.storage.inspectFile(artifact.relativePath, artifact.sha256);
    detail.artifactSha256Verified = verification.status === "AVAILABLE";
  }
  return detail;
}

async function loadTranscriptDocument(store: LocalFirstStore, transcript: TranscriptRecord): Promise<TranscriptDocument> {
  const artifact = store.database.getArtifact(transcript.jsonArtifactId);
  if (artifact === undefined) {
    throw new Error("Transcript artifact missing.");
  }
  const bytes = await store.readArtifactBytes(artifact.relativePath);
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as TranscriptDocument;
}

async function checkUserDataUntouched(store: LocalFirstStore, workspaceRoot: string): Promise<boolean> {
  const files = await store.storage.listFiles();
  return files.every((file) => file.absolutePath.startsWith(workspaceRoot));
}

function readBackCounts(store: LocalFirstStore, progress: VerificationProgress): void {
  try {
    if (progress.meetingId === undefined) {
      return;
    }
    const transcripts = store.database.listTranscripts(progress.meetingId);
    progress.transcriptsCreated = transcripts.length;
    progress.analysisCreated = store.database.listAnalysis(progress.meetingId).length > 0;
    progress.meetingStatus = store.getMeeting(progress.meetingId)?.status;
  } catch {
    // Honest reporting only; if SQLite is unreadable the recorded progress stands.
  }
}

function recordSources(progress: VerificationProgress, snapshot: MeetingCaptureFlowSnapshot): void {
  progress.sources = snapshot.sources.map((source: MeetingCaptureSourceSnapshot) => ({
    kind: source.kind,
    capability: source.capability,
    state: source.state,
    journalState: source.journalState,
    bytesWritten: source.bytesWritten,
    ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
    artifactCommitted: source.artifactCommitted,
    ...(source.error === undefined ? {} : { error: { code: source.error.code, message: source.error.message } }),
  }));
}

function describeSources(progress: VerificationProgress): string {
  if (progress.sources.length === 0) {
    return "";
  }
  return ` [${progress.sources
    .map((source) => `${source.kind}:${source.state}/journal=${source.journalState}/bytes=${source.bytesWritten}`)
    .join(", ")}]`;
}

function parseQualityReasons(message: string): string[] {
  const marker = "Analysis quality rejected: ";
  const index = message.indexOf(marker);
  const tail = index >= 0 ? message.slice(index + marker.length) : message;
  return tail
    .split(/(?=Summary does not mention|Only \d+ transcript (?:decisions|tasks) were recovered|Invented assignee\/owner names|Analysis repeats generic placeholder)/)
    .map((part) => part.trim().replace(/,$/, ""))
    .filter((part) => part.length > 0);
}

function rendererIsolation(): { contextIsolation: boolean; sandbox: boolean } {
  const preferences = createSecureRendererPreferences("/app/preload.js");
  return {
    contextIsolation: preferences.contextIsolation === true,
    sandbox: preferences.sandbox === true,
  };
}

function sanitizeText(message: string, root: string | undefined, repoRoot: string): string {
  let text = message;
  if (root !== undefined) {
    text = text.split(root).join("<workspace>");
  }
  text = text.split(repoRoot).join("<repo>");
  text = text.replace(/[A-Za-z]:\\[^\s"]+/g, "<path>");
  text = text.replace(/\/(?:home|Users|tmp|var|root)[^\s"]*/g, "<path>");
  return text.slice(0, 600);
}
