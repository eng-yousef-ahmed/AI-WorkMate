import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import type { TranscriptDocument } from "../src/domain/models";
import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { decodeAiwpcmRecording } from "../src/transcription/AiwpcmRecordingDecoder";
import { LocalTranscriptionService } from "../src/transcription/LocalTranscriptionService";
import {
  TranscriptionError,
  UnconfiguredTranscriptionEngine,
  type TranscriptionEngine,
  type TranscriptionEngineResult,
  type TranscriptionRequest,
} from "../src/transcription/TranscriptionEngine";
import { withTempStore } from "./helpers";

const PCM_FORMAT = {
  container: "AIWPCM_JSONL" as const,
  encoding: "PCM" as const,
  sampleRateHz: 16_000,
  channels: 1,
  bitsPerSample: 16,
  blockAlign: 2,
  averageBytesPerSecond: 32_000,
};

test("valid AIWPCM recording transcribes through an injected local engine and completes", async () => {
  await withTempStore(async (store) => {
    const { meetingId, recordingId, sha256 } = await commitAiwpcmRecording(store);
    const service = new LocalTranscriptionService({ store, engine: new ScriptedLocalEngine() });
    const saved = await service.transcribeRecording(meetingId, recordingId);
    const meeting = store.getMeeting(meetingId);
    const transcripts = store.database.listTranscripts(meetingId);
    const json = await store.storage.readJson<TranscriptDocument>(saved.relativePath);

    assert.equal(meeting?.status, "COMPLETED");
    assert.equal(transcripts.length, 1);
    assert.equal(transcripts[0]?.recordingId, recordingId);
    assert.equal(transcripts[0]?.engineId, "scripted-local-test");
    assert.equal(json.meetingId, meetingId);
    assert.equal(json.recordingId, recordingId);
    assert.equal(json.engine?.id, "scripted-local-test");
    assert.equal(json.segments[0]?.text, "hello from local engine");
    const persisted = await store.storage.readFile(saved.relativePath);
    assert.equal(saved.sha256, store.storage.hashBytes(persisted));
    assert.equal(store.database.getArtifact(saved.artifactId)?.sha256, saved.sha256);
    assert.ok(store.database.listArtifactOperations().every((operation) => operation.state === "COMMITTED"));
    assert.equal(store.database.listRecordings(meetingId)[0]?.sha256, sha256);
  });
});

test("malformed JSONL, sequence gaps, hash mismatch, and empty recordings fail closed", async () => {
  await withTempStore(async (store) => {
    const engine = new ScriptedLocalEngine();
    const service = new LocalTranscriptionService({ store, engine });

    await assert.rejects(
      transcribeContents(store, service, "{not-json\n"),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_RECORDING_INVALID",
    );
    await assert.rejects(
      transcribeContents(store, service, encodeAiwpcmJsonl({ sequence: 7 })),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_SEQUENCE_INVALID",
    );
    await assert.rejects(
      transcribeContents(store, service, encodeAiwpcmJsonl({ sha256: "0".repeat(64) })),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_RECORDING_CORRUPTED",
    );
    await assert.rejects(
      transcribeContents(store, service, ""),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_RECORDING_EMPTY",
    );
  });
});

test("unconfigured production engine never invents transcript text", async () => {
  await withTempStore(async (store) => {
    const { meetingId, recordingId } = await commitAiwpcmRecording(store);
    const service = new LocalTranscriptionService({ store, engine: new UnconfiguredTranscriptionEngine() });
    await assert.rejects(
      service.transcribeRecording(meetingId, recordingId),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_NOT_CONFIGURED",
    );
    assert.equal(store.getMeeting(meetingId)?.status, "FAILED");
    assert.equal(store.database.listTranscripts(meetingId).length, 0);
  });
});

test("transcription isolates meetings and recordings", async () => {
  await withTempStore(async (store) => {
    const first = await commitAiwpcmRecording(store, "Alpha");
    const second = await commitAiwpcmRecording(store, "Beta");
    const service = new LocalTranscriptionService({ store, engine: new ScriptedLocalEngine() });
    await assert.rejects(
      service.transcribeRecording(first.meetingId, second.recordingId),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_MEETING_MISMATCH",
    );
    await service.transcribeRecording(first.meetingId, first.recordingId);
    assert.equal(store.database.listTranscripts(first.meetingId).length, 1);
    assert.equal(store.database.listTranscripts(second.meetingId).length, 0);
    assert.equal(store.getMeeting(second.meetingId)?.status, "COMPLETED");
  });
});

test("path escape is rejected before read", async () => {
  await withTempStore(async (store) => {
    const { meetingId, recordingId } = await commitAiwpcmRecording(store);
    const recording = store.getRecording(recordingId);
    assert.ok(recording);
    const wrapper = Object.create(store) as LocalFirstStore;
    wrapper.getRecording = () => ({ ...recording, relativePath: "../outside.aiwpcm" });
    const service = new LocalTranscriptionService({ store: wrapper, engine: new ScriptedLocalEngine() });
    await assert.rejects(
      service.transcribeRecording(meetingId, recordingId),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_PATH_REJECTED",
    );
  });
});

test("interrupted transcription recovers to INCOMPLETE", async () => {
  await withTempStore(async (store, root) => {
    const { meetingId, recordingId } = await commitAiwpcmRecording(store);
    store.beginTranscription(meetingId, recordingId);
    assert.equal(store.getMeeting(meetingId)?.status, "PROCESSING");
    store.close();

    const recovered = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
    await recovered.initialize();
    try {
      assert.equal(recovered.getMeeting(meetingId)?.status, "INCOMPLETE");
    } finally {
      recovered.close();
    }
  });
});

test("decoder reconstructs aligned PCM and WAV headers", () => {
  const prepared = decodeAiwpcmRecording(Buffer.from(encodeAiwpcmJsonl({}), "utf8"));
  assert.equal(prepared.pcm.byteLength, 8);
  assert.equal(Buffer.from(prepared.wav).toString("ascii", 0, 4), "RIFF");
  assert.equal(prepared.chunkCount, 1);
  assert.equal(prepared.sampleRateHz, 16_000);
});

async function transcribeContents(store: LocalFirstStore, service: LocalTranscriptionService, contents: string): Promise<void> {
  const meeting = await store.createMeeting({ title: `Case ${randomUUID()}`, meetingDate: "2026-09-02" });
  await store.saveRecording({
    meetingId: meeting.meetingId,
    extension: "aiwpcm",
    mimeType: "application/x-ai-workmate-pcm-jsonl",
    contents: Buffer.from(contents, "utf8"),
  });
  const recording = store.database.listRecordings(meeting.meetingId)[0];
  assert.ok(recording);
  await service.transcribeRecording(meeting.meetingId, recording.recordingId);
}

async function commitAiwpcmRecording(store: LocalFirstStore, title = "Transcribe me"): Promise<{ meetingId: string; recordingId: string; sha256: string }> {
  const meeting = await store.createMeeting({ title, meetingDate: "2026-09-02" });
  const contents = Buffer.from(encodeAiwpcmJsonl({ salt: title }), "utf8");
  const artifact = await store.saveRecording({
    meetingId: meeting.meetingId,
    extension: "aiwpcm",
    mimeType: "application/x-ai-workmate-pcm-jsonl",
    contents,
  });
  const recording = store.database.listRecordings(meeting.meetingId)[0];
  assert.ok(recording);
  return { meetingId: meeting.meetingId, recordingId: recording.recordingId, sha256: artifact.sha256 };
}

function encodeAiwpcmJsonl(options: { sequence?: number; sha256?: string; salt?: string } = {}): string {
  const pcm = Buffer.alloc(8, 7);
  if (options.salt !== undefined) {
    pcm.write(options.salt.slice(0, 8), 0, "utf8");
  }
  const format = {
    recordType: "format",
    source: "MICROPHONE_AUDIO",
    startedAt: "2026-09-02T10:00:00.000Z",
    sourceLabel: options.salt ?? "mic",
    format: PCM_FORMAT,
  };
  const chunk = {
    recordType: "chunk",
    sequence: options.sequence ?? 0,
    timestamp: "2026-09-02T10:00:01.000Z",
    source: "MICROPHONE_AUDIO",
    format: PCM_FORMAT,
    byteLength: pcm.byteLength,
    sha256: options.sha256 ?? createHash("sha256").update(pcm).digest("hex"),
    dataBase64: pcm.toString("base64"),
  };
  return `${JSON.stringify(format)}\n${JSON.stringify(chunk)}\n`;
}

class ScriptedLocalEngine implements TranscriptionEngine {
  public readonly descriptor = {
    id: "scripted-local-test",
    displayName: "Scripted local test engine",
    kind: "LOCAL" as const,
  };

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    return {
      meetingId: request.meetingId,
      recordingId: request.recordingId,
      language: "en",
      speakers: [{ speakerId: "spk-1", displayName: "Speaker" }],
      timestamps: true,
      segments: [
        {
          segmentId: "seg-1",
          speakerId: "spk-1",
          startMs: 0,
          endMs: request.audio.durationMs || 250,
          text: "hello from local engine",
          confidence: 0.9,
        },
      ],
      engine: this.descriptor,
    };
  }
}
