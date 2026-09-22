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
  WindowsNativeAudioProvider,
  WINDOWS_AUDIO_CAPTURE_FORMAT,
  WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  type NativeCaptureKind,
  type NativeCapturePolicy,
  type WindowsAudioHelperExit,
  type WindowsAudioHelperProcess,
  type WindowsAudioHelperRunner,
  type WindowsAudioHelperStdin,
  type WindowsAudioPcmFormat,
} from "../src";
import { withTempStore } from "./helpers";

const PCM_FORMAT: WindowsAudioPcmFormat = {
  container: "AIWPCM_JSONL",
  encoding: "PCM",
  sampleRateHz: 48_000,
  channels: 2,
  bitsPerSample: 32,
  blockAlign: 8,
  averageBytesPerSecond: 384_000,
};

const ALL_AUDIO_ALLOWED: Partial<NativeCapturePolicy> = {
  MICROPHONE_AUDIO: "ALLOW",
  SYSTEM_AUDIO: "ALLOW",
};

test("Windows native audio provider fails closed on non-Windows platforms", async () => {
  const provider = new WindowsNativeAudioProvider({
    platform: "linux",
    helperRunner: () => {
      throw new Error("helper must not run on Linux");
    },
    clock: fixedClock(),
  });

  const discovered = await provider.discoverCapabilities();

  assert.equal(discovered.supported, false);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].available, false);
    assert.equal(discovered.capabilities[kind].status, "UNSUPPORTED");
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PLATFORM_UNSUPPORTED");
  }
  await assert.rejects(
    provider.startCapture({ capability: "MICROPHONE_AUDIO", format: WINDOWS_AUDIO_CAPTURE_FORMAT, mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PLATFORM_UNSUPPORTED",
  );
});

test("Windows native audio provider reports missing helper without mock fallback", async () => {
  const provider = new WindowsNativeAudioProvider({ platform: "win32", helperPath: "C:/missing/AIWorkMate.WindowsAudioCapture.exe", clock: fixedClock() });

  const discovered = await provider.discoverCapabilities();

  assert.equal(discovered.supported, true);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].available, false);
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PROVIDER_NOT_CONFIGURED");
  }
  await assert.rejects(
    provider.startCapture({ capability: "SYSTEM_AUDIO", format: WINDOWS_AUDIO_CAPTURE_FORMAT, mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PROVIDER_NOT_CONFIGURED",
  );
});

test("Windows native audio provider discovers microphone and loopback devices from the helper", async () => {
  const runner = new ScriptedHelperRunner((args) => {
    assert.deepEqual(args, ["capabilities", "--json"]);
    return completedProcess(JSON.stringify({
      checkedAt: "2026-09-01T10:00:00.000Z",
      microphone: [{ id: "mic-default", label: "Default Microphone", isDefault: true }],
      systemAudio: [{ id: "render-default", label: "Speakers Loopback", isDefault: true }],
    }));
  });
  const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });

  const discovered = await provider.discoverCapabilities();

  assert.equal(discovered.adapterId, "windows-native-audio-provider");
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.available, true);
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.sources?.[0]?.sourceId, "mic-default");
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.sources?.[0]?.label, "Default Microphone");
  assert.equal(discovered.capabilities.SYSTEM_AUDIO.available, true);
  assert.equal(discovered.capabilities.SYSTEM_AUDIO.sources?.[0]?.sourceId, "render-default");
  assert.equal(discovered.capabilities.SCREEN.available, false);
  assert.equal(discovered.capabilities.WINDOW.available, false);
  assert.equal(JSON.stringify(discovered).includes("C:\\"), false);
  assert.equal(runner.calls.length, 1);
});

test("Windows native audio provider maps permission denied and unavailable devices", async () => {
  const provider = providerWithCapabilities({
    microphone: [],
    systemAudio: [],
    errors: {
      MICROPHONE_AUDIO: { code: "NATIVE_PERMISSION_DENIED", message: "Microphone access denied.", retryable: true },
      SYSTEM_AUDIO: { code: "NATIVE_DEVICE_UNAVAILABLE", message: "No active render endpoint.", retryable: true },
    },
  });

  const discovered = await provider.discoverCapabilities();

  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.status, "PERMISSION_DENIED");
  assert.equal(discovered.capabilities.MICROPHONE_AUDIO.error?.code, "NATIVE_PERMISSION_DENIED");
  assert.equal(discovered.capabilities.SYSTEM_AUDIO.status, "UNAVAILABLE");
  assert.equal(discovered.capabilities.SYSTEM_AUDIO.error?.code, "NATIVE_DEVICE_UNAVAILABLE");
});

test("Windows native audio provider reports helper initialization failures as typed errors", async () => {
  const provider = new WindowsNativeAudioProvider({
    platform: "win32",
    helperRunner: () => completedProcess("", { code: 7, stderr: "WASAPI initialization failed" }),
    clock: fixedClock(),
  });

  await assert.rejects(
    provider.discoverCapabilities(),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_WINDOWS_API_INITIALIZATION_FAILED" && error.message.includes("WASAPI initialization failed"),
  );
});

test("Windows native microphone session validates chunk timestamps sequence and integrity", async () => {
  const runner = new ScriptedHelperRunner((args) => {
    assert.deepEqual(args, ["capture", "--kind", "microphone", "--format", "aiwpcm-jsonl", "--source-id", "mic-default"]);
    return completedProcess([
      formatLine("MICROPHONE_AUDIO", "mic-default"),
      chunkLine("MICROPHONE_AUDIO", 0, "mic-default", Buffer.from("captured-microphone-frame"), "2026-09-01T10:00:01.000Z"),
    ].join("\n") + "\n");
  });
  const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });

  const session = await provider.startCapture({
    capability: "MICROPHONE_AUDIO",
    sourceId: "mic-default",
    format: WINDOWS_AUDIO_CAPTURE_FORMAT,
    mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  });
  const chunks = await collect(session.chunks);
  await session.stop();

  const serialized = Buffer.concat(chunks).toString("utf8");
  assert.equal(chunks.length, 2);
  assert.match(serialized, /"recordType":"format"/);
  assert.match(serialized, /"recordType":"chunk"/);
  assert.match(serialized, /"sequence":0/);
  assert.match(serialized, /"timestamp":"2026-09-01T10:00:01.000Z"/);
  assert.match(serialized, /"source":"MICROPHONE_AUDIO"/);
  assert.equal(runner.processes[0]?.stdinWrites.includes("stop\n"), true);
});

test("Windows native system-audio loopback feeds the existing local storage pipeline", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Loopback native provider", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("SYSTEM_AUDIO", "render-default", [Buffer.from("loopback-frame-1"), Buffer.from("loopback-frame-2")]);
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "SYSTEM_AUDIO",
      sourceId: "render-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      estimatedBytes: 1,
    });
    const stopped = await coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId });

    assert.equal(stopped.state, "COMPLETED");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "COMMITTED");
    assert.equal(store.database.listRecordings(meeting.meetingId)[0]?.captureSource, "windows-native-audio-provider:SYSTEM_AUDIO");
    const stored = await readFile(join(root, stopped.relativePath ?? ""), "utf8");
    assert.match(stored, /"source":"SYSTEM_AUDIO"/);
    assert.match(stored, /"sequence":0/);
    assert.match(stored, /"sequence":1/);
    assert.equal(stopped.sha256, createHash("sha256").update(stored).digest("hex"));
  });
});

test("Windows native audio provider rejects out-of-order helper chunks", async () => {
  const provider = providerWithCapture("MICROPHONE_AUDIO", "mic-default", [Buffer.from("first"), Buffer.from("third")], { secondSequence: 2 });
  const session = await provider.startCapture({
    capability: "MICROPHONE_AUDIO",
    sourceId: "mic-default",
    format: WINDOWS_AUDIO_CAPTURE_FORMAT,
    mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  });

  await assert.rejects(
    collect(session.chunks),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_CHUNK_OUT_OF_ORDER",
  );
});

test("Windows native audio provider rejects invalid timestamps before storage commit", async () => {
  const provider = providerWithCapture("SYSTEM_AUDIO", "render-default", [Buffer.from("bad-time")], { timestamp: "not-a-date" });
  const session = await provider.startCapture({
    capability: "SYSTEM_AUDIO",
    sourceId: "render-default",
    format: WINDOWS_AUDIO_CAPTURE_FORMAT,
    mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  });

  await assert.rejects(
    collect(session.chunks),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STREAM_FAILED" && error.message.includes("timestamp"),
  );
});

test("Windows native audio provider rejects screen window and unsupported output formats", async () => {
  const provider = providerWithCapabilities({
    microphone: [{ id: "mic-default", label: "Default Microphone", isDefault: true }],
    systemAudio: [{ id: "render-default", label: "Speakers Loopback", isDefault: true }],
  });

  for (const capability of ["SCREEN", "WINDOW"] as const) {
    await assert.rejects(
      provider.startCapture({ capability, format: WINDOWS_AUDIO_CAPTURE_FORMAT, mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPABILITY_UNAVAILABLE",
    );
  }
  await assert.rejects(
    provider.startCapture({ capability: "MICROPHONE_AUDIO", format: "wav", mimeType: "audio/wav" }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPABILITY_UNAVAILABLE",
  );
});

test("Windows native audio coordinator rejects unavailable selected devices before native start", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Unavailable selected device", meetingDate: "2026-09-01" });
    const runner = new ScriptedHelperRunner((args) => {
      if (args[0] === "capabilities") {
        return completedProcess(JSON.stringify({
          microphone: [{ id: "mic-default", label: "Default Microphone", isDefault: true }],
          systemAudio: [{ id: "render-default", label: "Speakers Loopback", isDefault: true }],
        }));
      }
      throw new Error("capture must not start for unavailable source");
    });
    const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    await assert.rejects(
      coordinator.startCapture({
        meetingId: meeting.meetingId,
        capability: "MICROPHONE_AUDIO",
        sourceId: "missing-mic",
        format: WINDOWS_AUDIO_CAPTURE_FORMAT,
        mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPABILITY_UNAVAILABLE",
    );
    assert.equal(runner.calls.length, 1);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "SCHEDULED");
    assert.equal(store.database.listArtifactOperations().length, 0);
  });
});

test("Windows native audio coordinator enforces duplicate ownership and wrong meeting UUID", async () => {
  await withTempStore(async (store) => {
    const first = await store.createMeeting({ title: "Native mic owner", meetingDate: "2026-09-01" });
    const second = await store.createMeeting({ title: "Native mic wrong owner", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("MICROPHONE_AUDIO", "mic-default", [Buffer.from("owned")]);
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    const started = await coordinator.startCapture({
      meetingId: first.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });
    await assert.rejects(
      coordinator.startCapture({
        meetingId: first.meetingId,
        capability: "MICROPHONE_AUDIO",
        sourceId: "mic-default",
        format: WINDOWS_AUDIO_CAPTURE_FORMAT,
        mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      }),
      /already active/,
    );
    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: second.meetingId }),
      /does not match the session owner/,
    );
    await coordinator.abortCapture({ captureId: started.captureId, meetingId: first.meetingId, reason: "test cleanup" });
  });
});


test("Windows microphone and loopback captures remain isolated for separate meeting UUIDs", async () => {
  await withTempStore(async (store, root) => {
    const microphoneMeeting = await store.createMeeting({ title: "Mic isolated", meetingDate: "2026-09-01" });
    const loopbackMeeting = await store.createMeeting({ title: "Loopback isolated", meetingDate: "2026-09-01" });
    const runner = new ScriptedHelperRunner((args) => {
      if (args[0] === "capabilities") {
        return completedProcess(JSON.stringify({
          microphone: [{ id: "mic-default", label: "Default Microphone", isDefault: true }],
          systemAudio: [{ id: "render-default", label: "Speakers Loopback", isDefault: true }],
        }));
      }
      const kind = args.includes("microphone") ? "MICROPHONE_AUDIO" : "SYSTEM_AUDIO";
      const sourceId = kind === "MICROPHONE_AUDIO" ? "mic-default" : "render-default";
      const payload = kind === "MICROPHONE_AUDIO" ? "mic-frame" : "loopback-frame";
      return completedProcess(`${formatLine(kind, sourceId)}\n${chunkLine(kind, 0, sourceId, Buffer.from(payload), "2026-09-01T10:00:01.000Z")}\n`);
    });
    const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    const microphone = await coordinator.startCapture({
      meetingId: microphoneMeeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });
    const loopback = await coordinator.startCapture({
      meetingId: loopbackMeeting.meetingId,
      capability: "SYSTEM_AUDIO",
      sourceId: "render-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });

    const stoppedMic = await coordinator.stopCapture({ captureId: microphone.captureId, meetingId: microphoneMeeting.meetingId });
    const stoppedLoopback = await coordinator.stopCapture({ captureId: loopback.captureId, meetingId: loopbackMeeting.meetingId });

    assert.notEqual(stoppedMic.relativePath, stoppedLoopback.relativePath);
    assert.equal(store.getMeeting(microphoneMeeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.getMeeting(loopbackMeeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listRecordings(microphoneMeeting.meetingId)[0]?.captureSource, "windows-native-audio-provider:MICROPHONE_AUDIO");
    assert.equal(store.database.listRecordings(loopbackMeeting.meetingId)[0]?.captureSource, "windows-native-audio-provider:SYSTEM_AUDIO");
    assert.match(await readFile(join(root, stoppedMic.relativePath ?? ""), "utf8"), new RegExp(Buffer.from("mic-frame").toString("base64")));
    assert.match(await readFile(join(root, stoppedLoopback.relativePath ?? ""), "utf8"), new RegExp(Buffer.from("loopback-frame").toString("base64")));
  });
});


test("Windows native audio capture cannot reset a progressed meeting backward", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native audio progressed", meetingDate: "2026-09-01" });
    store.database.updateMeetingStatus(meeting.meetingId, "PROCESSING");
    const runner = runnerForCapture("MICROPHONE_AUDIO", "mic-default", [Buffer.from("late")]);
    const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    await assert.rejects(
      coordinator.startCapture({
        meetingId: meeting.meetingId,
        capability: "MICROPHONE_AUDIO",
        sourceId: "mic-default",
        format: WINDOWS_AUDIO_CAPTURE_FORMAT,
        mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
      }),
      /Cannot start capture while meeting/,
    );
    assert.equal(runner.processes.some((process) => process.killed), true);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});


test("Windows native audio stop failure aborts partial local capture as incomplete", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native audio stop failure", meetingDate: "2026-09-01" });
    const runner = new ScriptedHelperRunner((args) => {
      if (args[0] === "capabilities") {
        return completedProcess(JSON.stringify(capabilityPayload("MICROPHONE_AUDIO", "mic-default")));
      }
      return completedProcess(`${formatLine("MICROPHONE_AUDIO", "mic-default")}\n${chunkLine("MICROPHONE_AUDIO", 0, "mic-default", Buffer.from("partial-stop-failure"), "2026-09-01T10:00:01.000Z")}\n`, {
        throwOnStdinWrite: true,
      });
    });
    const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });
    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });

    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STOP_FAILED",
    );

    assert.equal(runner.processes.at(-1)?.killed, true);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
    assert.throws(
      () => coordinator.getCaptureState(started.captureId),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_SESSION_NOT_FOUND",
    );
  });
});

test("Windows native audio stream failure marks the local capture incomplete without fallback media", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native audio stream failure", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("MICROPHONE_AUDIO", "mic-default", [Buffer.from("before-error")], {
      trailingError: JSON.stringify({ recordType: "error", code: "NATIVE_CAPTURE_STREAM_FAILED", message: "Device disconnected.", retryable: true }),
    });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });
    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "MICROPHONE_AUDIO",
      sourceId: "mic-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });

    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STREAM_FAILED",
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});

test("Windows native audio disk-space failure aborts the native helper before persistence", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native audio disk failure", meetingDate: "2026-09-01" });
    const runner = runnerForCapture("SYSTEM_AUDIO", "render-default", [Buffer.from("not-persisted")]);
    const provider = new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });

    await assert.rejects(
      coordinator.startCapture({
        meetingId: meeting.meetingId,
        capability: "SYSTEM_AUDIO",
        sourceId: "render-default",
        format: WINDOWS_AUDIO_CAPTURE_FORMAT,
        mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
        estimatedBytes: 1,
      }),
      /Insufficient disk space/,
    );
    assert.equal(runner.processes.some((process) => process.killed), true);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => 0 });
});

test("Windows native audio process interruption remains incomplete on restart", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native audio interrupted", meetingDate: "2026-09-01" });
    const provider = providerWithCapture("SYSTEM_AUDIO", "render-default", [Buffer.from("partial")]);
    const coordinator = new NativeCaptureCoordinator(provider, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_AUDIO_ALLOWED,
    });
    const started = await coordinator.startCapture({
      meetingId: meeting.meetingId,
      capability: "SYSTEM_AUDIO",
      sourceId: "render-default",
      format: WINDOWS_AUDIO_CAPTURE_FORMAT,
      mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
    });

    await coordinator.abortCapture({ captureId: started.captureId, meetingId: meeting.meetingId, reason: "process interrupted" });

    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});

class ScriptedHelperRunner {
  public readonly calls: readonly string[][] = [];
  public readonly processes: MemoryHelperProcess[] = [];

  public constructor(private readonly handler: (args: readonly string[]) => MemoryHelperProcess) {}

  public readonly run: WindowsAudioHelperRunner = (args) => {
    (this.calls as string[][]).push([...args]);
    const process = this.handler(args);
    this.processes.push(process);
    return process;
  };
}

class MemoryHelperProcess implements WindowsAudioHelperProcess {
  public readonly stdout: AsyncIterable<Uint8Array>;
  public readonly stderr: AsyncIterable<Uint8Array>;
  public readonly stdin: WindowsAudioHelperStdin;
  public readonly exited: Promise<WindowsAudioHelperExit>;
  public readonly stdinWrites: string[] = [];
  public killed = false;
  public killSignal: NodeJS.Signals | string | undefined;

  public constructor(
    stdout: string,
    stderr = "",
    exit: WindowsAudioHelperExit = { code: 0, signal: null },
    private readonly options: { throwOnStdinWrite?: boolean } = {},
  ) {
    this.stdout = stringChunks(stdout);
    this.stderr = stringChunks(stderr);
    this.exited = Promise.resolve(exit);
    this.stdin = {
      write: (data) => {
        if (this.options.throwOnStdinWrite === true) {
          throw new Error("control pipe closed");
        }
        this.stdinWrites.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        return true;
      },
      end: () => undefined,
    };
  }

  public kill(signal?: NodeJS.Signals | string): void {
    this.killed = true;
    this.killSignal = signal;
  }
}

function completedProcess(
  stdout: string,
  options: { stderr?: string; code?: number | null; signal?: NodeJS.Signals | string | null; throwOnStdinWrite?: boolean } = {},
): MemoryHelperProcess {
  return new MemoryHelperProcess(stdout, options.stderr ?? "", { code: options.code ?? 0, signal: options.signal ?? null }, {
    throwOnStdinWrite: options.throwOnStdinWrite,
  });
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

function providerWithCapabilities(payload: unknown): WindowsNativeAudioProvider {
  return new WindowsNativeAudioProvider({
    platform: "win32",
    helperRunner: () => completedProcess(JSON.stringify(payload)),
    clock: fixedClock(),
  });
}

function providerWithCapture(
  kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">,
  sourceId: string,
  frames: Buffer[],
  options: { secondSequence?: number; timestamp?: string; trailingError?: string } = {},
): WindowsNativeAudioProvider {
  const runner = runnerForCapture(kind, sourceId, frames, options);
  return new WindowsNativeAudioProvider({ platform: "win32", helperRunner: runner.run, clock: fixedClock() });
}

function runnerForCapture(
  kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">,
  sourceId: string,
  frames: Buffer[],
  options: { secondSequence?: number; timestamp?: string; trailingError?: string } = {},
): ScriptedHelperRunner {
  return new ScriptedHelperRunner((args) => {
    if (args[0] === "capabilities") {
      return completedProcess(JSON.stringify(capabilityPayload(kind, sourceId)));
    }
    const lines = [formatLine(kind, sourceId)];
    frames.forEach((frame, index) => {
      const sequence = index === 1 && options.secondSequence !== undefined ? options.secondSequence : index;
      lines.push(chunkLine(kind, sequence, sourceId, frame, options.timestamp ?? `2026-09-01T10:00:0${index + 1}.000Z`));
    });
    if (options.trailingError !== undefined) {
      lines.push(options.trailingError);
    }
    return completedProcess(`${lines.join("\n")}\n`);
  });
}

function capabilityPayload(kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">, sourceId: string): unknown {
  return {
    checkedAt: "2026-09-01T10:00:00.000Z",
    microphone: kind === "MICROPHONE_AUDIO" ? [{ id: sourceId, label: "Default Microphone", isDefault: true }] : [{ id: "mic-default", label: "Default Microphone", isDefault: true }],
    systemAudio: kind === "SYSTEM_AUDIO" ? [{ id: sourceId, label: "Speakers Loopback", isDefault: true }] : [{ id: "render-default", label: "Speakers Loopback", isDefault: true }],
  };
}

function formatLine(kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">, sourceId: string): string {
  return JSON.stringify({
    recordType: "format",
    source: kind,
    sourceId,
    sourceLabel: kind === "MICROPHONE_AUDIO" ? "Default Microphone" : "Speakers Loopback",
    startedAt: "2026-09-01T10:00:00.000Z",
    format: PCM_FORMAT,
  });
}

function chunkLine(
  kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">,
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
    format: PCM_FORMAT,
    byteLength: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    dataBase64: data.toString("base64"),
  });
}

function fixedClock(): () => Date {
  return () => new Date("2026-09-01T10:00:00.000Z");
}
