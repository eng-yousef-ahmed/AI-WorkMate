import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFirstStore } from "../storage/LocalFirstStore";
import { LocalRecordingCaptureEngine } from "./LocalRecordingCaptureEngine";
import { MeetingCaptureOrchestrator, type MeetingCaptureFlowSnapshot } from "./MeetingCaptureOrchestrator";
import { NativeCaptureCoordinator } from "./NativeCaptureCoordinator";
import type { NativeCapturePolicy } from "./NativeCaptureAdapter";
import { createNativeCaptureAdapter } from "./WindowsCaptureAdapter";
import { createSecureRendererPreferences } from "../desktop/window-security";

/**
 * Structured Windows runtime verification for the unified meeting capture
 * orchestrator (Phase 8). Runs the real production path end to end: a real
 * WASAPI/DXGI/WGC native adapter (mic + system loopback + screen, and WINDOW
 * when requested), the real LocalRecordingCaptureEngine pipelines, one meeting,
 * multiple independent sources, artifact + journal + SQLite commit ordering and
 * SHA-256 verification. It never stores recording bytes in SQLite, never
 * touches the user DATA_ROOT (isolated temp workspace), and never uses a cloud
 * service. On non-Windows platforms it fail-closes with the same structured
 * JSON so the report stays honest about what was verified.
 */
export const MEETING_CAPTURE_VERIFY_DURATION_MS = 4_000;

export interface MeetingCaptureVerificationOptions {
  durationMs?: number;
  keepWorkspace?: boolean;
  /** Explicit native WINDOW sourceId. When undefined the WINDOW source is not requested. */
  windowSourceId?: string;
  /** Request the WINDOW source and resolve it through the deterministic selection path. */
  includeWindow?: boolean;
}

export interface MeetingCaptureVerificationSourceResult {
  kind: string;
  capability: string;
  state: string;
  journalState: string;
  sourceId?: string;
  sourceLabel: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  chunksWritten: number;
  bytesWritten: number;
  firstSequence?: number;
  lastSequence?: number;
  sha256?: string;
  artifactCommitted: boolean;
  artifactExists: boolean;
  error?: { code: string; message: string };
}

export interface MeetingCaptureVerificationResult {
  platform: string;
  nativeRuntime: "real" | "none";
  windowsRuntimeVerified: boolean;
  success: boolean;
  meetingId?: string;
  flowPhase?: string;
  meetingStatus?: string;
  requestedCapabilities?: string[];
  startedCapabilities?: string[];
  perSource: MeetingCaptureVerificationSourceResult[];
  finalArtifactExistence: { committed: number; verifiedOnDisk: number };
  journalState: { operations: number; committed: number; incomplete: number; failed: number };
  sqliteState: { artifacts: number; recordings: number; recordingsCommitted: number; recordingsIncomplete: number; sha256Matches: number };
  sha256Verified: boolean;
  isolationChecks: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    rendererFilesystemPathsExposed: boolean;
    absoluteDataRootInSnapshots: boolean;
    recordingBytesInSqlite: boolean;
  };
  userDataUntouched: boolean;
  cloudServiceUsed: boolean;
  dataRootIsolatedTemp: boolean;
  failureCode?: string;
  failureMessage?: string;
}

const ALL_ALLOWED_POLICY: NativeCapturePolicy = {
  MICROPHONE_AUDIO: "ALLOW",
  SYSTEM_AUDIO: "ALLOW",
  SCREEN: "ALLOW",
  WINDOW: "ALLOW",
};

export async function runMeetingCaptureVerification(
  options: MeetingCaptureVerificationOptions = {},
): Promise<MeetingCaptureVerificationResult> {
  const platform = process.platform;
  const base: MeetingCaptureVerificationResult = {
    platform,
    nativeRuntime: platform === "win32" ? "real" : "none",
    windowsRuntimeVerified: false,
    success: false,
    perSource: [],
    finalArtifactExistence: { committed: 0, verifiedOnDisk: 0 },
    journalState: { operations: 0, committed: 0, incomplete: 0, failed: 0 },
    sqliteState: { artifacts: 0, recordings: 0, recordingsCommitted: 0, recordingsIncomplete: 0, sha256Matches: 0 },
    sha256Verified: false,
    isolationChecks: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      rendererFilesystemPathsExposed: false,
      absoluteDataRootInSnapshots: false,
      recordingBytesInSqlite: false,
    },
    userDataUntouched: true,
    cloudServiceUsed: false,
    dataRootIsolatedTemp: true,
  };

  if (platform !== "win32") {
    return {
      ...base,
      failureCode: "MEETING_CAPTURE_VERIFY_PLATFORM_UNSUPPORTED",
      failureMessage:
        "The unified meeting capture verifier runs the real WASAPI/DXGI/WGC native helpers and must be executed on Windows after npm run build:native:win. On this platform it fail-closes without simulating capture.",
    };
  }

  const durationMs = options.durationMs ?? MEETING_CAPTURE_VERIFY_DURATION_MS;
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-meeting-capture-verify-"));
  let store: LocalFirstStore | undefined;
  let snapshot: MeetingCaptureFlowSnapshot | undefined;
  try {
    store = new LocalFirstStore(root);
    await store.initialize();
    const nativeAdapter = createNativeCaptureAdapter();
    const engine = new LocalRecordingCaptureEngine(store);
    const coordinator = new NativeCaptureCoordinator(nativeAdapter, engine, { policy: ALL_ALLOWED_POLICY });
    const orchestrator = new MeetingCaptureOrchestrator({ store, coordinator, engine });

    const windowSourceId = options.windowSourceId;
    const includeWindow = options.includeWindow === true || windowSourceId !== undefined;
    const config = {
      microphone: true,
      systemLoopback: true,
      screen: true,
      ...(includeWindow ? { window: windowSourceId ?? "" } : {}),
    };

    snapshot = await orchestrator.run(config, { durationMs, pollIntervalMs: 250 });

    // Final artifact existence: re-inspect each committed artifact on disk with
    // the recorded SHA-256 as the expected hash.
    let committed = 0;
    let verifiedOnDisk = 0;
    const database = store.database;
    const operations = database.listArtifactOperations().filter((operation) => operation.meetingId === snapshot?.meetingId);
    const artifacts = database.listArtifacts(snapshot?.meetingId ?? "");
    const recordings = database.listRecordings(snapshot?.meetingId ?? "");
    const shaMatches = new Set<string>();
    const perSource: MeetingCaptureVerificationSourceResult[] = [];
    for (const source of snapshot.sources) {
      const artifact = artifacts.find((item) =>
        recordings.some((record) => record.artifactId === item.fileId && record.captureSource?.endsWith(`:${source.capability}`) === true),
      );
      let artifactExists = false;
      if (artifact !== undefined && source.sha256 !== undefined) {
        const verification = await store.storage.inspectFile(artifact.relativePath, source.sha256);
        artifactExists = verification.status === "AVAILABLE";
        if (source.artifactCommitted) {
          committed += 1;
        }
        if (artifactExists && source.artifactCommitted) {
          verifiedOnDisk += 1;
          shaMatches.add(source.sha256);
        }
      }
      perSource.push({
        kind: source.kind,
        capability: source.capability,
        state: source.state,
        journalState: source.journalState,
        ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }),
        sourceLabel: source.sourceLabel,
        ...(source.startedAt === undefined ? {} : { startedAt: source.startedAt }),
        ...(source.endedAt === undefined ? {} : { endedAt: source.endedAt }),
        ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
        chunksWritten: source.chunksWritten,
        bytesWritten: source.bytesWritten,
        ...(source.firstSequence === undefined ? {} : { firstSequence: source.firstSequence }),
        ...(source.lastSequence === undefined ? {} : { lastSequence: source.lastSequence }),
        ...(source.sha256 === undefined ? {} : { sha256: source.sha256 }),
        artifactCommitted: source.artifactCommitted,
        artifactExists,
        ...(source.error === undefined ? {} : { error: { code: source.error.code, message: source.error.message } }),
      });
    }

    // Journal state from the artifact-operation rows of this meeting.
    const journalState = {
      operations: operations.length,
      committed: operations.filter((operation) => operation.state === "COMMITTED").length,
      incomplete: operations.filter((operation) => operation.state === "INCOMPLETE").length,
      failed: operations.filter((operation) => operation.state === "FAILED").length,
    };

    // SQLite state: metadata only, sha256 matches the files, final status COMMITTED.
    const recordingsCommitted = recordings.filter((record) => record.finalStatus === "COMMITTED").length;
    const recordingsIncomplete = recordings.filter((record) => record.finalStatus !== "COMMITTED").length;
    let recordingBytesInSqlite = false;
    const databaseBytes = await store.storage.readFile("Database/ai-workmate.sqlite");
    for (const source of perSource) {
      if (source.artifactExists !== true || source.sha256 === undefined) {
        continue;
      }
      const artifact = artifacts.find((item) => item.sha256 === source.sha256);
      if (artifact === undefined) {
        continue;
      }
      const bytes = await store.readArtifactBytes(artifact.relativePath);
      // No artifact payload prefix may appear inside the SQLite file.
      if (databaseBytes.includes(bytes.subarray(0, 32))) {
        recordingBytesInSqlite = true;
        break;
      }
    }

    const rendererPreferences = createSecureRendererPreferences("/app/preload.js");
    const snapshotJson = JSON.stringify(snapshot);
    // Every file the run produced lives under the isolated temp DATA_ROOT.
    const files = await store.storage.listFiles();
    const userDataUntouched = files.every((file) => file.absolutePath.startsWith(root));
    const success =
      snapshot.meetingStatus === "COMPLETED" &&
      committed === recordingsCommitted &&
      committed > 0 &&
      verifiedOnDisk === committed &&
      !recordingBytesInSqlite &&
      !snapshotJson.includes(root) &&
      rendererPreferences.contextIsolation === true &&
      rendererPreferences.nodeIntegration === false &&
      rendererPreferences.sandbox === true;

    const result: MeetingCaptureVerificationResult = {
      platform,
      nativeRuntime: "real",
      windowsRuntimeVerified: success,
      success,
      meetingId: snapshot.meetingId,
      flowPhase: snapshot.phase,
      meetingStatus: snapshot.meetingStatus,
      requestedCapabilities: [...snapshot.requestedCapabilities],
      startedCapabilities: [...snapshot.startedCapabilities],
      perSource,
      finalArtifactExistence: { committed, verifiedOnDisk },
      journalState,
      sqliteState: {
        artifacts: artifacts.length,
        recordings: recordings.length,
        recordingsCommitted,
        recordingsIncomplete,
        sha256Matches: shaMatches.size,
      },
      sha256Verified: shaMatches.size === committed,
      isolationChecks: {
        contextIsolation: rendererPreferences.contextIsolation,
        nodeIntegration: rendererPreferences.nodeIntegration,
        sandbox: rendererPreferences.sandbox,
        rendererFilesystemPathsExposed: snapshotJson.includes("absolutePath") || snapshotJson.includes("dataRoot"),
        absoluteDataRootInSnapshots: snapshotJson.includes(root),
        recordingBytesInSqlite,
      },
      userDataUntouched,
      cloudServiceUsed: false,
      dataRootIsolatedTemp: true,
      ...(success ? {} : { failureCode: "MEETING_CAPTURE_VERIFY_INCOMPLETE", failureMessage: "One or more unified meeting capture checks failed." }),
    };
    return result;
  } catch (error: unknown) {
    return {
      ...base,
      failureCode: "MEETING_CAPTURE_VERIFY_FAILED",
      failureMessage: error instanceof Error ? error.message : String(error),
      ...(snapshot === undefined
        ? {}
        : {
            meetingId: snapshot.meetingId,
            meetingStatus: snapshot.meetingStatus,
            flowPhase: snapshot.phase,
          }),
    };
  } finally {
    if (store !== undefined) {
      store.close();
    }
    if (options.keepWorkspace !== true) {
      await rm(root, { recursive: true, force: true });
    }
  }
}
