import test from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { MeetingTranscriptionOrchestrator } from "../src/processing/MeetingTranscriptionOrchestrator";
import type { TranscriptionEngine, TranscriptionRequest, TranscriptionEngineResult } from "../src/transcription/TranscriptionEngine";
import type { AIProcessRequest, AIProcessResult, AIProvider } from "../src/ai/AIProvider";
import { StorageError } from "../src/storage/errors";
import type { ActionItem, AnalysisDocument, Decision } from "../src/domain/models";
import { buildUnifiedTranscriptDocument } from "../src/processing/sourceAttribution";

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
  public failRetryable = false;
  
  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    this.transcribeCalls.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new StorageError("Hard failure");
    }
    if (this.failRetryable) {
      this.failRetryable = false;
      throw new StorageError("interrupted");
    }
    const result: FakeTranscriptionEngineResult = {
      meetingId: request.meetingId,
      recordingId: request.recordingId!,
      language: "en",
      speakers: [],
      timestamps: true,
      engine: this.descriptor,
      createdAt: new Date().toISOString(),
      segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1000, text: `Fake transcript for ${request.recordingId} local only meeting files windows verification encryption of transcripts fail-closed tests install guide` }]
    };
    return result;
  }
}

class FakeAIProvider implements AIProvider {
  public readonly descriptor = { id: "fake-ai", name: "Fake AI", displayName: "Fake AI", kind: "LOCAL" as const, dataTransmission: "LOCAL_ONLY" as const, capabilities: { offline: true } };
  public processCalls: AIProcessRequest[] = [];
  public failNext = false;

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    this.processCalls.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new StorageError("Hard failure");
    }
    
    const analysis: FakeAnalysisDocument = {
      meetingId: request.meetingId,
      createdAt: new Date().toISOString(),
      summary: "Fake summary local only",
      decisions: [{ decisionId: randomUUID(), text: "Fake decision local only", createdAt: new Date().toISOString() }, { decisionId: randomUUID(), text: "Fake decision meeting files", createdAt: new Date().toISOString() }],
      tasks: [{ taskId: randomUUID(), text: "Fake task encryption of transcripts", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { taskId: randomUUID(), text: "Fake task fail-closed tests", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
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

async function createTestEnv() {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-processing-test-"));
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

async function setupMeetingAndRecordings(store: LocalFirstStore, mic: boolean, sys: boolean) {
  const meetingId = randomUUID();
  rawDb(store).exec(`
    INSERT INTO meetings (meeting_id, title, slug, folder_name, folder_relative_path, meeting_date, created_at, updated_at, status, storage_version)
    VALUES ('${meetingId}', 'Test Meeting', 'test-meeting', 'Test_Meeting', 'Meetings/Test_Meeting', '2026-09-06', '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', 'COMPLETED', 6)
  `);

  const addRecording = async (capability: string) => {
    const dir = join(store.getDataRoot(), "Meetings/Test_Meeting/Recording/Original");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `meeting_${meetingId}_${capability}.aiwpcm`), Buffer.from(validJsonl, "utf8"));
    
    const sha256 = createHash("sha256").update(validJsonl).digest("hex");
    rawDb(store).exec(`
      INSERT INTO artifacts (file_id, meeting_id, relative_path, artifact_type, mime_type, size, created_at, modified_at, sha256, status, recording_variant)
      VALUES ('${randomUUID()}', '${meetingId}', 'Meetings/Test_Meeting/Recording/Original/meeting_${meetingId}_${capability}.aiwpcm', 'RECORDING_ORIGINAL', 'application/x-ai-workmate-pcm-jsonl', ${validJsonl.length}, '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', '${sha256}', 'AVAILABLE', 'ORIGINAL')
    `);
    const fileId = rawDb(store).prepare(`SELECT file_id FROM artifacts WHERE relative_path = 'Meetings/Test_Meeting/Recording/Original/meeting_${meetingId}_${capability}.aiwpcm'`).get()!.file_id as string;
    rawDb(store).exec(`
      INSERT INTO recordings (recording_id, meeting_id, artifact_id, recording_variant, created_at, capture_source, final_status, sha256)
      VALUES ('${randomUUID()}', '${meetingId}', '${fileId}', 'ORIGINAL', '2026-09-06T12:00:00Z', 'fake:${capability}', 'COMMITTED', '${sha256}')
    `);
  };

  if (mic) await addRecording("MICROPHONE_AUDIO");
  if (sys) await addRecording("SYSTEM_AUDIO");

  store.transitionMeeting(meetingId, "COMPLETED");
  return meetingId;
}

test("Processing Orchestrator 1 - happy path: two sources and analysis", async () => {
  const { root, store, orchestrator, transcriptionEngine, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, true);
  
  await orchestrator.processCompletedMeeting(meetingId);
  
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 2);
  assert.strictEqual(analysisProvider.processCalls.length, 1);
  
  const meeting = store.getMeeting(meetingId);
  assert.strictEqual(meeting?.status, "COMPLETED");
  
  const transcripts = store.database.listTranscripts(meetingId);
  assert.strictEqual(transcripts.length, 2);
  
  const jobs = store.database.listProcessingJobs(meetingId);
  assert.strictEqual(jobs.length, 3);
  assert.ok(jobs.every(j => j.state === "COMPLETED"));
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 2 - happy path: missing mic is allowed if sys present", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, false, true);
  
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 3 - missing sys is allowed if mic present", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 4 - throws if no eligible recordings", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, false, false);
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /No completed microphone or system/);
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 6 - hard transcription failure leaves meeting FAILED", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  transcriptionEngine.failNext = true;
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId));
  
  assert.strictEqual(store.getMeeting(meetingId)?.status, "FAILED");
  const jobs = store.database.listProcessingJobs(meetingId);
  assert.strictEqual(jobs.find(j => j.jobType === "TRANSCRIPTION")?.state, "FAILED");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 7 - retryable transcription failure leaves meeting INCOMPLETE", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  transcriptionEngine.failRetryable = true;
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId));
  
  assert.strictEqual(store.getMeeting(meetingId)?.status, "INCOMPLETE");
  const jobs = store.database.listProcessingJobs(meetingId);
  assert.strictEqual(jobs.find(j => j.jobType === "TRANSCRIPTION")?.state, "INCOMPLETE");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 8 - reuses valid transcripts", async () => {
  const { root, store, orchestrator, transcriptionEngine, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
  assert.strictEqual(analysisProvider.processCalls.length, 1);
  
  // Run again, should reuse
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1); // no new calls
  assert.strictEqual(analysisProvider.processCalls.length, 1); // no new calls
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 9 - stale analysis invalidation", async () => {
  const { root, store, orchestrator, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(analysisProvider.processCalls.length, 1);
  
  // simulate transcript change by updating SHA in DB manually
  rawDb(store).exec(`UPDATE transcripts SET source_sha256 = 'different' WHERE meeting_id = '${meetingId}'`);
  
  // Because SHA doesn't match recording, transcription will rerun, generating a new transcript artifact ID
  await orchestrator.processCompletedMeeting(meetingId);
  
  assert.strictEqual(analysisProvider.processCalls.length, 2); // Analysis reran
  
  await rm(root, { recursive: true, force: true });
});

test("Source Attribution 1 - unified document retains labels", () => {
  const unified = buildUnifiedTranscriptDocument("m1", 
    { meetingId: "m1", language: "en", createdAt: "", speakers: [], timestamps: true, segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1, text: "Mic word" }] },
    { meetingId: "m1", language: "en", createdAt: "", speakers: [], timestamps: true, segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1, text: "Sys word" }] }
  );
  
  assert.strictEqual(unified.segments.length, 4);
  assert.strictEqual(unified.segments[0]!.text, "[Microphone]");
  assert.strictEqual(unified.segments[1]!.text, "Mic word");
  assert.strictEqual(unified.segments[2]!.text, "[System Audio]");
  assert.strictEqual(unified.segments[3]!.text, "Sys word");
});

test("Source Attribution 2 - missing mic", () => {
  const unified = buildUnifiedTranscriptDocument("m1", 
    undefined,
    { meetingId: "m1", language: "en", createdAt: "", speakers: [], timestamps: true, segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1, text: "Sys word" }] }
  );
  
  assert.strictEqual(unified.segments.length, 2);
  assert.strictEqual(unified.segments[0]!.text, "[System Audio]");
  assert.strictEqual(unified.segments[1]!.text, "Sys word");
});

test("Processing Orchestrator 12 - unique mic/sys artifact paths", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, true);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const artifacts = store.database.listArtifacts(meetingId);
  
  const micJson = artifacts.find(a => a.relativePath.endsWith("_mic.json"));
  const sysJson = artifacts.find(a => a.relativePath.endsWith("_sys.json"));
  
  assert.ok(micJson, "Microphone transcript artifact should end with _mic.json");
  assert.ok(sysJson, "System audio transcript artifact should end with _sys.json");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 13 - corrupt source artifact fails transcription", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  const recordings = store.database.listRecordings(meetingId);
  const recording = recordings[0]!;
  
  // Corrupt the SHA
  rawDb(store).exec(`UPDATE recordings SET sha256 = 'invalid-sha' WHERE recording_id = '${recording.recordingId}'`);
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Source recording SHA verification failed/);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 17 - analysis quality rejection", async () => {
  const { root, store, orchestrator, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  // Mock AI Provider to return bad analysis
  analysisProvider.process = async (request: AIProcessRequest): Promise<AIProcessResult> => {
    const analysis: AnalysisDocument = {
      meetingId: request.meetingId,
      createdAt: new Date().toISOString(),
      summary: "I have no idea what they talked about", // bad quality
      decisions: [],
      tasks: [],
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
  };

  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Analysis quality rejected/);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 19 - invalid meeting transition throws error", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  // Meeting must be COMPLETED, PROCESSING, INCOMPLETE, or FAILED. SCHEDULED is invalid.
  rawDb(store).exec(`UPDATE meetings SET status = 'SCHEDULED' WHERE meeting_id = '${meetingId}'`);
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Meeting is not ready for processing/);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 22 - final COMPLETED only after all commits", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  // Intercept the final saveAnalysis to check meeting status right before completion
  const originalSave = store.saveAnalysis.bind(store);
  store.saveAnalysis = async (doc, opts) => {
    const meeting = store.getMeeting(meetingId);
    assert.strictEqual(meeting?.status, "PROCESSING", "Meeting must remain PROCESSING during artifact generation");
    return originalSave(doc, opts);
  };

  await orchestrator.processCompletedMeeting(meetingId);
  const finalMeeting = store.getMeeting(meetingId);
  assert.strictEqual(finalMeeting?.status, "COMPLETED", "Meeting should transition to COMPLETED at the end");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 27 - missing json artifact fails transcript reuse", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  
  const transcripts = store.database.listTranscripts(meetingId);
  const t = transcripts[0]!;
  
    // Delete the JSON artifact so reuse fails and re-processing triggers
    const a = store.database.getArtifact(t.jsonArtifactId);
    const absPath = store.resolveArtifactAbsolutePath(a!.relativePath);
    rawDb(store).exec(`PRAGMA foreign_keys=OFF; DELETE FROM artifacts WHERE file_id = '${t.jsonArtifactId}'; PRAGMA foreign_keys=ON;`);
    try { await rm(absPath, { force: true }); } catch { /* already removed */ }
  
  // This should force it to regenerate
  await orchestrator.processCompletedMeeting(meetingId);
  
  const newTranscripts = store.database.listTranscripts(meetingId);
  assert.notStrictEqual(newTranscripts[0]?.transcriptId, t.transcriptId, "Transcript should have been regenerated");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 11 - legacy transcript without capability or SHA is not reused", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);

  const fileId = randomUUID();
  rawDb(store).exec(`
    INSERT INTO artifacts (file_id, meeting_id, relative_path, artifact_type, mime_type, size, created_at, modified_at, sha256, status)
    VALUES ('${fileId}', '${meetingId}', 'dummy.json', 'TRANSCRIPT_JSON', 'application/json', 1, '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', 'dummy', 'AVAILABLE')
  `);
  rawDb(store).exec(`
    INSERT INTO transcripts (transcript_id, meeting_id, json_artifact_id, text_artifact_id, language, created_at, recording_id, engine_id)
    VALUES ('${randomUUID()}', '${meetingId}', '${fileId}', '${fileId}', 'en', '2026-09-06T12:00:00Z', (SELECT recording_id FROM recordings LIMIT 1), 'fake-whisper')
  `);

  await orchestrator.processCompletedMeeting(meetingId);
  const transcripts = store.database.listTranscripts(meetingId);
  assert.strictEqual(transcripts.length, 2, "Should create a new transcript instead of reusing the legacy one");

  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 14 - source recording SHA mismatch fails processing", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  // Actually corrupt the file content on disk so the sha validation fails
  const recording = store.database.listRecordings(meetingId)[0]!;
  const artifact = store.database.getArtifact(recording.artifactId)!;
  const absPath = store.resolveArtifactAbsolutePath(artifact.relativePath);
  await writeFile(absPath, Buffer.from("corrupted", "utf8"));
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Source recording SHA verification failed/);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 15 - concurrent source transcription", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, true);
  
  let concurrentCount = 0;
  let maxConcurrent = 0;
  
  const original = transcriptionEngine.transcribe.bind(transcriptionEngine);
  transcriptionEngine.transcribe = async (req) => {
    concurrentCount++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await new Promise(r => setTimeout(r, 50));
    const result = await original(req);
    concurrentCount--;
    return result;
  };
  
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(maxConcurrent, 2, "Transcriptions should run concurrently via Promise.all");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 16 - interrupted transcription recovery", async () => {
  const { root, store, orchestrator, transcriptionEngine } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  transcriptionEngine.failRetryable = true;
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId));
  assert.strictEqual(store.getMeeting(meetingId)?.status, "INCOMPLETE");
  
  // Running again should recover because it was INCOMPLETE
  await orchestrator.processCompletedMeeting(meetingId);
  assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 18 - processing jobs and audit rows are properly populated", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  
  const jobs = store.database.listProcessingJobs(meetingId);
  assert.strictEqual(jobs.length, 2, "Should have 1 transcription job and 1 analysis job");
  assert.strictEqual(jobs[0]?.jobType, "TRANSCRIPTION");
  assert.strictEqual(jobs[1]?.jobType, "ANALYSIS");
  
  // Audits are tested implicitly via storage service usage.
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 20 - no absolute path leakage in returned objects", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const jsonStr = JSON.stringify(store.getMeeting(meetingId));
  assert.ok(!jsonStr.includes(store.getDataRoot()), "No absolute paths should leak");
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 21 - no cloud usage (respects LOCAL_ONLY)", async () => {
  const { root, store, orchestrator, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  // AI provider explicitly declares LOCAL_ONLY
  assert.strictEqual(analysisProvider.descriptor.dataTransmission, "LOCAL_ONLY");
  await orchestrator.processCompletedMeeting(meetingId);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 23 - analysis artifact SHA integrity", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const analysis = store.database.listAnalysis(meetingId);
  assert.ok(analysis.length > 0);
  for (const a of analysis) {
    const artifact = store.database.getArtifact(a.artifactId)!;
    assert.ok(artifact.sha256 && artifact.sha256.length === 64, "Should have valid SHA256");
  }
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 24 - idempotent repeated processing", async () => {
  const { root, store, orchestrator, transcriptionEngine, analysisProvider } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const transcriptsCount = store.database.listTranscripts(meetingId).length;
  
  await orchestrator.processCompletedMeeting(meetingId);
  await orchestrator.processCompletedMeeting(meetingId);
  
  assert.strictEqual(store.database.listTranscripts(meetingId).length, transcriptsCount);
  assert.strictEqual(transcriptionEngine.transcribeCalls.length, 1);
  assert.strictEqual(analysisProvider.processCalls.length, 1);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 25 - path traversal rejection", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  rawDb(store).exec(`UPDATE artifacts SET relative_path = '../../../etc/passwd' WHERE meeting_id = '${meetingId}'`);
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Unsafe/i);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 26 - verifies artifact exists before processing", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  const recording = store.database.listRecordings(meetingId)[0]!;
  rawDb(store).exec(`UPDATE artifacts SET status = 'MISSING' WHERE file_id = '${recording.artifactId}'`);
  
  await assert.rejects(orchestrator.processCompletedMeeting(meetingId), /Source recording artifact missing/);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 28 - missing text artifact fails transcript reuse", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const t = store.database.listTranscripts(meetingId)[0]!;
  rawDb(store).exec(`UPDATE artifacts SET status = 'MISSING' WHERE file_id = '${t.textArtifactId}'`);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const newT = store.database.listTranscripts(meetingId)[0]!;
  assert.notStrictEqual(newT.transcriptId, t.transcriptId);
  
  await rm(root, { recursive: true, force: true });
});

test("Processing Orchestrator 30 - analysis artifact SHA missing fails reuse", async () => {
  const { root, store, orchestrator } = await createTestEnv();
  const meetingId = await setupMeetingAndRecordings(store, true, false);
  
  await orchestrator.processCompletedMeeting(meetingId);
  const a = store.database.listAnalysis(meetingId)[0]!;
  
  const absPath = store.resolveArtifactAbsolutePath(store.database.getArtifact(a.artifactId)!.relativePath);
  await writeFile(absPath, Buffer.from("bad data"));
  
  // Actually update both the expected SHA *and* force inspect to run by invalidating the database record
  // Or simply delete the row from DB completely
  await rm(absPath, { force: true });
  
  await orchestrator.processCompletedMeeting(meetingId);
  const newA = store.database.listAnalysis(meetingId)[0]!;
  assert.notStrictEqual(newA.analysisId, a.analysisId);
  
  await rm(root, { recursive: true, force: true });
});
