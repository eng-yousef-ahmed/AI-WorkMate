import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { LocalAIProvider, OpenAIProvider, type AIProvider } from "../src/ai/AIProvider";
import {
  AnalysisPolicyDeniedError,
  AnalysisProviderNotConfiguredError,
  LocalAnalysisService,
  unconfiguredLocalAIProvider,
} from "../src/ai/LocalAnalysisService";
import type { AnalysisDocument, TranscriptDocument } from "../src/domain/models";
import {
  AUTOMATION_IPC_CHANNELS,
  CALENDAR_IPC_CHANNELS,
  MEETINGS_IPC_CHANNELS,
  NOTIFICATIONS_IPC_CHANNELS,
  STORAGE_IPC_CHANNELS,
  TASKS_IPC_CHANNELS,
} from "../src/desktop/storage-api";
import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { DataRootValidationError, StorageError } from "../src/storage/errors";
import { withTempStore } from "./helpers";

test("committed transcript yields successful analysis artifacts under DATA_ROOT", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: scriptedLocalProvider(prepared.meetingId),
    });
    const result = await service.analyzeCommittedTranscript({
      meetingId: prepared.meetingId,
      recordingId: prepared.recordingId,
    });
    assert.equal(result.analysis.meetingId, prepared.meetingId);
    assert.equal(result.analysis.summary, "The team committed the release transcript for analysis.");
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "COMPLETED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 7);
    assert.ok(result.relativePath.includes("/Analysis/"));
    assert.ok(result.relativePath.startsWith(`${store.getMeeting(prepared.meetingId)?.folderRelativePath}/`));
    const absolute = store.resolveArtifactAbsolutePath(result.relativePath);
    assert.ok(absolute.startsWith(store.getDataRoot()));
    const persisted = await store.storage.readFile(result.relativePath);
    assert.equal(result.sha256, store.storage.hashBytes(persisted));
    assert.equal(store.database.listArtifactOperations().filter((operation) => operation.artifactType.startsWith("ANALYSIS_")).every((operation) => operation.state === "COMMITTED"), true);
    const sqlite = await store.storage.readFile("Database/ai-workmate.sqlite");
    assert.equal(Buffer.from(sqlite).includes(Buffer.from("The team committed the release transcript for analysis.")), false);
  });
});

test("malformed and schema-invalid provider JSON fail without claiming success", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store, "Malformed");
    const malformed = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalAIProvider(async () => "not-json"),
    });
    await assert.rejects(
      malformed.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }),
      StorageError,
    );
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 0);

    const second = await commitTranscript(store, "Invalid schema");
    const invalid = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalAIProvider(async () => JSON.stringify({
        meetingId: second.meetingId,
        createdAt: "2026-09-02T12:00:00.000Z",
        summary: "ok",
        decisions: [{ decisionId: "", text: "" }],
        tasks: [],
        risks: [],
        questions: [],
        followups: [],
      })),
    });
    await assert.rejects(
      invalid.analyzeCommittedTranscript({ meetingId: second.meetingId, recordingId: second.recordingId }),
      StorageError,
    );
    assert.equal(store.getMeeting(second.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(second.meetingId).length, 0);
  });
});

test("wrong meeting identity and provider failure fail closed", async () => {
  await withTempStore(async (store) => {
    const first = await commitTranscript(store, "First");
    const second = await commitTranscript(store, "Second");
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: scriptedLocalProvider(first.meetingId),
    });
    await assert.rejects(
      service.analyzeCommittedTranscript({ meetingId: first.meetingId, recordingId: second.recordingId }),
      DataRootValidationError,
    );
    const crashing = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalAIProvider(async () => {
        throw new StorageError("provider crashed");
      }),
    });
    await assert.rejects(
      crashing.analyzeCommittedTranscript({ meetingId: second.meetingId, recordingId: second.recordingId }),
      StorageError,
    );
    assert.equal(store.getMeeting(second.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(second.meetingId).length, 0);
  });
});

test("LOCAL_ONLY blocks cloud before content is sent", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    let transmitted = false;
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new OpenAIProvider(async () => {
        transmitted = true;
        return "{}";
      }),
    });
    await assert.rejects(
      service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }),
      AnalysisPolicyDeniedError,
    );
    assert.equal(transmitted, false);
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "COMPLETED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 0);
  });
});

test("ASK_EACH_TIME blocks cloud until explicitly authorized", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    let transmitted = false;
    const cloud = new OpenAIProvider(async (request) => {
      transmitted = true;
      const transcript = JSON.parse(String(request.content)) as TranscriptDocument;
      return JSON.stringify(validAnalysis(transcript.meetingId));
    });
    const service = new LocalAnalysisService({ store, policy: "ASK_EACH_TIME", provider: cloud });
    await assert.rejects(
      service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }),
      AnalysisPolicyDeniedError,
    );
    assert.equal(transmitted, false);
    const result = await service.analyzeCommittedTranscript({
      meetingId: prepared.meetingId,
      recordingId: prepared.recordingId,
      userApprovedForThisRequest: true,
    });
    assert.equal(transmitted, true);
    assert.equal(result.analysis.summary, "The team committed the release transcript for analysis.");
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "COMPLETED");
  });
});

test("CLOUD_ALLOWED permits an injected cloud transport without a real network call", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    const service = new LocalAnalysisService({
      store,
      policy: "CLOUD_ALLOWED",
      provider: new OpenAIProvider(async (request) => {
        const transcript = JSON.parse(String(request.content)) as TranscriptDocument;
        return JSON.stringify(validAnalysis(transcript.meetingId));
      }),
    });
    const result = await service.analyzeCommittedTranscript({
      meetingId: prepared.meetingId,
      recordingId: prepared.recordingId,
    });
    assert.equal(result.analysis.summary, "The team committed the release transcript for analysis.");
  });
});

test("unconfigured production provider never invents analysis text", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    const service = new LocalAnalysisService({ store, policy: "LOCAL_ONLY", provider: unconfiguredLocalAIProvider() });
    await assert.rejects(
      service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }),
      AnalysisProviderNotConfiguredError,
    );
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 0);
  });
});

test("interrupted analysis recovers to INCOMPLETE", async () => {
  await withTempStore(async (store, root) => {
    const prepared = await commitTranscript(store);
    store.beginAnalysis(prepared.meetingId, prepared.recordingId);
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "PROCESSING");
    store.close();
    const recovered = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
    await recovered.initialize();
    try {
      assert.equal(recovered.getMeeting(prepared.meetingId)?.status, "INCOMPLETE");
    } finally {
      recovered.close();
    }
  });
});

test("analysis remains a main-process boundary with no renderer analysis IPC", () => {
  const names = Object.keys(STORAGE_IPC_CHANNELS);
  const values = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(names.some((name) => /analy|openai|provider|summar/i.test(name) && name !== "setAiProcessingPolicy"), false);
  assert.equal(values.some((channel) => /analy|openai|provider|summar/i.test(channel)), false);
});

test("P2-3: ungrounded provider output is rejected before anything is persisted", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitTranscript(store);
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalAIProvider(async () => JSON.stringify({
        meetingId: prepared.meetingId,
        createdAt: "2026-09-02T12:00:00.000Z",
        summary: "Completely unrelated invented wording about nothing relevant.",
        decisions: [{ decisionId: "d1", text: "Invented decision about nothing relevant at all." }],
        tasks: [{ taskId: "t1", text: "Fabricated errand with no transcript overlap whatsoever.", status: "OPEN" }],
        risks: [],
        questions: [],
        followups: [],
      })),
    });
    await assert.rejects(
      service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }),
      (error: unknown) => error instanceof StorageError && error.message.startsWith("Analysis quality rejected: "),
    );
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 0);
    const artifacts = store.database.listArtifacts(prepared.meetingId);
    assert.equal(artifacts.some((artifact) => artifact.artifactType.startsWith("ANALYSIS")), false);
  });
});

test("P2-3: legacy analysis/transcription services stay unreachable through every IPC channel map", () => {
  const channels = [
    ...Object.values(STORAGE_IPC_CHANNELS),
    ...Object.values(MEETINGS_IPC_CHANNELS),
    ...Object.values(AUTOMATION_IPC_CHANNELS),
    ...Object.values(TASKS_IPC_CHANNELS),
    ...Object.values(CALENDAR_IPC_CHANNELS),
    ...Object.values(NOTIFICATIONS_IPC_CHANNELS),
  ];
  assert.ok(channels.length > 0);
  // The only transcript/analysis-reaching channels are the known-good read
  // surfaces; anything else matching provider/engine wording is a leak.
  const knownReads = new Set(["meetings:analysis", "meetings:transcript-content", "meetings:search-transcripts"]);
  for (const channel of channels) {
    if (knownReads.has(channel)) {
      continue;
    }
    assert.equal(
      /analy|transcrib|whisper|stt|llama|openai|provider|summar/i.test(channel),
      false,
      `channel must not expose analysis internals: ${channel}`,
    );
  }
});

async function commitTranscript(store: LocalFirstStore, title = "Analyze me"): Promise<{ meetingId: string; recordingId: string }> {
  const meeting = await store.createMeeting({ title, meetingDate: "2026-09-02" });
  const pcm = Buffer.alloc(8, 3);
  pcm.write(title.slice(0, 8), 0, "utf8");
  const format = {
    container: "AIWPCM_JSONL",
    encoding: "PCM",
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
    averageBytesPerSecond: 32_000,
  };
  const jsonl = `${JSON.stringify({ recordType: "format", source: "MICROPHONE_AUDIO", startedAt: "2026-09-02T10:00:00.000Z", sourceLabel: title, format })}\n${JSON.stringify({
    recordType: "chunk",
    sequence: 0,
    timestamp: "2026-09-02T10:00:01.000Z",
    source: "MICROPHONE_AUDIO",
    format,
    byteLength: pcm.byteLength,
    sha256: createHash("sha256").update(pcm).digest("hex"),
    dataBase64: pcm.toString("base64"),
  })}\n`;
  await store.saveRecording({
    meetingId: meeting.meetingId,
    extension: "aiwpcm",
    mimeType: "application/x-ai-workmate-pcm-jsonl",
    contents: Buffer.from(jsonl, "utf8"),
  });
  const recording = store.database.listRecordings(meeting.meetingId)[0];
  assert.ok(recording);
  const document: TranscriptDocument = {
    meetingId: meeting.meetingId,
    recordingId: recording.recordingId,
    speakers: [],
    timestamps: true,
    segments: [
      { segmentId: randomUUID(), startMs: 0, endMs: 1_000, text: "The team committed the release transcript for analysis today." },
      { segmentId: randomUUID(), startMs: 1_000, endMs: 2_000, text: "We approved the local rollout plan for Thursday." },
      { segmentId: randomUUID(), startMs: 2_000, endMs: 3_000, text: "Omar will verify the release transcript tomorrow." },
    ],
    language: "en",
    createdAt: "2026-09-02T11:00:00.000Z",
  };
  await store.saveTranscript(document, { recordingId: recording.recordingId, engineId: "test-transcript" });
  return { meetingId: meeting.meetingId, recordingId: recording.recordingId };
}

function validAnalysis(meetingId: string): AnalysisDocument {
  return {
    meetingId,
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "The team committed the release transcript for analysis.",
    decisions: [{ decisionId: "d1", text: "We approved the local rollout plan." }],
    tasks: [{ taskId: "t1", text: "Omar will verify the release transcript.", status: "OPEN" }],
    risks: ["None"],
    questions: ["Any follow-up?"],
    followups: ["Schedule next review"],
  };
}

function scriptedLocalProvider(expectedMeetingId: string): AIProvider {
  return new LocalAIProvider(async (request) => {
    assert.equal(request.meetingId, expectedMeetingId);
    const transcript = JSON.parse(String(request.content)) as TranscriptDocument;
    assert.equal(transcript.meetingId, expectedMeetingId);
    assert.ok(transcript.segments.length > 0);
    return JSON.stringify(validAnalysis(expectedMeetingId));
  });
}
