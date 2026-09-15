import test from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import {
  MeetingTranscriptionOrchestrator,
  MEETING_ALREADY_PROCESSING_MESSAGE,
} from "../src/processing/MeetingTranscriptionOrchestrator";
import type {
  TranscriptionEngine,
  TranscriptionRequest,
  TranscriptionEngineResult,
} from "../src/transcription/TranscriptionEngine";
import type { AIProcessRequest, AIProcessResult, AIProvider } from "../src/ai/AIProvider";
import { InvalidMeetingTransitionError, StorageError } from "../src/storage/errors";
import type { ActionItem, AnalysisDocument, Decision } from "../src/domain/models";
import { StorageConfigService } from "../src/storage/StorageConfigService";
import { StorageRuntime } from "../src/storage/StorageRuntime";

interface RawStatement {
  get(): Record<string, unknown> | undefined;
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}

function rawDb(store: LocalFirstStore): RawDatabase {
  return (store.database as unknown as { database: RawDatabase }).database;
}

type FakeTranscriptionEngineResult = TranscriptionEngineResult & { createdAt: string };

type FakeAnalysisDocument = AnalysisDocument & {
  decisions: (Decision & { createdAt: string })[];
  tasks: (ActionItem & { createdAt: string; updatedAt: string })[];
};

class FakeTranscriptionEngine implements TranscriptionEngine {
  public readonly descriptor = { id: "fake-whisper", name: "Fake Whisper", displayName: "Fake Whisper", kind: "LOCAL" as const, capabilities: { offline: true } };
  public transcribeCalls: TranscriptionRequest[] = [];
  public failNext = false;

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    this.transcribeCalls.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new StorageError("Hard failure");
    }
    const result: FakeTranscriptionEngineResult = {
      meetingId: request.meetingId,
      recordingId: request.recordingId!,
      language: "en",
      speakers: [],
      timestamps: true,
      engine: this.descriptor,
      createdAt: new Date().toISOString(),
      segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1000, text: `Fake transcript for ${request.recordingId}. We keep analysis local only on Windows and meeting files stay on the machine. Omar will write the install guide. Samir will add fail closed tests.` }]
    };
    return result;
  }
}

class FakeAIProvider implements AIProvider {
  public readonly descriptor = { id: "fake-ai", name: "Fake AI", displayName: "Fake AI", kind: "LOCAL" as const, dataTransmission: "LOCAL_ONLY" as const, capabilities: { offline: true } };
  public processCalls: AIProcessRequest[] = [];

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    this.processCalls.push(request);
    const analysis: FakeAnalysisDocument = {
      meetingId: request.meetingId,
      createdAt: new Date().toISOString(),
      summary: "We keep analysis local only on Windows and meeting files stay on the machine.",
      decisions: [{ decisionId: randomUUID(), text: "We keep analysis local only on Windows.", createdAt: new Date().toISOString() }, { decisionId: randomUUID(), text: "Meeting files stay on the machine.", createdAt: new Date().toISOString() }],
      tasks: [{ taskId: randomUUID(), text: "Omar will write the install guide", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { taskId: randomUUID(), text: "Samir will add fail closed tests", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      risks: [],
      questions: [],
      followups: []
    };
    return {
      providerId: "fake-ai",
      persistedByProvider: false,
      processedAt: new Date().toISOString(),
      output: JSON.stringify(analysis)
    };
  }
}

const fakePcmFormat = {
  container: "AIWPCM_JSONL",
  encoding: "PCM",
  sampleRateHz: 16000,
  channels: 1,
  bitsPerSample: 16,
  blockAlign: 2,
  averageBytesPerSecond: 32000,
};
const fakeData = Buffer.alloc(100);
const validJsonl = [
  JSON.stringify({ recordType: "format", format: fakePcmFormat, source: "fake" }),
  JSON.stringify({
    recordType: "chunk",
    sequence: 0,
    timestamp: new Date().toISOString(),
    format: fakePcmFormat,
    dataBase64: fakeData.toString("base64"),
    sha256: createHash("sha256").update(fakeData).digest("hex"),
    byteLength: fakeData.length
  })
].join("\n") + "\n";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (condition()) {
      return;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function createTestEnv() {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-serialization-test-"));
  const store = new LocalFirstStore(root);
  await store.initialize();

  const originalRead = store.readArtifactBytes.bind(store);
  store.readArtifactBytes = async (relativePath: string) => {
    if (relativePath.endsWith(".aiwpcm")) {
      return Buffer.from(validJsonl, "utf8");
    }
    return originalRead(relativePath);
  };

  const transcriptionEngine = new FakeTranscriptionEngine();
  const analysisProvider = new FakeAIProvider();
  const orchestrator = new MeetingTranscriptionOrchestrator({ store, transcriptionEngine, analysisProvider, policy: "LOCAL_ONLY" });
  return { root, store, transcriptionEngine, analysisProvider, orchestrator };
}

async function disposeTestEnv(store: LocalFirstStore, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

async function setupMeetingAndRecordings(store: LocalFirstStore, mic: boolean, sys: boolean): Promise<string> {
  const meetingId = randomUUID();
  const folderName = `Test_Meeting_${randomUUID().slice(0, 8)}`;
  const folderRelativePath = `Meetings/${folderName}`;
  rawDb(store).exec(`
    INSERT INTO meetings (meeting_id, title, slug, folder_name, folder_relative_path, meeting_date, created_at, updated_at, status, storage_version)
    VALUES ('${meetingId}', 'Test Meeting', 'test-meeting', '${folderName}', '${folderRelativePath}', '2026-09-06', '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', 'COMPLETED', 6)
  `);

  const addRecording = async (capability: string) => {
    const relativePath = `${folderRelativePath}/Recording/Original/meeting_${meetingId}_${capability}.aiwpcm`;
    const dir = join(store.getDataRoot(), folderRelativePath, "Recording/Original");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `meeting_${meetingId}_${capability}.aiwpcm`), Buffer.from(validJsonl, "utf8"));

    const sha256 = createHash("sha256").update(validJsonl).digest("hex");
    rawDb(store).exec(`
      INSERT INTO artifacts (file_id, meeting_id, relative_path, artifact_type, mime_type, size, created_at, modified_at, sha256, status, recording_variant)
      VALUES ('${randomUUID()}', '${meetingId}', '${relativePath}', 'RECORDING_ORIGINAL', 'application/x-ai-workmate-pcm-jsonl', ${validJsonl.length}, '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', '${sha256}', 'AVAILABLE', 'ORIGINAL')
    `);
    const fileId = rawDb(store).prepare(`SELECT file_id FROM artifacts WHERE relative_path = '${relativePath}'`).get()!.file_id as string;
    rawDb(store).exec(`
      INSERT INTO recordings (recording_id, meeting_id, artifact_id, recording_variant, created_at, capture_source, final_status, sha256)
      VALUES ('${randomUUID()}', '${meetingId}', '${fileId}', 'ORIGINAL', '2026-09-06T12:00:00Z', 'fake:${capability}', 'COMMITTED', '${sha256}')
    `);
  };

  if (mic) await addRecording("MICROPHONE_AUDIO");
  if (sys) await addRecording("SYSTEM_AUDIO");

  return meetingId;
}

function gateTranscription(engine: FakeTranscriptionEngine): { gate: { promise: Promise<void>; resolve: () => void } } {
  const gate = deferred();
  const original = engine.transcribe.bind(engine);
  engine.transcribe = async (request: TranscriptionRequest): Promise<TranscriptionEngineResult> => {
    const pending = original(request);
    await gate.promise;
    return pending;
  };
  return { gate };
}

test("P1-1: concurrent processing serializes to one winner plus one fail-fast loser", async () => {
  const { root, store, transcriptionEngine, orchestrator } = await createTestEnv();
  try {
    const meetingId = await setupMeetingAndRecordings(store, true, false);
    const { gate } = gateTranscription(transcriptionEngine);

    const winner = orchestrator.processCompletedMeeting(meetingId);
    try {
      await waitFor(() => transcriptionEngine.transcribeCalls.length === 1, "winner to enter transcription");
      // The second concurrent call must fail fast with the user-safe,
      // path-free error — never with an invalid-transition or UNIQUE error.
      await assert.rejects(
        orchestrator.processCompletedMeeting(meetingId),
        (error: unknown) => error instanceof StorageError && error.message === MEETING_ALREADY_PROCESSING_MESSAGE,
      );
    } finally {
      gate.resolve();
    }
    await winner;

    assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
    // The loser registered no processing jobs: only the winner's transcription
    // plus analysis jobs exist, and neither carries a masked error.
    const jobs = store.database.listProcessingJobs(meetingId);
    assert.strictEqual(jobs.length, 2);
    assert.ok(jobs.every((job) => job.state === "COMPLETED"));
    for (const job of jobs) {
      assert.ok(!job.error?.includes("Invalid meeting transition"), `job ${job.jobId} must not mask an invalid transition`);
      assert.ok(!job.error?.includes("UNIQUE"), `job ${job.jobId} must not mask a UNIQUE conflict`);
    }
  } finally {
    await disposeTestEnv(store, root);
  }
});

test("P1-1: concurrent processing creates no duplicate artifacts or registrations", async () => {
  const { root, store, transcriptionEngine, orchestrator } = await createTestEnv();
  try {
    const meetingId = await setupMeetingAndRecordings(store, true, false);
    const { gate } = gateTranscription(transcriptionEngine);

    const winner = orchestrator.processCompletedMeeting(meetingId);
    try {
      await waitFor(() => transcriptionEngine.transcribeCalls.length === 1, "winner to enter transcription");
      await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /already being processed/);
    } finally {
      gate.resolve();
    }
    await winner;

    // Exactly one transcript and one 7-row analysis fan-out: no duplicates.
    assert.strictEqual(store.database.listTranscripts(meetingId).length, 1);
    assert.strictEqual(store.database.listAnalysis(meetingId).length, 7);
    const artifacts = store.database.listArtifacts(meetingId);
    const relativePaths = artifacts.map((artifact) => artifact.relativePath);
    assert.strictEqual(new Set(relativePaths).size, relativePaths.length, "artifact relative paths must be unique");
    // Every indexed artifact verifies against disk with its recorded SHA.
    for (const artifact of artifacts) {
      const verification = await store.storage.inspectFile(artifact.relativePath, artifact.sha256);
      assert.strictEqual(verification.status, "AVAILABLE", artifact.relativePath);
    }
  } finally {
    await disposeTestEnv(store, root);
  }
});

test("P1-1: the original processing error survives an invalid cleanup transition", async () => {
  const { root, store, transcriptionEngine, orchestrator } = await createTestEnv();
  try {
    const meetingId = await setupMeetingAndRecordings(store, true, false);
    // Simulate the race aftermath: by the time the failing run attempts its
    // FAILED cleanup transition, the meeting already sits in COMPLETED, so the
    // transition itself is invalid and must not replace the real failure.
    const originalTransition = store.transitionMeeting.bind(store);
    store.transitionMeeting = (id: string, status: Parameters<LocalFirstStore["transitionMeeting"]>[1]): void => {
      if (status === "FAILED") {
        throw new InvalidMeetingTransitionError("Invalid meeting transition: COMPLETED -> FAILED");
      }
      originalTransition(id, status);
    };
    try {
      transcriptionEngine.failNext = true;
      await assert.rejects(
        orchestrator.processCompletedMeeting(meetingId),
        (error: unknown) => error instanceof StorageError && error.message === "Hard failure",
      );
    } finally {
      store.transitionMeeting = originalTransition;
    }
  } finally {
    await disposeTestEnv(store, root);
  }
});

test("P1-1: sequential retry after COMPLETED still reuses transcripts and analysis", async () => {
  const { root, store, transcriptionEngine, analysisProvider, orchestrator } = await createTestEnv();
  try {
    const meetingId = await setupMeetingAndRecordings(store, true, false);

    await orchestrator.processCompletedMeeting(meetingId);
    assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
    assert.strictEqual(analysisProvider.processCalls.length, 1);

    // The lock is released on completion: an immediate sequential retry must
    // not fail fast, and must reuse the persisted results.
    await orchestrator.processCompletedMeeting(meetingId);
    assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
    assert.strictEqual(analysisProvider.processCalls.length, 1);
    assert.strictEqual(store.database.listTranscripts(meetingId).length, 1);
    assert.strictEqual(store.database.listAnalysis(meetingId).length, 7);
  } finally {
    await disposeTestEnv(store, root);
  }
});

test("P1-1: different meetings may process concurrently (the lock is per-meeting)", async () => {
  const { root, store, transcriptionEngine, orchestrator } = await createTestEnv();
  try {
    const firstId = await setupMeetingAndRecordings(store, true, false);
    const secondId = await setupMeetingAndRecordings(store, true, false);
    const { gate } = gateTranscription(transcriptionEngine);

    const first = orchestrator.processCompletedMeeting(firstId);
    const second = orchestrator.processCompletedMeeting(secondId);
    try {
      await waitFor(() => transcriptionEngine.transcribeCalls.length === 2, "both meetings to enter transcription");
    } finally {
      gate.resolve();
    }
    await Promise.all([first, second]);

    assert.strictEqual(store.getMeeting(firstId)?.status, "COMPLETED");
    assert.strictEqual(store.getMeeting(secondId)?.status, "COMPLETED");
  } finally {
    await disposeTestEnv(store, root);
  }
});

test("P1-1: the runtime boundary fails fast on a concurrent process request", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "ai-workmate-serialization-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-serialization-data-"));
  const transcriptionEngine = new FakeTranscriptionEngine();
  const analysisProvider = new FakeAIProvider();
  const config = new StorageConfigService(join(configRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config, () => new Date(), undefined, {}, { transcriptionEngine, analysisProvider });
  try {
    await runtime.configureFirstRun(dataRoot);
    const store = runtime.store;
    assert.ok(store !== undefined, "runtime must attach a store after first-run configuration");

    const originalRead = store.readArtifactBytes.bind(store);
    store.readArtifactBytes = async (relativePath: string) => {
      if (relativePath.endsWith(".aiwpcm")) {
        return Buffer.from(validJsonl, "utf8");
      }
      return originalRead(relativePath);
    };

    const meetingId = await setupMeetingAndRecordings(store, true, false);
    const { gate } = gateTranscription(transcriptionEngine);

    const winner = runtime.processCompletedMeeting(meetingId);
    try {
      await waitFor(() => transcriptionEngine.transcribeCalls.length === 1, "winner to enter transcription");
      await assert.rejects(
        runtime.processCompletedMeeting(meetingId),
        (error: unknown) => error instanceof StorageError && error.message === MEETING_ALREADY_PROCESSING_MESSAGE,
      );
    } finally {
      gate.resolve();
    }
    await winner;

    assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
  } finally {
    await runtime.close();
    await rm(configRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
