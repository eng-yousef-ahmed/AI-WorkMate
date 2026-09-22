import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  LocalRecordingCaptureEngine,
  NativeCaptureCoordinator,
  NativeCaptureError,
  NATIVE_CAPTURE_KINDS,
  WindowsCompositeNativeCaptureProvider,
  WindowsNativeScreenProvider,
  WINDOWS_SCREEN_CAPTURE_FORMAT,
  WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
  type NativeCaptureKind,
  type NativeCapturePolicy,
  type WindowsScreenHelperExit,
  type WindowsScreenHelperProcess,
  type WindowsScreenHelperRunner,
  type WindowsScreenHelperStdin,
  type WindowsVideoFormat,
} from "../src";
import { withTempStore } from "./helpers";

const JPEG_FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02]);
const VIDEO_FORMAT: WindowsVideoFormat = {
  container: "AIWVID_JSONL",
  encoding: "JPEG",
  width: 640,
  height: 360,
  bitsPerPixel: 32,
  frameIntervalMs: 200,
};

const ALL_VIDEO_ALLOWED: Partial<NativeCapturePolicy> = {
  SCREEN: "ALLOW",
  WINDOW: "ALLOW",
};

test("Windows native screen provider fails closed on non-Windows platforms", async () => {
  const provider = new WindowsNativeScreenProvider({
    platform: "linux",
    helperRunner: () => {
      throw new Error("helper must not run on Linux");
    },
    clock: fixedClock(),
  });
  const discovered = await provider.discoverCapabilities();
  assert.equal(discovered.supported, false);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PLATFORM_UNSUPPORTED");
  }
  await assert.rejects(
    provider.startCapture({ capability: "SCREEN", format: WINDOWS_SCREEN_CAPTURE_FORMAT, mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PLATFORM_UNSUPPORTED",
  );
});

test("Windows native screen provider reports missing helper without mock fallback", async () => {
  const provider = new WindowsNativeScreenProvider({
    platform: "win32",
    helperPath: "C:/missing/AIWorkMate.WindowsScreenCapture.exe",
    clock: fixedClock(),
  });
  const discovered = await provider.discoverCapabilities();
  assert.equal(discovered.supported, true);
  await assert.rejects(
    provider.startCapture({ capability: "SCREEN", format: WINDOWS_SCREEN_CAPTURE_FORMAT, mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PROVIDER_NOT_CONFIGURED",
  );
});

test("Windows native screen provider discovers displays and windows from the helper", async () => {
  const runner = new ScriptedHelperRunner((args) => {
    assert.deepEqual(args, ["capabilities", "--json"]);
    return completedProcess(JSON.stringify({
      checkedAt: "2026-09-01T10:00:00.000Z",
      displays: [{ id: "display:DISPLAY1", label: "Primary display", isDefault: true, width: 1920, height: 1080 }],
      windows: [{ id: "hwnd:00000000000A1B2C", label: "Notepad" }],
    }));
  });
  const provider = new WindowsNativeScreenProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
  const discovered = await provider.discoverCapabilities();
  assert.equal(discovered.adapterId, "windows-native-screen-provider");
  assert.equal(discovered.capabilities.SCREEN.available, true);
  assert.equal(discovered.capabilities.SCREEN.sources?.[0]?.sourceId, "display:DISPLAY1");
  assert.equal(discovered.capabilities.WINDOW.available, true);
  assert.equal(discovered.capabilities.WINDOW.sources?.[0]?.sourceId, "hwnd:00000000000A1B2C");
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.available, false);
  assert.equal(JSON.stringify(discovered).includes("C:\\"), false);
});

test("Windows native screen session validates JPEG SOI SHA-256 sequence and timestamps", async () => {
  const runner = new ScriptedHelperRunner((args) => {
    assert.deepEqual(args, ["capture", "--kind", "screen", "--format", "aiwvid-jsonl", "--source-id", "display:DISPLAY1"]);
    return completedProcess([
      formatLine("SCREEN", "display:DISPLAY1"),
      chunkLine("SCREEN", 0, "display:DISPLAY1", JPEG_FRAME, "2026-09-01T10:00:01.000Z"),
    ].join("\n") + "\n");
  });
  const provider = new WindowsNativeScreenProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
  const session = await provider.startCapture({
    capability: "SCREEN",
    sourceId: "display:DISPLAY1",
    format: WINDOWS_SCREEN_CAPTURE_FORMAT,
    mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
  });
  const chunks = await collect(session.chunks);
  await session.stop();
  const serialized = Buffer.concat(chunks).toString("utf8");
  assert.match(serialized, /"recordType":"format"/);
  assert.match(serialized, /"recordType":"chunk"/);
  assert.equal(runner.processes[0]?.stdinWrites.includes("stop\n"), true);
});

test("Windows native screen capture feeds the existing local storage pipeline", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Screen native provider", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("SCREEN", "display:DISPLAY1", [JPEG_FRAME, JPEG_FRAME]);
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_VIDEO_ALLOWED,
    });
    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "SCREEN",
      sourceId: "display:DISPLAY1",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
    });
    const stopped = await coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    assert.equal(stopped.state, "COMPLETED");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "COMMITTED");
    assert.equal(store.database.listRecordings(meeting.meetingId)[0]?.captureSource, "windows-native-screen-provider:SCREEN");
    const stored = await readFile(join(root, stopped.relativePath ?? ""), "utf8");
    assert.match(stored, /"source":"SCREEN"/);
    assert.equal(stopped.sha256, createHash("sha256").update(stored).digest("hex"));
  });
});

test("Windows native window capture requires a validated hwnd source ID", async () => {
  const provider = providerWithCapabilities({
    displays: [{ id: "display:DISPLAY1", label: "Primary display", isDefault: true }],
    windows: [{ id: "hwnd:00000000000A1B2C", label: "Notepad" }],
  });
  await assert.rejects(
    provider.startCapture({ capability: "WINDOW", format: WINDOWS_SCREEN_CAPTURE_FORMAT, mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPABILITY_UNAVAILABLE",
  );
  await assert.rejects(
    provider.startCapture({
      capability: "WINDOW",
      sourceId: "../evil",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
    }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPABILITY_UNAVAILABLE",
  );
});

test("Windows native screen provider rejects out-of-order chunks and non-JPEG payloads", async () => {
  const outOfOrder = providerWithCapture("SCREEN", "display:DISPLAY1", [JPEG_FRAME, JPEG_FRAME], { secondSequence: 2 });
  await assert.rejects(
    collect((await outOfOrder.startCapture({
      capability: "SCREEN",
      sourceId: "display:DISPLAY1",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
    })).chunks),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_CHUNK_OUT_OF_ORDER",
  );
  const notJpeg = providerWithCapture("SCREEN", "display:DISPLAY1", [Buffer.from("not-jpeg")]);
  await assert.rejects(
    collect((await notJpeg.startCapture({
      capability: "SCREEN",
      sourceId: "display:DISPLAY1",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
    })).chunks),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STREAM_FAILED" && error.message.includes("JPEG"),
  );
});

test("Windows native window capture surfaces the helper's structured zero-frame pipeline state", async () => {
  const state = {
    stage: "frame-arrival",
    startCaptureSucceeded: true,
    frameArrivedCount: 0,
    tryGetNextFrameCount: 0,
    tryGetNextFrameNullCount: 0,
    frameAcquiredCount: 0,
    readbackCount: 0,
    jpegEncodedCount: 0,
    encodeFailureCount: 0,
    itemClosed: false,
    monitor: "\\\\.\\DISPLAY1",
    elapsedMs: 10000,
  };
  const runner = new ScriptedHelperRunner((args) => {
    assert.deepEqual(args, ["capture", "--kind", "window", "--format", "aiwvid-jsonl", "--source-id", "hwnd:00000000000A1B2C"]);
    return completedProcess(`${JSON.stringify({
      recordType: "error",
      code: "NATIVE_CAPTURE_STREAM_FAILED",
      message: "Windows Graphics Capture delivered no JPEG frames for window \"Notepad\" (hwnd:00000000000A1B2C) over 10000ms [stage:frame-arrival]: startCaptureSucceeded=True frameArrivedCount=0.",
      retryable: true,
      state,
    })}\n`);
  });
  const provider = new WindowsNativeScreenProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
  const session = await provider.startCapture({
    capability: "WINDOW",
    sourceId: "hwnd:00000000000A1B2C",
    format: WINDOWS_SCREEN_CAPTURE_FORMAT,
    mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
  });
  await assert.rejects(
    collect(session.chunks),
    (error: unknown) =>
      error instanceof NativeCaptureError &&
      error.code === "NATIVE_CAPTURE_STREAM_FAILED" &&
      error.message.includes("[stage:frame-arrival]") &&
      error.state?.stage === "frame-arrival" &&
      error.state?.frameArrivedCount === 0 &&
      error.state?.startCaptureSucceeded === true &&
      error.state?.monitor === "\\\\.\\DISPLAY1",
  );
});

test("Windows native screen abort and disk-full stay incomplete without SQLite recording", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Screen abort", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("SCREEN", "display:DISPLAY1", [JPEG_FRAME]);
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_VIDEO_ALLOWED,
    });
    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "SCREEN",
      sourceId: "display:DISPLAY1",
      format: WINDOWS_SCREEN_CAPTURE_FORMAT,
      mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
    });
    const aborted = await coordinator.abortCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      reason: "user abort",
    });
    assert.equal(aborted.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });

  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Screen disk full", meetingDate: "2026-09-01" });
    const runner = runnerForCapture("SCREEN", "display:DISPLAY1", [JPEG_FRAME]);
    const provider = new WindowsNativeScreenProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_VIDEO_ALLOWED,
    });
    await assert.rejects(
      coordinator.startCapture({
        meetingId: meeting.meetingId,
        capability: "SCREEN",
        sourceId: "display:DISPLAY1",
        format: WINDOWS_SCREEN_CAPTURE_FORMAT,
        mimeType: WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
        estimatedBytes: 1,
      }),
      /Insufficient disk space/,
    );
    assert.equal(runner.processes.some((process) => process.killed), true);
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => 0 });
});

test("Windows composite provider keeps audio available when the screen helper is missing", async () => {
  const composite = new WindowsCompositeNativeCaptureProvider({
    platform: "win32",
    audio: {
      discoverCapabilities: async () => ({
        platform: "win32",
        adapterId: "windows-native-audio-provider",
        checkedAt: "2026-09-01T10:00:00.000Z",
        supported: true,
        capabilities: {
          MICROPHONE_AUDIO: {
            kind: "MICROPHONE_AUDIO",
            status: "AVAILABLE",
            available: true,
            canListSources: true,
            requiresPermission: true,
            sources: [{ sourceId: "mic-default", kind: "MICROPHONE_AUDIO", label: "Mic" }],
          },
          SYSTEM_AUDIO: {
            kind: "SYSTEM_AUDIO",
            status: "AVAILABLE",
            available: true,
            canListSources: true,
            requiresPermission: true,
            sources: [{ sourceId: "render-default", kind: "SYSTEM_AUDIO", label: "Speakers" }],
          },
          SCREEN: {
            kind: "SCREEN",
            status: "UNAVAILABLE",
            available: false,
            canListSources: false,
            requiresPermission: false,
          },
          WINDOW: {
            kind: "WINDOW",
            status: "UNAVAILABLE",
            available: false,
            canListSources: false,
            requiresPermission: false,
          },
        },
      }),
      startCapture: async () => {
        throw new Error("audio start unused");
      },
    },
    screen: new WindowsNativeScreenProvider({
      platform: "win32",
      helperPath: "C:/missing/AIWorkMate.WindowsScreenCapture.exe",
      clock: fixedClock(),
    }),
    clock: fixedClock(),
  });
  const discovered = await composite.discoverCapabilities();
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.available, true);
  assert.equal(discovered.capabilities.SCREEN.available, false);
  assert.equal(discovered.capabilities.SCREEN.error?.code, "NATIVE_PROVIDER_NOT_CONFIGURED");
});

class ScriptedHelperRunner {
  public readonly calls: readonly string[][] = [];
  public readonly processes: MemoryHelperProcess[] = [];

  public constructor(private readonly handler: (args: readonly string[]) => MemoryHelperProcess) {}

  public readonly run: WindowsScreenHelperRunner = (args) => {
    (this.calls as string[][]).push([...args]);
    const process = this.handler(args);
    this.processes.push(process);
    return process;
  };
}

class MemoryHelperProcess implements WindowsScreenHelperProcess {
  public readonly stdout: AsyncIterable<Uint8Array>;
  public readonly stderr: AsyncIterable<Uint8Array>;
  public readonly stdin: WindowsScreenHelperStdin;
  public readonly exited: Promise<WindowsScreenHelperExit>;
  public readonly stdinWrites: string[] = [];
  public killed = false;

  public constructor(
    stdout: string,
    stderr = "",
    exit: WindowsScreenHelperExit = { code: 0, signal: null },
  ) {
    this.stdout = stringChunks(stdout);
    this.stderr = stringChunks(stderr);
    this.exited = Promise.resolve(exit);
    this.stdin = {
      write: (data) => {
        this.stdinWrites.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        return true;
      },
      end: () => undefined,
    };
  }

  public kill(): void {
    this.killed = true;
  }
}

function completedProcess(stdout: string): MemoryHelperProcess {
  return new MemoryHelperProcess(stdout);
}

async function* stringChunks(text: string): AsyncIterable<Uint8Array> {
  if (text.length > 0) {
    yield Buffer.from(text, "utf8");
  }
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const result: Uint8Array[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}

function providerWithCapabilities(payload: unknown): WindowsNativeScreenProvider {
  return new WindowsNativeScreenProvider({
    platform: "win32",
    helperRunner: () => completedProcess(JSON.stringify(payload)),
    clock: fixedClock(),
  });
}

function providerWithCapture(
  kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">,
  sourceId: string,
  frames: Buffer[],
  options: { secondSequence?: number } = {},
): WindowsNativeScreenProvider {
  const runner = runnerForCapture(kind, sourceId, frames, options);
  return new WindowsNativeScreenProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
}

function runnerForCapture(
  kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">,
  sourceId: string,
  frames: Buffer[],
  options: { secondSequence?: number } = {},
): ScriptedHelperRunner {
  return new ScriptedHelperRunner((args) => {
    if (args[0] === "capabilities") {
      return completedProcess(JSON.stringify(capabilityPayload(kind, sourceId)));
    }
    const lines = [formatLine(kind, sourceId)];
    frames.forEach((frame, index) => {
      const sequence = index === 1 && options.secondSequence !== undefined ? options.secondSequence : index;
      lines.push(chunkLine(kind, sequence, sourceId, frame, `2026-09-01T10:00:0${index + 1}.000Z`));
    });
    return completedProcess(`${lines.join("\n")}\n`);
  });
}

function capabilityPayload(kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">, sourceId: string): unknown {
  return {
    checkedAt: "2026-09-01T10:00:00.000Z",
    displays: kind === "SCREEN" ? [{ id: sourceId, label: "Primary display", isDefault: true }] : [{ id: "display:DISPLAY1", label: "Primary display", isDefault: true }],
    windows: kind === "WINDOW" ? [{ id: sourceId, label: "Notepad" }] : [{ id: "hwnd:00000000000A1B2C", label: "Notepad" }],
  };
}

function formatLine(kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">, sourceId: string): string {
  return JSON.stringify({
    recordType: "format",
    source: kind,
    sourceId,
    sourceLabel: kind === "SCREEN" ? "Primary display" : "Notepad",
    startedAt: "2026-09-01T10:00:00.000Z",
    format: VIDEO_FORMAT,
  });
}

function chunkLine(
  kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">,
  sequence: number,
  sourceId: string,
  data: Buffer,
  timestamp: string,
): string {
  return JSON.stringify({
    recordType: "chunk",
    sequence,
    timestamp,
    source: kind,
    sourceId,
    format: VIDEO_FORMAT,
    byteLength: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    dataBase64: data.toString("base64"),
  });
}

function fixedClock(): () => Date {
  return () => new Date("2026-09-01T10:00:00.000Z");
}
