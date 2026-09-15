import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import { TranscriptionError } from "../src/transcription/TranscriptionEngine";
import { prepareWhisperWav } from "../src/transcription/PrepareWhisperAudio";
import {
  WindowsLocalWhisperEngine,
  resolveWhisperTimeoutMs,
  type WhisperHelperProcess,
  type WhisperHelperRunner,
} from "../src/transcription/WindowsLocalWhisperEngine";
import { runWindowsLocalTranscriptionVerification } from "../src/transcription/WindowsLocalTranscriptionVerification";
import { LocalTranscriptionService } from "../src/transcription/LocalTranscriptionService";
import { withTempStore } from "./helpers";

test("production whisper engine fail-closes when CLI and model are missing", async () => {
  const engine = new WindowsLocalWhisperEngine({
    platform: "win32",
    localAppData: join(tmpdir(), "ai-workmate-missing-whisper"),
  });
  await assert.rejects(
    engine.transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE",
  );
});

test("non-Windows platforms are unavailable without an injected helper", async () => {
  const engine = new WindowsLocalWhisperEngine({ platform: "linux" });
  await assert.rejects(
    engine.transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE",
  );
});

test("injected whisper helper transcribes prepared audio without inventing speakers", async () => {
  const engine = new WindowsLocalWhisperEngine({
    platform: "linux",
    helperRunner: scriptedWhisperRunner({ text: "actual local speech text" }),
  });
  const result = await engine.transcribe(sampleRequest("rec-hash"));
  assert.equal(result.segments[0]?.text, "actual local speech text");
  assert.equal(result.speakers.length, 0);
  assert.equal(result.timestamps, true);
  assert.equal(result.sourceRecordingSha256, "rec-hash");
  assert.equal(result.engine.id, "windows-local-whisper");
});

test("malformed helper JSON, crash, timeout, and cancellation fail closed", async () => {
  await assert.rejects(
    new WindowsLocalWhisperEngine({ platform: "linux", helperRunner: scriptedWhisperRunner({ stdout: "{not-json" }) }).transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_INVALID_OUTPUT",
  );
  await assert.rejects(
    new WindowsLocalWhisperEngine({ platform: "linux", helperRunner: scriptedWhisperRunner({ exitCode: 7 }) }).transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_CRASHED",
  );
  await assert.rejects(
    new WindowsLocalWhisperEngine({ platform: "linux", timeoutMs: 20, helperRunner: unkillableRunner() }).transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_TIMEOUT",
  );
  const controller = new AbortController();
  const pending = new WindowsLocalWhisperEngine({ platform: "linux", timeoutMs: 5_000, helperRunner: hangingRunner() }).transcribe(sampleRequest(undefined, controller.signal));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_CANCELLED");
});

test("invalid helper and model paths are rejected", async () => {
  const engine = new WindowsLocalWhisperEngine({
    platform: "win32",
    helperPath: "../whisper-cli.exe",
  });
  await assert.rejects(
    engine.transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && (error.code === "TRANSCRIPTION_PATH_REJECTED" || error.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE"),
  );
});

test("truncated non-ggml model files are unavailable", async () => {
  const root = join(tmpdir(), `ai-workmate-bad-model-${Date.now()}`);
  const modelDir = join(root, "AI-WorkMate", "models", "whisper");
  const nativeDir = join(root, "AI-WorkMate", "native");
  await mkdir(modelDir, { recursive: true });
  await mkdir(nativeDir, { recursive: true });
  await writeFile(join(nativeDir, "whisper-cli.exe"), "not-an-exe");
  await writeFile(join(modelDir, "ggml-tiny.bin"), "nope");
  const engine = new WindowsLocalWhisperEngine({ platform: "win32", localAppData: root });
  await assert.rejects(
    engine.transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE",
  );
});

test("empty PCM is rejected before the helper is spawned", async () => {
  const engine = new WindowsLocalWhisperEngine({
    platform: "linux",
    helperRunner: scriptedWhisperRunner({ text: "should not run" }),
  });
  await assert.rejects(
    engine.transcribe({
      meetingId: "m",
      recordingId: "r",
      audio: {
        sampleRateHz: 16_000,
        channels: 1,
        bitsPerSample: 16,
        pcm: new Uint8Array(),
        wav: new Uint8Array(),
        durationMs: 0,
        chunkCount: 0,
      },
    }),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_RECORDING_EMPTY",
  );
});

test("48 kHz 32-bit stereo PCM is resampled to 16 kHz mono WAV", () => {
  const frames = 480;
  const pcm = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame += 1) {
    pcm.writeFloatLE(0.1, frame * 8);
    pcm.writeFloatLE(-0.1, frame * 8 + 4);
  }
  const wav = prepareWhisperWav({
    sampleRateHz: 48_000,
    channels: 2,
    bitsPerSample: 32,
    pcm,
    wav: new Uint8Array(),
    durationMs: 10,
    chunkCount: 1,
  });
  assert.equal(Buffer.from(wav).subarray(0, 4).toString("ascii"), "RIFF");
  assert.ok(wav.byteLength > 44);
});

test("whisper engine plus store isolates meetings and completes lifecycle", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Whisper isolation", meetingDate: "2026-09-02" });
    const pcm = Buffer.alloc(32, 1);
    const format = {
      container: "AIWPCM_JSONL",
      encoding: "PCM",
      sampleRateHz: 16_000,
      channels: 1,
      bitsPerSample: 16,
      blockAlign: 2,
      averageBytesPerSecond: 32_000,
    };
    const { createHash } = await import("node:crypto");
    const jsonl = `${JSON.stringify({ recordType: "format", source: "MICROPHONE_AUDIO", startedAt: "2026-09-02T10:00:00.000Z", format })}\n${JSON.stringify({
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
    const other = await store.createMeeting({ title: "Other meeting", meetingDate: "2026-09-02" });
    const service = new LocalTranscriptionService({
      store,
      engine: new WindowsLocalWhisperEngine({ platform: "linux", helperRunner: scriptedWhisperRunner({ text: "isolated speech" }) }),
    });
    await assert.rejects(
      service.transcribeRecording(other.meetingId, recording.recordingId),
      (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_MEETING_MISMATCH",
    );
    const saved = await service.transcribeRecording(meeting.meetingId, recording.recordingId);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "COMPLETED");
    assert.equal(store.database.listTranscripts(meeting.meetingId)[0]?.recordingId, recording.recordingId);
    assert.equal(saved.sha256.length, 64);
  });
});

test("Windows transcription verification fail-closes off Windows without fake media", async () => {
  const result = await runWindowsLocalTranscriptionVerification({ platform: "linux" });
  assert.equal(result.success, false);
  assert.equal(result.windowsVerified, false);
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.failureCode, "TRANSCRIPTION_ENGINE_UNAVAILABLE");
});

test("transcription remains a main-process boundary with no renderer STT IPC", () => {
  const names = Object.keys(STORAGE_IPC_CHANNELS);
  const values = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(names.some((name) => /transcri|whisper|stt/i.test(name)), false);
  assert.equal(values.some((channel) => /transcri|whisper|stt/i.test(channel)), false);
});

function sampleRequest(sourceRecordingSha256?: string, signal?: AbortSignal) {
  const pcm = Buffer.alloc(32, 2);
  return {
    meetingId: "11111111-1111-4111-8111-111111111111",
    recordingId: "22222222-2222-4222-8222-222222222222",
    sourceRecordingSha256,
    signal,
    audio: {
      sampleRateHz: 16_000,
      channels: 1,
      bitsPerSample: 16,
      pcm,
      wav: pcm,
      durationMs: 1,
      chunkCount: 1,
    },
  };
}

function scriptedWhisperRunner(options: { text?: string; stdout?: string; exitCode?: number }): WhisperHelperRunner {
  return () => completed(
    options.stdout ?? JSON.stringify({
      language: "en",
      model: "ggml-tiny.bin",
      segments: [{ startMs: 0, endMs: 800, text: options.text ?? "hello" }],
    }),
    options.exitCode ?? 0,
  );
}

function unkillableRunner(): WhisperHelperRunner {
  return () => ({
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exited: new Promise(() => undefined),
    kill: () => undefined,
  });
}

function hangingRunner(): WhisperHelperRunner {
  return () => {
    let settle: ((exit: { code: number | null; signal: NodeJS.Signals | string | null }) => void) | undefined;
    return {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exited: new Promise((resolve) => {
        settle = resolve;
      }),
      kill: () => settle?.({ code: null, signal: "SIGTERM" }),
    };
  };
}

function completed(stdout: string, code = 0): WhisperHelperProcess {
  return {
    stdout: (async function* () {
      yield Buffer.from(stdout, "utf8");
    })(),
    stderr: (async function* () {})(),
    exited: Promise.resolve({ code, signal: null }),
    kill: () => undefined,
  };
}

test("P1-2a: whisper timeout keeps the 120 s floor for short or invalid durations", () => {
  assert.equal(resolveWhisperTimeoutMs(0), 120_000);
  assert.equal(resolveWhisperTimeoutMs(1), 120_000);
  assert.equal(resolveWhisperTimeoutMs(59_999), 120_000);
  assert.equal(resolveWhisperTimeoutMs(60_000), 120_000);
  assert.equal(resolveWhisperTimeoutMs(-5), 120_000);
  assert.equal(resolveWhisperTimeoutMs(Number.NaN), 120_000);
  assert.equal(resolveWhisperTimeoutMs(Number.POSITIVE_INFINITY), 120_000);
});

test("P1-2a: whisper timeout scales linearly with audio duration", () => {
  assert.equal(resolveWhisperTimeoutMs(60_001), 120_002);
  assert.equal(resolveWhisperTimeoutMs(120_000), 240_000);
  assert.equal(resolveWhisperTimeoutMs(3_600_000), 7_200_000);
});

test("P1-2a: explicit timeoutMs override takes precedence over duration scaling", async () => {
  const request = sampleRequest();
  const engine = new WindowsLocalWhisperEngine({ platform: "linux", timeoutMs: 20, helperRunner: unkillableRunner() });
  // 1 h of audio would scale to a 2 h budget; the 20 ms override must win and
  // the failure must report the override value.
  await assert.rejects(
    engine.transcribe({ ...request, audio: { ...request.audio, durationMs: 3_600_000 } }),
    (error: unknown) =>
      error instanceof TranscriptionError &&
      error.code === "TRANSCRIPTION_ENGINE_TIMEOUT" &&
      error.message.includes("after 20ms"),
  );
});

test("P1-2a: timed-out helper is killed and the work directory is removed", async () => {
  const prefix = "ai-workmate-whisper-";
  const before = new Set(await readdir(tmpdir()));
  let killed = false;
  const engine = new WindowsLocalWhisperEngine({
    platform: "linux",
    timeoutMs: 20,
    helperRunner: () => ({
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exited: new Promise<never>(() => undefined),
      kill: () => {
        killed = true;
      },
    }),
  });
  await assert.rejects(
    engine.transcribe(sampleRequest()),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_TIMEOUT",
  );
  assert.equal(killed, true);
  const after = await readdir(tmpdir());
  const leftovers = after.filter((entry) => entry.startsWith(prefix) && !before.has(entry));
  assert.deepEqual(leftovers, []);
});
