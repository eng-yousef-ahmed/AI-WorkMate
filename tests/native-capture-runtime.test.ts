import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  NativeCaptureError,
  NATIVE_CAPTURE_KINDS,
  WINDOWS_AUDIO_CAPTURE_FORMAT,
  WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  WindowsNativeAudioProvider,
  type NativeCaptureKind,
  type WindowsAudioHelperProcess,
  type WindowsAudioHelperRunner,
  type WindowsAudioPcmFormat,
} from "../src";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import { StorageConfigService } from "../src/storage/StorageConfigService";
import { StorageRuntime } from "../src/storage/StorageRuntime";

const PCM_FORMAT: WindowsAudioPcmFormat = {
  container: "AIWPCM_JSONL",
  encoding: "PCM",
  sampleRateHz: 48_000,
  channels: 2,
  bitsPerSample: 32,
  blockAlign: 8,
  averageBytesPerSecond: 384_000,
};

test("StorageRuntime wires native capture through LocalFirstStore without renderer IPC", async () => {
  await withRuntime(async (runtime, root) => {
    const meeting = await runtime.store?.createMeeting({ title: "Runtime native capture", meetingDate: "2026-09-01" });
    assert.ok(meeting);
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });
    assert.equal(started.state, "RECORDING");
    assert.equal(runtime.store?.getMeeting(meeting.meetingId)?.status, "RECORDING");

    const stopped = await runtime.stopNativeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    const stored = await readFile(join(root, stopped.relativePath ?? ""), "utf8");

    assert.equal(stopped.state, "COMPLETED");
    assert.equal(runtime.store?.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(runtime.store?.database.listArtifactOperations().at(-1)?.state, "COMMITTED");
    assert.equal(runtime.store?.database.listRecordings(meeting.meetingId)[0]?.captureSource, "windows-native-audio-provider:MICROPHONE_AUDIO");
    assert.match(stored, /"recordType":"format"/);
    assert.match(stored, /"recordType":"chunk"/);
    assert.equal(stopped.sha256, createHash("sha256").update(stored).digest("hex"));
    assert.equal(JSON.stringify(stopped).includes(root), false);
  });
});

test("StorageRuntime native capture fail-closes permission denial and malformed records", async () => {
  await withRuntime(async (runtime) => {
    const denied = await runtime.store?.createMeeting({ title: "Permission denied", meetingDate: "2026-09-01" });
    assert.ok(denied);
    await assert.rejects(
      runtime.startNativeCapture({
        meetingId: denied.meetingId,
        capability: "SYSTEM_AUDIO",
        sourceId: "render-denied",
        format: WINDOWS_AUDIO_CAPTURE_FORMAT,
        mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PERMISSION_DENIED",
    );
    assert.equal(runtime.store?.getMeeting(denied.meetingId)?.status, "SCHEDULED");
  }, {
    capabilityErrors: {
      SYSTEM_AUDIO: { code: "NATIVE_PERMISSION_DENIED", message: "Loopback permission denied.", retryable: true },
    },
  });

  await withRuntime(async (runtime) => {
    const meeting = await runtime.store?.createMeeting({ title: "Malformed native record", meetingDate: "2026-09-01" });
    assert.ok(meeting);
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });
    await assert.rejects(
      runtime.stopNativeCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STREAM_FAILED",
    );
    assert.equal(runtime.store?.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(runtime.store?.database.listRecordings(meeting.meetingId).length, 0);
  }, { malformedChunk: true });
});

test("StorageRuntime native capture abort and process failure stay incomplete", async () => {
  await withRuntime(async (runtime) => {
    const meeting = await runtime.store?.createMeeting({ title: "Abort native", meetingDate: "2026-09-01" });
    assert.ok(meeting);
    const started = await runtime.startNativeCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });
    const aborted = await runtime.abortNativeCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      reason: "user abort",
    });
    assert.equal(aborted.state, "INCOMPLETE");
    assert.equal(runtime.store?.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
  });
});

test("StorageRuntime native capture discovery remains fail-closed without exposing paths", async () => {
  await withRuntime(async (runtime) => {
    const discovered = await runtime.discoverNativeCaptureCapabilities();
    assert.equal(discovered.capabilities.MICROPHONE_AUDIO.available, true);
    assert.equal(discovered.capabilities.SCREEN.available, false);
    assert.equal(JSON.stringify(discovered).includes("C:\\"), false);
    assert.equal(JSON.stringify(discovered).includes("/tmp"), false);
    for (const kind of NATIVE_CAPTURE_KINDS) {
      assert.equal(JSON.stringify(discovered.capabilities[kind]).includes("helperPath"), false);
    }
  });
});

test("native capture remains a main-process boundary with no renderer capture IPC", () => {
  const channelNames = Object.keys(STORAGE_IPC_CHANNELS);
  const channelValues = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(channelNames.some((name) => /native|capture|recording|helper|wasapi/i.test(name)), false);
  assert.equal(channelValues.some((channel) => /native|capture|recording|output-path|source-path|helper/i.test(channel)), false);
});

async function withRuntime(
  work: (runtime: StorageRuntime, root: string) => Promise<void>,
  options: { capabilityErrors?: Record<string, { code: string; message: string; retryable: boolean }>; malformedChunk?: boolean } = {},
): Promise<void> {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-native-runtime-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-native-runtime-data-"));
  const runtime = new StorageRuntime(
    new StorageConfigService(join(appConfigRoot, "storage-config.json")),
    () => new Date("2026-09-01T10:00:00.000Z"),
    undefined,
    { spaceSafetyMarginBytes: 0 },
    {
      nativeCaptureAdapter: new WindowsNativeAudioProvider({
        platform: "win32",
        helperRunner: scriptedRunner(options),
        clock: () => new Date("2026-09-01T10:00:00.000Z"),
      }),
    },
  );
  try {
    await runtime.configureFirstRun(dataRoot);
    await work(runtime, dataRoot);
  } finally {
    await runtime.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function scriptedRunner(options: { capabilityErrors?: Record<string, { code: string; message: string; retryable: boolean }>; malformedChunk?: boolean }): WindowsAudioHelperRunner {
  return (args) => {
    if (args[0] === "capabilities") {
      return completed(JSON.stringify({
        checkedAt: "2026-09-01T10:00:00.000Z",
        microphone: [{ id: "mic-default", label: "Jack Mic", isDefault: true }],
        systemAudio: [{ id: "render-default", label: "Speakers / Headphones", isDefault: true }],
        errors: options.capabilityErrors,
      }));
    }
    const kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO"> = args.includes("loopback") ? "SYSTEM_AUDIO" : "MICROPHONE_AUDIO";
    const sourceId = kind === "MICROPHONE_AUDIO" ? "mic-default" : "render-default";
    const pcm = Buffer.from("runtime-native-frame");
    const lines = [
      JSON.stringify({
        recordType: "format",
        source: kind,
        sourceId,
        sourceLabel: kind === "MICROPHONE_AUDIO" ? "Jack Mic" : "Speakers / Headphones",
        startedAt: "2026-09-01T10:00:00.000Z",
        format: PCM_FORMAT,
      }),
      options.malformedChunk === true
        ? "{not-json"
        : JSON.stringify({
            recordType: "chunk",
            sequence: 0,
            timestamp: "2026-09-01T10:00:01.000Z",
            source: kind,
            sourceId,
            format: PCM_FORMAT,
            byteLength: pcm.byteLength,
            sha256: createHash("sha256").update(pcm).digest("hex"),
            dataBase64: pcm.toString("base64"),
          }),
    ];
    return completed(`${lines.join("\n")}\n`);
  };
}

function completed(stdout: string): WindowsAudioHelperProcess {
  return {
    stdout: (async function* () {
      yield Buffer.from(stdout, "utf8");
    })(),
    stderr: (async function* () {})(),
    stdin: { write: () => true, end: () => undefined },
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => undefined,
  };
}

