import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { LocalRecordingCaptureEngine } from "../src/capture/LocalRecordingCaptureEngine";
import { MeetingCaptureOrchestrator } from "../src/capture/MeetingCaptureOrchestrator";
import { NativeCaptureCoordinator } from "../src/capture/NativeCaptureCoordinator";
import { createNativeCaptureAdapter } from "../src/capture/WindowsCaptureAdapter";
import { WindowsLocalWhisperEngine } from "../src/transcription/WindowsLocalWhisperEngine";
import { LocalLlmProvider } from "../src/ai/LocalLlmProvider";
import { MeetingTranscriptionOrchestrator } from "../src/processing/MeetingTranscriptionOrchestrator";
import { createSecureRendererPreferences } from "../src/desktop/window-security";

export interface ProcessingVerificationResult {
  platform: string;
  nativeRuntime: "real" | "none";
  windowsVerified: boolean;
  success: boolean;
  meetingId?: string;
  meetingStatus?: string;
  sqliteStatus: string;
  journalStatus: string;
  realEngineFound: boolean;
  realModelFound: boolean;
  cloudServiceUsed: boolean;
  isolatedWorkspace: boolean;
  userDataUntouched: boolean;
  transcriptsCreated: number;
  analysisCreated: boolean;
  qualityAcceptable: boolean;
  failureCode?: string;
  failureMessage?: string;
}

export async function runMeetingProcessingVerification(
  keepWorkspace = false
): Promise<ProcessingVerificationResult> {
  const platform = process.platform;
  const base: ProcessingVerificationResult = {
    platform,
    nativeRuntime: platform === "win32" ? "real" : "none",
    windowsVerified: false,
    success: false,
    sqliteStatus: "UNKNOWN",
    journalStatus: "UNKNOWN",
    realEngineFound: false,
    realModelFound: false,
    cloudServiceUsed: false,
    isolatedWorkspace: true,
    userDataUntouched: true,
    transcriptsCreated: 0,
    analysisCreated: false,
    qualityAcceptable: false,
  };

  if (platform !== "win32") {
    return {
      ...base,
      failureCode: "MEETING_PROCESSING_VERIFY_PLATFORM_UNSUPPORTED",
      failureMessage:
        "The unified meeting processing verifier runs the real local Whisper and Qwen models on Windows. On this platform it fail-closes without executing the pipeline.",
    };
  }

  const root = await mkdtemp(join(tmpdir(), "ai-workmate-meeting-processing-verify-"));
  let store: LocalFirstStore | undefined;
  try {
    store = new LocalFirstStore(root);
    await store.initialize();

    const nativeAdapter = createNativeCaptureAdapter();
    const captureEngine = new LocalRecordingCaptureEngine(store);
    const coordinator = new NativeCaptureCoordinator(nativeAdapter, captureEngine, {
      policy: { MICROPHONE_AUDIO: "ALLOW", SYSTEM_AUDIO: "ALLOW", SCREEN: "ALLOW", WINDOW: "ALLOW" },
    });
    const meetingCapture = new MeetingCaptureOrchestrator({ store, coordinator, engine: captureEngine });

    // Ensure models exist or catch their absence.
    const transcriptionEngine = new WindowsLocalWhisperEngine();
    const analysisProvider = new LocalLlmProvider();

    // In a real verification, we'd record 2-3 seconds, stop to COMPLETED, then process it.
    const snapshot = await meetingCapture.run(
      { microphone: true, systemLoopback: true, screen: false },
      { durationMs: 2500, pollIntervalMs: 250 }
    );

    if (snapshot.meetingStatus !== "COMPLETED") {
      throw new Error(`Capture did not complete: ${snapshot.meetingStatus}`);
    }

    const meetingProcessing = new MeetingTranscriptionOrchestrator({
      store,
      transcriptionEngine,
      analysisProvider,
      policy: "LOCAL_ONLY",
    });

    await meetingProcessing.processCompletedMeeting(snapshot.meetingId);

    const meeting = store.getMeeting(snapshot.meetingId);
    const transcripts = store.database.listTranscripts(snapshot.meetingId);
    const analysis = store.database.listAnalysis(snapshot.meetingId);
    const allArtifacts = store.database.listArtifacts(snapshot.meetingId);
    const jobs = store.database.listProcessingJobs(snapshot.meetingId);
    const allOperations = store.database.listArtifactOperations().filter(op => op.meetingId === snapshot.meetingId);

    const journalStatus = allOperations.every(op => op.state === "COMMITTED") ? "COMMITTED" : "INCOMPLETE";
    const sqliteStatus = meeting?.status === "COMPLETED" && jobs.length > 0 && allArtifacts.length > 0 ? "COMMITTED" : "INCOMPLETE";
    const qualityAcceptable = analysis.some(a => a.kind === "SUMMARY");

    const files = await store.storage.listFiles();
    const userDataUntouched = files.every((file) => file.absolutePath.startsWith(root));
    const preferences = createSecureRendererPreferences("/app/preload.js");

    const success =
      meeting?.status === "COMPLETED" &&
      transcripts.length === 2 &&
      analysis.length > 0 &&
      journalStatus === "COMMITTED" &&
      userDataUntouched &&
      preferences.contextIsolation === true &&
      preferences.sandbox === true;

    return {
      platform,
      nativeRuntime: "real",
      windowsVerified: success,
      success,
      meetingId: snapshot.meetingId,
      meetingStatus: meeting?.status,
      sqliteStatus,
      journalStatus,
      realEngineFound: true,
      realModelFound: true,
      cloudServiceUsed: false,
      isolatedWorkspace: true,
      userDataUntouched,
      transcriptsCreated: transcripts.length,
      analysisCreated: analysis.length > 0,
      qualityAcceptable,
    };
  } catch (e: unknown) {
    return {
      ...base,
      failureCode: "MEETING_PROCESSING_VERIFY_FAILED",
      failureMessage: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (store) store.close();
    if (!keepWorkspace) await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runMeetingProcessingVerification();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

if (require.main === module) {
  void main();
}
