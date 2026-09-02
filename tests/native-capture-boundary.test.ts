import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createNativeCaptureAdapter,
  LocalRecordingCaptureEngine,
  NativeCaptureCoordinator,
  NativeCaptureError,
  NATIVE_CAPTURE_KINDS,
  WindowsCaptureAdapter,
  WINDOWS_AUDIO_CAPTURE_FORMAT,
  WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureKind,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
  type NativeCapturePolicy,
} from "../src";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import { withTempStore } from "./helpers";

const ALL_ALLOWED: Partial<NativeCapturePolicy> = {
  MICROPHONE_AUDIO: "ALLOW",
  SYSTEM_AUDIO: "ALLOW",
  SCREEN: "ALLOW",
  WINDOW: "ALLOW",
};

test("discovers native capture capabilities as structured safe metadata", async () => {
  const adapter = new TestNativeCaptureAdapter(capabilities({
    MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO", [{ sourceId: "default-mic", kind: "MICROPHONE_AUDIO", label: "Default microphone", isDefault: true }]),
    SYSTEM_AUDIO: unavailableCapability("SYSTEM_AUDIO", "UNAVAILABLE", "NATIVE_DEVICE_UNAVAILABLE", "No loopback device."),
    SCREEN: availableCapability("SCREEN", [{ sourceId: "screen-1", kind: "SCREEN", label: "Primary display" }]),
    WINDOW: availableCapability("WINDOW", [{ sourceId: "window-1", kind: "WINDOW", label: "Window" }]),
  }));

  const result = await adapter.discoverCapabilities();

  assert.equal(result.supported, true);
  assert.equal(result.platform, "win32");
  assert.equal(result.adapterId, "test-native-capture");
  assert.equal(result.capabilities.MICROPHONE_AUDIO.available, true);
  assert.equal(result.capabilities.MICROPHONE_AUDIO.sources?.[0]?.sourceId, "default-mic");
  assert.equal(result.capabilities.SYSTEM_AUDIO.available, false);
  assert.equal(result.capabilities.SYSTEM_AUDIO.error?.code, "NATIVE_DEVICE_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("/"), false);
  assert.equal(JSON.stringify(result).includes("C:\\"), false);
});

test("production factory fails closed on unsupported Linux/headless platform", async () => {
  const adapter = createNativeCaptureAdapter({ platform: "linux", clock: fixedClock() });
  const discovered = await adapter.discoverCapabilities();

  assert.equal(discovered.supported, false);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].status, "UNSUPPORTED");
    assert.equal(discovered.capabilities[kind].available, false);
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PLATFORM_UNSUPPORTED");
  }
  await assert.rejects(
    adapter.startCapture({ capability: "MICROPHONE_AUDIO", format: "webm", mimeType: "audio/webm" }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PLATFORM_UNSUPPORTED",
  );
});

test("Windows factory wires the real audio provider and fails closed when the helper is missing", async () => {
  const missingHelper = join(tmpdir(), `ai-workmate-missing-audio-helper-${Date.now()}`, "AIWorkMate.WindowsAudioCapture.exe");
  const adapter = createNativeCaptureAdapter({ platform: "win32", clock: fixedClock(), helperPath: missingHelper });
  const discovered = await adapter.discoverCapabilities();

  assert.equal(discovered.supported, true);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].available, false);
    assert.equal(discovered.capabilities[kind].status, "UNAVAILABLE");
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PROVIDER_NOT_CONFIGURED");
  }
  await assert.rejects(
    adapter.startCapture({ capability: "MICROPHONE_AUDIO", format: WINDOWS_AUDIO_CAPTURE_FORMAT, mimeType: WINDOWS_AUDIO_CAPTURE_MIME_TYPE }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PROVIDER_NOT_CONFIGURED",
  );
});

test("Windows adapter without a native provider still reports unavailable instead of fallback capture", async () => {
  const adapter = new WindowsCaptureAdapter({ platform: "win32", clock: fixedClock() });
  const discovered = await adapter.discoverCapabilities();

  assert.equal(discovered.supported, true);
  for (const kind of NATIVE_CAPTURE_KINDS) {
    assert.equal(discovered.capabilities[kind].available, false);
    assert.equal(discovered.capabilities[kind].status, "UNAVAILABLE");
    assert.equal(discovered.capabilities[kind].error?.code, "NATIVE_PROVIDER_NOT_CONFIGURED");
  }
  await assert.rejects(
    adapter.startCapture({ capability: "SCREEN", format: "webm", mimeType: "video/webm" }),
    (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PROVIDER_NOT_CONFIGURED",
  );
});

test("unavailable native capabilities are rejected before recording starts", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Unavailable native capability", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({
      MICROPHONE_AUDIO: unavailableCapability("MICROPHONE_AUDIO", "PERMISSION_DENIED", "NATIVE_PERMISSION_DENIED", "Microphone permission denied."),
    }));
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: ALL_ALLOWED,
    });

    await assert.rejects(
      coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "webm", mimeType: "audio/webm" }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_PERMISSION_DENIED",
    );
    assert.equal(adapter.startRequests.length, 0);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "SCHEDULED");
    assert.equal(store.database.listArtifactOperations().length, 0);
  });
});

test("native capture policy denies microphone system screen and window by default", async () => {
  await withTempStore(async (store) => {
    for (const kind of NATIVE_CAPTURE_KINDS) {
      const meeting = await store.createMeeting({ title: `Denied ${kind}`, meetingDate: "2026-09-01" });
      const adapter = new TestNativeCaptureAdapter(capabilities({ [kind]: availableCapability(kind) }));
      const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()));

      await assert.rejects(
        coordinator.startCapture({ meetingId: meeting.meetingId, capability: kind, format: kind === "MICROPHONE_AUDIO" || kind === "SYSTEM_AUDIO" ? "opus" : "webm", mimeType: kind === "MICROPHONE_AUDIO" || kind === "SYSTEM_AUDIO" ? "audio/ogg" : "video/webm" }),
        (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_POLICY_DENIED" && error.capability === kind,
      );
      assert.equal(adapter.startRequests.length, 0);
      assert.equal(store.getMeeting(meeting.meetingId)?.status, "SCHEDULED");
    }
  });
});

test("screen and window captures can be policy-enabled and finalized through local storage", async () => {
  await withTempStore(async (store, root) => {
    const adapter = new TestNativeCaptureAdapter(capabilities({
      SCREEN: availableCapability("SCREEN", [{ sourceId: "screen-1", kind: "SCREEN" }]),
      WINDOW: availableCapability("WINDOW", [{ sourceId: "window-1", kind: "WINDOW" }]),
    }), (request) => new TestNativeSession(request, [Buffer.from(`${request.capability}-bytes`)]));
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { SCREEN: "ALLOW", WINDOW: "ALLOW" },
    });

    for (const kind of ["SCREEN", "WINDOW"] as const) {
      const meeting = await store.createMeeting({ title: `${kind} native`, meetingDate: "2026-09-01" });
      const started = await coordinator.startCapture({
        meetingId: meeting.meetingId,
        capability: kind,
        sourceId: kind === "SCREEN" ? "screen-1" : "window-1",
        format: "webm",
        mimeType: "video/webm",
      });
      const stopped = await coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId });

      assert.equal(stopped.state, "COMPLETED");
      assert.equal(stopped.capability, kind);
      assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
      assert.equal(await readFile(join(root, stopped.relativePath ?? ""), "utf8"), `${kind}-bytes`);
      assert.equal(store.database.listRecordings(meeting.meetingId)[0]?.captureSource, `test-native-capture:${kind}`);
    }
  });
});

test("native capture ownership is keyed by meeting UUID and rejects duplicates", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Duplicate native ownership", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO") }),
      (request) => new TestNativeSession(request, [Buffer.from("owned")]),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { MICROPHONE_AUDIO: "ALLOW" },
    });
    const started = await coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" });

    await assert.rejects(
      coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" }),
      /already active/,
    );
    assert.equal(adapter.startRequests.length, 1);
    await coordinator.abortCapture({ captureId: started.captureId, meetingId: meeting.meetingId, reason: "test cleanup" });
  });
});

test("native capture rejects wrong meeting IDs for stop and abort", async () => {
  await withTempStore(async (store) => {
    const first = await store.createMeeting({ title: "Native owner", meetingDate: "2026-09-01" });
    const second = await store.createMeeting({ title: "Native wrong owner", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO") }),
      (request) => new TestNativeSession(request, [Buffer.from("audio")]),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { MICROPHONE_AUDIO: "ALLOW" },
    });
    const started = await coordinator.startCapture({ meetingId: first.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" });

    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: second.meetingId }),
      /does not match the session owner/,
    );
    await assert.rejects(
      coordinator.abortCapture({ captureId: started.captureId, meetingId: second.meetingId, reason: "wrong" }),
      /does not match the session owner/,
    );
    await coordinator.abortCapture({ captureId: started.captureId, meetingId: first.meetingId, reason: "cleanup" });
  });
});

test("native capture lifecycle reaches processing and records committed journal metadata", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Native lifecycle", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ SYSTEM_AUDIO: availableCapability("SYSTEM_AUDIO") }),
      (request) => new TestNativeSession(request, [Buffer.from("system "), Buffer.from("audio")]),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { SYSTEM_AUDIO: "ALLOW" },
    });

    const started = await coordinator.startCapture({ meetingId: meeting.meetingId, capability: "SYSTEM_AUDIO", format: "opus", mimeType: "audio/ogg", estimatedBytes: 12 });
    assert.equal(started.state, "RECORDING");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "RECORDING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "WRITING");

    const stopped = await coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId, endedAt: "2026-09-01T10:00:05.000Z" });
    const expectedSha = createHash("sha256").update("system audio").digest("hex");

    assert.equal(stopped.state, "COMPLETED");
    assert.equal(stopped.sha256, expectedSha);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "COMMITTED");
    assert.equal(await readFile(join(root, stopped.relativePath ?? ""), "utf8"), "system audio");
    const [recording] = store.database.listRecordings(meeting.meetingId);
    assert.equal(recording?.captureSource, "test-native-capture:SYSTEM_AUDIO");
    assert.equal(recording?.finalStatus, "COMMITTED");
    assert.equal(recording?.sha256, expectedSha);
  });
});

test("native startup failure does not create fake recordings or mark the meeting complete", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native startup failure", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO") }), () => {
      throw new NativeCaptureError({
        code: "NATIVE_CAPTURE_START_FAILED",
        message: "The native microphone API failed to start.",
        capability: "MICROPHONE_AUDIO",
        retryable: true,
      });
    });
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { MICROPHONE_AUDIO: "ALLOW" },
    });

    await assert.rejects(
      coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_START_FAILED",
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "SCHEDULED");
    assert.equal(store.database.listArtifactOperations().length, 0);
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});

test("native safe stop aborts through the local capture boundary as incomplete", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native safe stop", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO") }),
      (request) => new TestNativeSession(request, [Buffer.from("partial")]),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { MICROPHONE_AUDIO: "ALLOW" },
    });

    const started = await coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" });
    const aborted = await coordinator.abortCapture({ captureId: started.captureId, meetingId: meeting.meetingId, reason: "user stopped before finalize" });

    assert.equal(aborted.state, "INCOMPLETE");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});

test("native finalization failure is journaled as failed and does not overwrite files", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Native finalize failure", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ SCREEN: availableCapability("SCREEN") }),
      (request) => new TestNativeSession(request, [Buffer.from("screen")]),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { SCREEN: "ALLOW" },
    });
    const started = await coordinator.startCapture({ meetingId: meeting.meetingId, capability: "SCREEN", format: "webm", mimeType: "video/webm" });
    const finalPath = join(root, started.relativePath ?? "");
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, "existing", { flag: "wx" });

    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      /Refusing to overwrite an existing artifact/,
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "FAILED");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
    assert.equal(await readFile(finalPath, "utf8"), "existing");
  });
});

test("native capture start aborts the native session when local disk preflight fails", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native disk failure", meetingDate: "2026-09-01" });
    const sessions: TestNativeSession[] = [];
    const adapter = new TestNativeCaptureAdapter(capabilities({ SYSTEM_AUDIO: availableCapability("SYSTEM_AUDIO") }), (request) => {
      const session = new TestNativeSession(request, [Buffer.from("will not persist")]);
      sessions.push(session);
      return session;
    });
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { SYSTEM_AUDIO: "ALLOW" },
    });

    await assert.rejects(
      coordinator.startCapture({ meetingId: meeting.meetingId, capability: "SYSTEM_AUDIO", format: "opus", mimeType: "audio/ogg", estimatedBytes: 1 }),
      /Insufficient disk space/,
    );
    assert.equal(sessions[0]?.abortedReason?.includes("Insufficient disk space"), true);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => 0 });
});

test("native stream failures mark partial local capture incomplete without fallback bytes", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Native stream failure", meetingDate: "2026-09-01" });
    const adapter = new TestNativeCaptureAdapter(capabilities({ MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO") }),
      (request) => new TestNativeSession(request, [Buffer.from("real-before-error")], new NativeCaptureError({
        code: "NATIVE_CAPTURE_STREAM_FAILED",
        message: "Native stream failed.",
        capability: "MICROPHONE_AUDIO",
        retryable: true,
      })),
    );
    const coordinator = new NativeCaptureCoordinator(adapter, new LocalRecordingCaptureEngine(store, fixedClock()), {
      policy: { MICROPHONE_AUDIO: "ALLOW" },
    });
    const started = await coordinator.startCapture({ meetingId: meeting.meetingId, capability: "MICROPHONE_AUDIO", format: "opus", mimeType: "audio/ogg" });

    await assert.rejects(
      coordinator.stopCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      (error: unknown) => error instanceof NativeCaptureError && error.code === "NATIVE_CAPTURE_STREAM_FAILED",
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  });
});

test("no native capture IPC or renderer output-path channel is exposed", () => {
  const channelNames = Object.keys(STORAGE_IPC_CHANNELS);
  const channelValues = Object.values(STORAGE_IPC_CHANNELS);

  assert.equal(channelNames.some((name) => /native|capture|recording/i.test(name)), false);
  assert.equal(channelValues.some((channel) => /native|capture|recording|output-path|source-path/i.test(channel)), false);
});

class TestNativeCaptureAdapter implements NativeCaptureAdapter {
  public readonly adapterId = "test-native-capture";
  public readonly startRequests: NativeCaptureStartRequest[] = [];

  public constructor(
    private readonly discovered: NativeCaptureCapabilities,
    private readonly startFactory: (request: NativeCaptureStartRequest) => NativeCaptureSession = (request) => new TestNativeSession(request, [Buffer.from("native")]),
  ) {}

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    return this.discovered;
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    this.startRequests.push(request);
    return this.startFactory(request);
  }
}

class TestNativeSession implements NativeCaptureSession {
  public readonly nativeSessionId = randomUUID();
  public readonly capability: NativeCaptureKind;
  public readonly sourceId: string | undefined;
  public readonly format: string;
  public readonly mimeType: string;
  public readonly startedAt = "2026-09-01T10:00:00.000Z";
  public readonly chunks: AsyncIterable<Uint8Array>;
  public stopped = false;
  public abortedReason: string | undefined;

  public constructor(
    request: NativeCaptureStartRequest,
    chunks: Uint8Array[],
    private readonly streamError?: Error,
  ) {
    this.capability = request.capability;
    this.sourceId = request.sourceId;
    this.format = request.format;
    this.mimeType = request.mimeType;
    this.chunks = this.iterate(chunks);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
  }

  public async abort(reason: string): Promise<void> {
    this.abortedReason = reason;
  }

  private async *iterate(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
    if (this.streamError !== undefined) {
      throw this.streamError;
    }
  }
}

function capabilities(overrides: Partial<Record<NativeCaptureKind, NativeCaptureCapability>>): NativeCaptureCapabilities {
  return {
    platform: "win32",
    adapterId: "test-native-capture",
    checkedAt: "2026-09-01T10:00:00.000Z",
    supported: true,
    capabilities: Object.fromEntries(
      NATIVE_CAPTURE_KINDS.map((kind) => [kind, overrides[kind] ?? unavailableCapability(kind, "UNAVAILABLE", "NATIVE_CAPABILITY_UNAVAILABLE", `${kind} unavailable.`)]),
    ) as Record<NativeCaptureKind, NativeCaptureCapability>,
  };
}

function availableCapability(kind: NativeCaptureKind, sources?: NativeCaptureCapability["sources"]): NativeCaptureCapability {
  return {
    kind,
    status: "AVAILABLE",
    available: true,
    canListSources: sources !== undefined,
    requiresPermission: kind === "MICROPHONE_AUDIO" || kind === "SYSTEM_AUDIO" || kind === "SCREEN" || kind === "WINDOW",
    ...(sources === undefined ? {} : { sources }),
  };
}

function unavailableCapability(
  kind: NativeCaptureKind,
  status: NativeCaptureCapability["status"],
  code: NonNullable<NativeCaptureCapability["error"]>["code"],
  message: string,
): NativeCaptureCapability {
  return {
    kind,
    status,
    available: false,
    canListSources: false,
    requiresPermission: status === "PERMISSION_DENIED",
    error: {
      code,
      message,
      capability: kind,
      retryable: status !== "UNSUPPORTED",
    },
  };
}

function fixedClock(): () => Date {
  return () => new Date("2026-09-01T10:00:00.000Z");
}
