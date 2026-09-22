import test from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { MeetingTranscriptionOrchestrator } from "../src/processing/MeetingTranscriptionOrchestrator";
import type {
  TranscriptionEngine,
  TranscriptionRequest,
  TranscriptionEngineResult,
} from "../src/transcription/TranscriptionEngine";
import type { AIProcessRequest, AIProcessResult, AIProvider } from "../src/ai/AIProvider";
import { StorageError } from "../src/storage/errors";
import type { ActionItem, AIProcessingPolicy, AnalysisDocument, Decision } from "../src/domain/models";
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

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    this.transcribeCalls.push(request);
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

function groundedPolicyAnalysis(meetingId: string): FakeAnalysisDocument {
  return {
    meetingId,
    createdAt: new Date().toISOString(),
    summary: "We keep analysis local only on Windows and meeting files stay on the machine.",
    decisions: [{ decisionId: randomUUID(), text: "We keep analysis local only on Windows.", createdAt: new Date().toISOString() }, { decisionId: randomUUID(), text: "Meeting files stay on the machine.", createdAt: new Date().toISOString() }],
    tasks: [{ taskId: randomUUID(), text: "Omar will write the install guide", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { taskId: randomUUID(), text: "Samir will add fail closed tests", status: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    risks: [],
    questions: [],
    followups: []
  };
}

class FakeLocalAIProvider implements AIProvider {
  public readonly descriptor = { id: "fake-ai", name: "Fake AI", displayName: "Fake AI", kind: "LOCAL" as const, dataTransmission: "LOCAL_ONLY" as const, capabilities: { offline: true } };
  public processCalls: AIProcessRequest[] = [];

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    this.processCalls.push(request);
    return {
      providerId: "fake-ai",
      persistedByProvider: false,
      processedAt: new Date().toISOString(),
      output: JSON.stringify(groundedPolicyAnalysis(request.meetingId))
    };
  }
}

class FakeCloudAIProvider implements AIProvider {
  public readonly descriptor = { id: "fake-cloud", name: "Fake Cloud", displayName: "Fake Cloud", kind: "CLOUD" as const, dataTransmission: "cloud" as const, capabilities: { offline: false } };
  public processCalls: AIProcessRequest[] = [];

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    this.processCalls.push(request);
    return {
      providerId: "fake-cloud",
      persistedByProvider: false,
      processedAt: new Date().toISOString(),
      output: JSON.stringify(groundedPolicyAnalysis(request.meetingId))
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

async function createPolicyEnv(storedPolicy: AIProcessingPolicy, analysisProvider: AIProvider) {
  const configRoot = await mkdtemp(join(tmpdir(), "ai-workmate-policy-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-policy-data-"));
  const transcriptionEngine = new FakeTranscriptionEngine();
  const config = new StorageConfigService(join(configRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config, () => new Date(), undefined, {}, { transcriptionEngine, analysisProvider });
  await runtime.configureFirstRun(dataRoot);
  const initialPolicy = (await config.read()).aiProcessingPolicy;
  await runtime.setAiProcessingPolicy(storedPolicy);
  const store = runtime.store;
  assert.ok(store !== undefined, "runtime must attach a store after first-run configuration");

  const originalRead = store.readArtifactBytes.bind(store);
  store.readArtifactBytes = async (relativePath: string) => {
    if (relativePath.endsWith(".aiwpcm")) {
      return Buffer.from(validJsonl, "utf8");
    }
    return originalRead(relativePath);
  };
  return { configRoot, dataRoot, store, runtime, config, transcriptionEngine, analysisProvider, initialPolicy };
}

async function disposePolicyEnv(env: { runtime: StorageRuntime; configRoot: string; dataRoot: string }): Promise<void> {
  await env.runtime.close();
  await rm(env.configRoot, { recursive: true, force: true });
  await rm(env.dataRoot, { recursive: true, force: true });
}

async function setupPolicyMeeting(store: LocalFirstStore): Promise<string> {
  const meetingId = randomUUID();
  const folderName = `Test_Meeting_${randomUUID().slice(0, 8)}`;
  const folderRelativePath = `Meetings/${folderName}`;
  rawDb(store).exec(`
    INSERT INTO meetings (meeting_id, title, slug, folder_name, folder_relative_path, meeting_date, created_at, updated_at, status, storage_version)
    VALUES ('${meetingId}', 'Test Meeting', 'test-meeting', '${folderName}', '${folderRelativePath}', '2026-09-06', '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', 'COMPLETED', 6)
  `);

  const relativePath = `${folderRelativePath}/Recording/Original/meeting_${meetingId}_MICROPHONE_AUDIO.aiwpcm`;
  const dir = join(store.getDataRoot(), folderRelativePath, "Recording/Original");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `meeting_${meetingId}_MICROPHONE_AUDIO.aiwpcm`), Buffer.from(validJsonl, "utf8"));

  const sha256 = createHash("sha256").update(validJsonl).digest("hex");
  rawDb(store).exec(`
    INSERT INTO artifacts (file_id, meeting_id, relative_path, artifact_type, mime_type, size, created_at, modified_at, sha256, status, recording_variant)
    VALUES ('${randomUUID()}', '${meetingId}', '${relativePath}', 'RECORDING_ORIGINAL', 'application/x-ai-workmate-pcm-jsonl', ${validJsonl.length}, '2026-09-06T12:00:00Z', '2026-09-06T12:00:00Z', '${sha256}', 'AVAILABLE', 'ORIGINAL')
  `);
  const fileId = rawDb(store).prepare(`SELECT file_id FROM artifacts WHERE relative_path = '${relativePath}'`).get()!.file_id as string;
  rawDb(store).exec(`
    INSERT INTO recordings (recording_id, meeting_id, artifact_id, recording_variant, created_at, capture_source, final_status, sha256)
    VALUES ('${randomUUID()}', '${meetingId}', '${fileId}', 'ORIGINAL', '2026-09-06T12:00:00Z', 'fake:MICROPHONE_AUDIO', 'COMMITTED', '${sha256}')
  `);
  return meetingId;
}

test("P2-2: stored LOCAL_ONLY allows a local provider through the runtime boundary", async () => {
  const provider = new FakeLocalAIProvider();
  const env = await createPolicyEnv("LOCAL_ONLY", provider);
  try {
    const meetingId = await setupPolicyMeeting(env.store);
    await env.runtime.processCompletedMeeting(meetingId);
    assert.strictEqual(env.store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(provider.processCalls.length, 1);
    assert.strictEqual(env.store.database.listAnalysis(meetingId).length, 7);
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: stored LOCAL_ONLY denies a cloud provider before any transmission", async () => {
  const provider = new FakeCloudAIProvider();
  const env = await createPolicyEnv("LOCAL_ONLY", provider);
  try {
    const meetingId = await setupPolicyMeeting(env.store);
    await assert.rejects(
      env.runtime.processCompletedMeeting(meetingId),
      (error: unknown) => error instanceof StorageError && error.message === "LOCAL_ONLY policy blocks cloud AI processing.",
    );
    assert.strictEqual(provider.processCalls.length, 0);
    assert.strictEqual(env.store.getMeeting(meetingId)?.status, "FAILED");
    assert.strictEqual(env.store.database.listAnalysis(meetingId).length, 0);
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: stored ASK_EACH_TIME denies an unapproved cloud request and stays the default", async () => {
  const provider = new FakeCloudAIProvider();
  const env = await createPolicyEnv("ASK_EACH_TIME", provider);
  try {
    assert.strictEqual(env.initialPolicy, "ASK_EACH_TIME");
    assert.strictEqual((await env.config.read()).aiProcessingPolicy, "ASK_EACH_TIME");
    const meetingId = await setupPolicyMeeting(env.store);
    await assert.rejects(
      env.runtime.processCompletedMeeting(meetingId),
      (error: unknown) =>
        error instanceof StorageError &&
        error.message === "This request requires explicit approval before content is sent to a cloud AI provider.",
    );
    assert.strictEqual(provider.processCalls.length, 0);
    assert.strictEqual(env.store.getMeeting(meetingId)?.status, "FAILED");
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: stored ASK_EACH_TIME allows local providers without approval", async () => {
  const provider = new FakeLocalAIProvider();
  const env = await createPolicyEnv("ASK_EACH_TIME", provider);
  try {
    const meetingId = await setupPolicyMeeting(env.store);
    await env.runtime.processCompletedMeeting(meetingId);
    assert.strictEqual(env.store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(provider.processCalls.length, 1);
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: a stored-policy change applies to the next call without re-attaching the store", async () => {
  const provider = new FakeCloudAIProvider();
  const env = await createPolicyEnv("ASK_EACH_TIME", provider);
  try {
    const meetingId = await setupPolicyMeeting(env.store);
    await assert.rejects(env.runtime.processCompletedMeeting(meetingId), /explicit approval/);
    await env.runtime.setAiProcessingPolicy("LOCAL_ONLY");
    await assert.rejects(env.runtime.processCompletedMeeting(meetingId), /LOCAL_ONLY policy blocks cloud/);
    await env.runtime.setAiProcessingPolicy("ASK_EACH_TIME");
    await assert.rejects(env.runtime.processCompletedMeeting(meetingId), /explicit approval/);
    assert.strictEqual(provider.processCalls.length, 0);
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: per-call approval still authorizes a cloud provider under stored ASK_EACH_TIME", async () => {
  const provider = new FakeCloudAIProvider();
  const env = await createPolicyEnv("ASK_EACH_TIME", provider);
  try {
    const meetingId = await setupPolicyMeeting(env.store);
    await env.runtime.processCompletedMeeting(meetingId, { userApprovedForThisRequest: true });
    assert.strictEqual(env.store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(provider.processCalls.length, 1);
    assert.strictEqual(env.store.database.listAnalysis(meetingId).length, 7);
  } finally {
    await disposePolicyEnv(env);
  }
});

test("P2-2: a per-call policy overrides the orchestrator construction policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-policy-orchestrator-"));
  const store = new LocalFirstStore(root);
  await store.initialize();
  try {
    const originalRead = store.readArtifactBytes.bind(store);
    store.readArtifactBytes = async (relativePath: string) => {
      if (relativePath.endsWith(".aiwpcm")) {
        return Buffer.from(validJsonl, "utf8");
      }
      return originalRead(relativePath);
    };
    const provider = new FakeCloudAIProvider();
    const orchestrator = new MeetingTranscriptionOrchestrator({
      store,
      transcriptionEngine: new FakeTranscriptionEngine(),
      analysisProvider: provider,
      policy: "LOCAL_ONLY",
    });
    const meetingId = await setupPolicyMeeting(store);
    await orchestrator.processCompletedMeeting(meetingId, { policy: "ASK_EACH_TIME", userApprovedForThisRequest: true });
    assert.strictEqual(store.getMeeting(meetingId)?.status, "COMPLETED");
    assert.strictEqual(provider.processCalls.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
