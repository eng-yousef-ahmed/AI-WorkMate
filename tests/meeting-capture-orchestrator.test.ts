import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LocalFirstStore,
  LocalRecordingCaptureEngine,
  MeetingCaptureOrchestrator,
  MEETING_CAPTURE_KIND_TO_NATIVE,
  NativeCaptureCoordinator,
  NativeCaptureError,
  NATIVE_CAPTURE_KINDS,
  type MeetingCaptureConfig,
  type MeetingCaptureFlowSnapshot,
  type MeetingCaptureSourceKind,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureKind,
  type NativeCapturePolicy,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
} from "../src";
import { withTempStore } from "./helpers";

const ALLOWED_POLICY: Partial<NativeCapturePolicy> = {
  MICROPHONE_AUDIO: "ALLOW",
  SYSTEM_AUDIO: "ALLOW",
  SCREEN: "ALLOW",
  WINDOW: "ALLOW",
};

const ALL_SOURCES: MeetingCaptureConfig = { microphone: true, systemLoopback: true, screen: true };

interface ScriptedSessionOptions {
  /** Capability this session belongs to (used by the script to identify sessions). */
  capability: NativeCaptureKind;
  chunkIntervalMs: number;
  /** Number of chunks to emit before the stream ends naturally (undefined = stream until stopped). */
  emit?: number;
  /** Emit this many chunks, then throw a native stream failure. */
  failAfter?: number;
  failWith?: NativeCaptureError;
  /** stop() throws this error when set. */
  stopError?: NativeCaptureError;
  /** abort() throws this error when set. */
  abortError?: NativeCaptureError;
  tag?: string;
}

const SCRIPT_DEFAULTS = { chunkIntervalMs: 8, tag: "test" };

class ScriptedNativeSession implements NativeCaptureSession {
  public readonly nativeSessionId: string;
  public readonly capability: NativeCaptureKind;
  public readonly format: string;
  public readonly mimeType: string;
  public readonly startedAt: string;
  public readonly chunks: AsyncIterable<Uint8Array>;
  public stopCalls = 0;
  public abortCalls = 0;
  private stopped = false;
  private aborted = false;
  private readonly emitted: string[] = [];
  private readonly options: ScriptedSessionOptions;

  public constructor(source: NativeCaptureStartRequest, options: ScriptedSessionOptions) {
    this.options = { ...SCRIPT_DEFAULTS, ...options };
    this.capability = source.capability;
    this.nativeSessionId = `${source.capability.toLowerCase()}-session-${Math.floor(Math.random() * 1_000_000)}`;
    this.format = source.format;
    this.mimeType = source.mimeType;
    this.startedAt = new Date().toISOString();
    this.chunks = this.generate();
  }

  private async *generate(): AsyncIterable<Uint8Array> {
    let produced = 0;
    const base = `{"source":"${this.options.capability}","tag":"${this.options.tag}","sequence":`;
    while (true) {
      if (this.stopped || this.aborted) {
        return;
      }
      if (this.options.failAfter !== undefined && produced >= this.options.failAfter) {
        throw this.options.failWith ?? new NativeCaptureError({
          code: "NATIVE_CAPTURE_STREAM_FAILED",
          message: `Scripted stream failure after ${produced} chunks.`,
          capability: this.options.capability,
          retryable: true,
        });
      }
      if (this.options.emit !== undefined && produced >= this.options.emit) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.chunkIntervalMs));
      if (this.stopped || this.aborted) {
        return;
      }
      const line = `${base}${produced},"payload":"${"x".repeat(24)}"}\n`;
      const chunk = Buffer.from(line, "utf8");
      this.emitted.push(chunk.toString("utf8"));
      produced += 1;
      yield chunk;
    }
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.options.stopError !== undefined) {
      throw this.options.stopError;
    }
    this.stopped = true;
  }

  public async abort(_reason: string): Promise<void> {
    this.abortCalls += 1;
    if (this.options.abortError !== undefined) {
      throw this.options.abortError;
    }
    this.aborted = true;
    this.stopped = true;
  }

  public emittedChunkCount(): number {
    return this.emitted.length;
  }
}

interface ScriptedAdapterOptions {
  capabilities?: Partial<Record<NativeCaptureKind, NativeCaptureCapability>>;
  supported?: boolean;
  platform?: string;
  /** Per-capability session factory; throws to simulate a start failure. */
  sessions?: (source: NativeCaptureStartRequest) => ScriptedNativeSession;
  /** Session creation hook that can throw for specific capabilities. */
  startFailure?: Partial<Record<NativeCaptureKind, Error>>;
  startedCapabilities?: NativeCaptureKind[];
}

function availableCapability(kind: NativeCaptureKind, sources: Array<{ sourceId: string; label?: string; isDefault?: boolean }>): NativeCaptureCapability {
  return {
    kind,
    status: "AVAILABLE",
    available: true,
    canListSources: true,
    requiresPermission: false,
    sources: sources.map((source) => ({ ...source, kind })),
  };
}

function unavailableCapability(kind: NativeCaptureKind, message: string): NativeCaptureCapability {
  return {
    kind,
    status: "UNAVAILABLE",
    available: false,
    canListSources: false,
    requiresPermission: false,
    error: { code: "NATIVE_CAPABILITY_UNAVAILABLE", message, capability: kind, retryable: true },
  };
}

const DEFAULT_CAPABILITIES: Record<NativeCaptureKind, NativeCaptureCapability> = {
  MICROPHONE_AUDIO: availableCapability("MICROPHONE_AUDIO", [
    { sourceId: "mic-default-1", label: "Default microphone", isDefault: true },
    { sourceId: "mic-2", label: "Second microphone" },
  ]),
  SYSTEM_AUDIO: availableCapability("SYSTEM_AUDIO", [
    { sourceId: "loopback-default-1", label: "Default loopback", isDefault: true },
  ]),
  SCREEN: availableCapability("SCREEN", [
    { sourceId: "screen-1", label: "Primary display" },
    { sourceId: "screen-2", label: "Secondary display", isDefault: true },
  ]),
  WINDOW: availableCapability("WINDOW", [
    { sourceId: "hwnd:1000", label: "Program Manager" },
    { sourceId: "hwnd:2000", label: "Notepad - notes.txt" },
    { sourceId: "hwnd:3000", label: "Excel - Budget.xlsx" },
  ]),
};

class ScriptedNativeAdapter implements NativeCaptureAdapter {
  public readonly adapterId = "scripted-native-capture";
  public readonly sessions: ScriptedNativeSession[] = [];
  public maxConcurrentSessions = 0;
  private liveSessions = 0;
  private readonly options: ScriptedAdapterOptions;

  public constructor(options: ScriptedAdapterOptions = {}) {
    this.options = options;
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    if (this.options.supported === false) {
      return {
        platform: this.options.platform ?? "linux",
        adapterId: this.adapterId,
        checkedAt: new Date().toISOString(),
        supported: false,
        capabilities: Object.fromEntries(
          NATIVE_CAPTURE_KINDS.map((kind) => [
            kind,
            unavailableCapability(kind, "Native capture is unsupported on this platform."),
          ]),
        ) as Record<NativeCaptureKind, NativeCaptureCapability>,
      };
    }
    return {
      platform: this.options.platform ?? "win32",
      adapterId: this.adapterId,
      checkedAt: new Date().toISOString(),
      supported: true,
      capabilities: {
        MICROPHONE_AUDIO: this.options.capabilities?.MICROPHONE_AUDIO ?? DEFAULT_CAPABILITIES.MICROPHONE_AUDIO,
        SYSTEM_AUDIO: this.options.capabilities?.SYSTEM_AUDIO ?? DEFAULT_CAPABILITIES.SYSTEM_AUDIO,
        SCREEN: this.options.capabilities?.SCREEN ?? DEFAULT_CAPABILITIES.SCREEN,
        WINDOW: this.options.capabilities?.WINDOW ?? DEFAULT_CAPABILITIES.WINDOW,
      },
    };
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    const failure = this.options.startFailure?.[request.capability];
    if (failure !== undefined) {
      throw failure;
    }
    const session = this.options.sessions?.(request) ?? new ScriptedNativeSession(request, {
      capability: request.capability,
      chunkIntervalMs: 8,
    });
    this.sessions.push(session);
    this.liveSessions += 1;
    this.maxConcurrentSessions = Math.max(this.maxConcurrentSessions, this.liveSessions);
    void this.watchSessionEnd(session).catch(() => undefined);
    this.options.startedCapabilities?.push(request.capability);
    return session;
  }

  private async watchSessionEnd(session: ScriptedNativeSession): Promise<void> {
    await Promise.resolve();
    // The session stream ends on stop/abort; keep the live count until both
    // native stop/abort has been requested.
    const started = Date.now();
    while (Date.now() - started < 30_000 && session.stopCalls === 0 && session.abortCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.liveSessions -= 1;
  }

  public sessionFor(capability: NativeCaptureKind): ScriptedNativeSession | undefined {
    return this.sessions.find((session) => session.nativeSessionId.startsWith(capability.toLowerCase()));
  }
}

function orchestratorStack(adapter: NativeCaptureAdapter, store: LocalFirstStore): {
  orchestrator: MeetingCaptureOrchestrator;
  coordinator: NativeCaptureCoordinator;
  engine: LocalRecordingCaptureEngine;
} {
  const engine = new LocalRecordingCaptureEngine(store);
  const coordinator = new NativeCaptureCoordinator(adapter, engine, { policy: ALLOWED_POLICY });
  const orchestrator = new MeetingCaptureOrchestrator({ store, coordinator, engine });
  return { orchestrator, coordinator, engine };
}

async function runFlow(
  store: LocalFirstStore,
  adapter: NativeCaptureAdapter,
  config: MeetingCaptureConfig,
  options: { durationMs?: number; pollIntervalMs?: number; meetingId?: string } = {},
): Promise<MeetingCaptureFlowSnapshot> {
  const { orchestrator } = orchestratorStack(adapter, store);
  return orchestrator.run(config, {
    ...(options.meetingId === undefined ? {} : { meetingId: options.meetingId }),
    durationMs: options.durationMs ?? 250,
    pollIntervalMs: options.pollIntervalMs ?? 40,
  });
}

function sourceOf(snapshot: MeetingCaptureFlowSnapshot, kind: MeetingCaptureSourceKind) {
  const source = snapshot.sources.find((item) => item.kind === kind);
  assert.ok(source !== undefined, `expected source ${kind}`);
  return source;
}

/** Recording artifacts only; every meeting also carries a MEETING_MANIFEST artifact. */
function recordingArtifacts(store: LocalFirstStore, meetingId: string) {
  return store.database.listArtifacts(meetingId).filter((artifact) => artifact.artifactType !== "MEETING_MANIFEST");
}

test("meeting capture: start one source and commit one artifact", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const started = await runFlow(store, adapter, { microphone: true, systemLoopback: false, screen: false });

    assert.equal(started.requestedCapabilities.join(","), "MICROPHONE");
    assert.equal(started.startedCapabilities.join(","), "MICROPHONE");
    assert.equal(started.meetingStatus, "COMPLETED");
    assert.equal(started.phase, "COMPLETED");
    assert.equal(started.sources.length, 1);
    const source = sourceOf(started, "MICROPHONE");
    assert.equal(source.state, "COMMITTED");
    assert.equal(source.journalState, "COMMITTED");
    assert.equal(source.artifactCommitted, true);
    assert.ok(source.sha256 !== undefined && source.sha256.length === 64);
    assert.ok((source.chunksWritten ?? 0) > 0);
    assert.equal(source.firstSequence, 0);
    assert.equal(source.lastSequence, source.chunksWritten - 1);
    assert.equal(source.sourceId, "mic-default-1");
    assert.equal(source.sourceLabel, "Default microphone");

    const meeting = store.getMeeting(started.meetingId);
    assert.equal(meeting?.status, "COMPLETED");
    assert.ok(meeting?.endedAt !== undefined);
    const artifacts = recordingArtifacts(store, started.meetingId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.artifactType, "RECORDING_ORIGINAL");
    assert.equal(artifacts[0]?.status, "AVAILABLE");
    assert.equal(artifacts[0]?.sha256, source.sha256);
    const recordings = store.database.listRecordings(started.meetingId);
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0]?.sha256, source.sha256);
    assert.equal(recordings[0]?.finalStatus, "COMMITTED");
    assert.equal(recordings[0]?.captureSource, "scripted-native-capture:MICROPHONE_AUDIO");
    const operations = store.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.state, "COMMITTED");
    assert.equal(operations[0]?.actualSha256, source.sha256);
    const bytes = await store.readArtifactBytes(artifacts[0]?.relativePath ?? "");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  });
});

test("meeting capture: start multiple sources under one meeting with deterministic ordering", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const started = await runFlow(store, adapter, ALL_SOURCES);

    assert.equal(started.meetingStatus, "COMPLETED");
    assert.deepEqual(started.requestedCapabilities, ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"]);
    assert.deepEqual(
      started.sources.map((source) => source.kind),
      ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"],
    );
    for (const kind of ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"] as const) {
      const source = sourceOf(started, kind);
      assert.equal(source.state, "COMMITTED", `${kind} committed`);
      assert.equal(source.artifactCommitted, true);
      assert.ok((source.chunksWritten ?? 0) > 0, `${kind} produced chunks`);
      assert.ok(source.sha256 !== undefined);
    }
    const artifacts = recordingArtifacts(store, started.meetingId);
    assert.equal(artifacts.length, 3);
    const recordings = store.database.listRecordings(started.meetingId);
    assert.equal(recordings.length, 3);
    assert.ok(new Set(recordings.map((record) => record.captureSource)).size === 3);
  });
});

test("meeting capture: concurrent sources run with independent pipelines", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const config: MeetingCaptureConfig = { microphone: true, systemLoopback: true, screen: false };
    const started = await orchestrator.start(config, {});
    assert.equal(started.meetingStatus, "RECORDING");
    // Both sources are active in the same snapshot: independent pipelines.
    assert.deepEqual(started.activeSources, ["MICROPHONE", "SYSTEM_LOOPBACK"]);
    assert.ok(adapter.maxConcurrentSessions >= 2, "native sessions overlapped concurrently");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stopped = await orchestrator.stop(started.meetingId);
    assert.equal(stopped.meetingStatus, "COMPLETED");
    assert.ok(adapter.maxConcurrentSessions >= 2);
    const mic = adapter.sessionFor("MICROPHONE_AUDIO");
    const loop = adapter.sessionFor("SYSTEM_AUDIO");
    assert.ok(mic !== undefined && loop !== undefined);
    assert.ok(mic.emittedChunkCount() > 0 && loop.emittedChunkCount() > 0);
  });
});

test("meeting capture: required-source startup failure leaves FAILED with no committed recording", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter({
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        SCREEN: unavailableCapability("SCREEN", "No screen available in this environment."),
      },
    });
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start({ microphone: true, systemLoopback: false, screen: true });
    assert.equal(started.meetingStatus, "FAILED");
    assert.equal(started.phase, "FAILED");
    assert.equal(started.startedCapabilities.length, 0);
    assert.equal(started.failure?.failed, true);
    assert.ok(started.failure?.reason.includes("SCREEN"));
    assert.deepEqual(started.sources.map((source) => source.state), ["NOT_STARTED", "NOT_STARTED"]);
    assert.equal(store.getMeeting(started.meetingId)?.status, "FAILED");
    assert.equal(recordingArtifacts(store, started.meetingId).length, 0);
    assert.equal(store.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId).length, 0);
    assert.equal(store.database.listRecordings(started.meetingId).length, 0);
  });
});

test("meeting capture: partial startup rollback aborts started sources and leaves no misleading recording", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter({
      startFailure: {
        SYSTEM_AUDIO: new NativeCaptureError({
          code: "NATIVE_CAPTURE_START_FAILED",
          message: "Loopback device vanished at start.",
          capability: "SYSTEM_AUDIO",
          retryable: true,
        }),
      },
    });
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start({ microphone: true, systemLoopback: true, screen: true });
    assert.equal(started.meetingStatus, "FAILED");
    assert.equal(started.failure?.source, "SYSTEM_LOOPBACK");
    assert.ok(started.failure?.reason.includes("SYSTEM_LOOPBACK"));
    // MICROPHONE started first and was rolled back: aborted, never committed.
    const mic = sourceOf(started, "MICROPHONE");
    assert.equal(mic.state, "INCOMPLETE");
    assert.equal(mic.artifactCommitted, false);
    assert.ok(mic.error !== undefined);
    const loop = sourceOf(started, "SYSTEM_LOOPBACK");
    assert.equal(loop.state, "NOT_STARTED");
    const screen = sourceOf(started, "SCREEN");
    assert.equal(screen.state, "NOT_STARTED");
    assert.equal(recordingArtifacts(store, started.meetingId).length, 0);
    assert.equal(store.database.listRecordings(started.meetingId).length, 0);
    // The aborted microphone operation stays in the journal as evidence.
    const operations = store.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.state, "INCOMPLETE");
  });
});

test("meeting capture: stop finalizes every source and verifies artifacts before COMPLETED", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const stopped = await orchestrator.stop(started.meetingId);
    assert.equal(stopped.meetingStatus, "COMPLETED");
    assert.equal(stopped.phase, "COMPLETED");
    assert.equal(stopped.failure, undefined);
    assert.deepEqual(stopped.activeSources, []);
    for (const kind of ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"] as const) {
      const source = sourceOf(stopped, kind);
      assert.equal(source.state, "COMMITTED");
      assert.equal(source.journalState, "COMMITTED");
      assert.equal(source.artifactCommitted, true);
      assert.ok(source.endedAt !== undefined);
      assert.ok(source.durationMs !== undefined && source.durationMs > 0);
    }
    const report = await store.recovery.verifyStorage();
    assert.deepEqual(report.issues, []);
  });
});

test("meeting capture: partial stop/finalization failure prevents COMPLETED and keeps committed siblings", async () => {
  await withTempStore(async (store) => {
    const failing = new NativeCaptureError({
      code: "NATIVE_CAPTURE_STOP_FAILED",
      message: "The loopback capture could not stop cleanly.",
      capability: "SYSTEM_AUDIO",
      retryable: true,
    });
    const adapter = new ScriptedNativeAdapter({
      sessions: (request) => new ScriptedNativeSession(request, {
        capability: request.capability,
        chunkIntervalMs: 8,
        ...(request.capability === "SYSTEM_AUDIO" ? { stopError: failing } : {}),
      }),
    });
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stopped = await orchestrator.stop(started.meetingId);

    assert.notEqual(stopped.meetingStatus, "COMPLETED");
    assert.equal(stopped.meetingStatus, "INCOMPLETE");
    assert.equal(stopped.failure?.failed, false);
    assert.equal(stopped.failure?.source, "SYSTEM_LOOPBACK");
    assert.ok(stopped.failure?.reason.includes("stop cleanly"));
    // The healthy sources still committed; the failing one did not.
    assert.equal(sourceOf(stopped, "MICROPHONE").state, "COMMITTED");
    assert.equal(sourceOf(stopped, "SCREEN").state, "COMMITTED");
    assert.equal(sourceOf(stopped, "SYSTEM_LOOPBACK").state, "INCOMPLETE");
    const recordings = store.database.listRecordings(started.meetingId);
    assert.equal(recordings.filter((record) => record.finalStatus === "COMMITTED").length, 2);
    assert.equal(recordings.filter((record) => record.finalStatus === "COMMITTED" && record.captureSource?.includes("SYSTEM_AUDIO")).length, 0);
  });
});

test("meeting capture: abort stops sources, never claims COMPLETED, and keeps the meeting recoverable", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const aborted = await orchestrator.abort(started.meetingId, "User cancelled the capture.");
    assert.equal(aborted.meetingStatus, "INCOMPLETE");
    assert.equal(aborted.phase, "INCOMPLETE");
    assert.equal(aborted.failure?.failed, false);
    assert.equal(aborted.failure?.reason, "User cancelled the capture.");
    for (const kind of ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"] as const) {
      assert.equal(sourceOf(aborted, kind).state, "INCOMPLETE");
      assert.equal(sourceOf(aborted, kind).artifactCommitted, false);
    }
    assert.equal(recordingArtifacts(store, started.meetingId).length, 0);
    assert.equal(store.database.listRecordings(started.meetingId).length, 0);
    const operations = store.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId);
    assert.equal(operations.filter((operation) => operation.state === "INCOMPLETE").length, 3);
    // INCOMPLETE is recoverable: a new flow can retry the same meeting.
    const retried = await runFlow(store, adapter, { microphone: true, systemLoopback: false, screen: false }, {
      meetingId: started.meetingId,
    });
    assert.equal(retried.meetingStatus, "COMPLETED");
  });
});

test("meeting capture: crash during RECORDING is detected and recovered as INCOMPLETE on next startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-flow-crash-"));
  let first: LocalFirstStore | undefined;
  let second: LocalFirstStore | undefined;
  try {
    first = new LocalFirstStore(root);
    await first.initialize();
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator, coordinator } = orchestratorStack(adapter, first);
    const started = await orchestrator.start(ALL_SOURCES);
    assert.equal(started.meetingStatus, "RECORDING");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Simulate a crash: per-source pipelines are torn down abruptly WITHOUT the
    // orchestrator stop/abort path (meeting stays RECORDING, operations stay in
    // flight), then the store closes as a process death would leave it.
    await coordinator.abortAllActive("Simulated process death during RECORDING.");
    assert.equal(first.getMeeting(started.meetingId)?.status, "RECORDING");
    first.close();

    second = new LocalFirstStore(root);
    await second.initialize();
    const meeting = second.getMeeting(started.meetingId);
    assert.equal(meeting?.status, "INCOMPLETE");
    const operations = second.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId);
    assert.ok(operations.length > 0);
    for (const operation of operations) {
      assert.notEqual(operation.state, "COMMITTED");
      assert.ok(operation.state === "INCOMPLETE" || operation.state === "FAILED");
    }
    // The interrupted meeting is reported by the recovery scanner, not deleted.
    const report = await second.recovery.verifyStorage();
    const recordingIssue = report.issues.some((issue) =>
      issue.kind === "INCOMPLETE_RECORDING" && issue.meetingId === started.meetingId,
    );
    assert.equal(recordingIssue, true);
    assert.equal(second.database.listArtifacts(started.meetingId).filter((artifact) => artifact.artifactType !== "MEETING_MANIFEST").length, 0);
  } finally {
    second?.close();
    first?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("meeting capture: crash during STARTING and STOPPING phases is recovered via the flow journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-flow-phases-"));
  let first: LocalFirstStore | undefined;
  let second: LocalFirstStore | undefined;
  try {
    first = new LocalFirstStore(root);
    await first.initialize();
    const meetingId = randomUUID();
    await first.createMeeting({ meetingId, title: "Phase crash" });
    // STARTING crash: flow journaled, meeting left PREPARING, no sources ran.
    first.startCaptureFlow({ meetingId, flowId: "phase-starting", requestedCapabilities: ["MICROPHONE"] });
    // STOPPING crash: simulate a source that began while the flow stopped.
    first.markCaptureFlowRecording(meetingId);
    first.markCaptureFlowStopping(meetingId);
    const operation = await first.beginRecordingCapture({
      meetingId,
      extension: "aiwpcm",
      mimeType: "application/x-ai-workmate-pcm-jsonl",
      captureSource: "scripted-native-capture:MICROPHONE_AUDIO",
      flowManaged: true,
    });
    first.markRecordingCaptureWriting(operation.operationId);
    assert.equal(first.getMeeting(meetingId)?.status, "FINALIZING");
    first.close();

    second = new LocalFirstStore(root);
    await second.initialize();
    const meeting = second.getMeeting(meetingId);
    assert.equal(meeting?.status, "INCOMPLETE");
    const operations = second.database.listArtifactOperations().filter((operation) => operation.meetingId === meetingId);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.state, "INCOMPLETE");
    // Evidence is preserved: the flow journal audit is still present.
    const audits = second.database.listAuditRecords(500).filter((record) => record.meetingId === meetingId);
    assert.ok(audits.some((record) => record.action === "CAPTURE_FLOW_STARTED"));
    assert.ok(audits.some((record) => record.action === "CAPTURE_FLOW_STOPPING"));
    assert.ok(audits.some((record) => record.action === "RECORDING_RECOVERED_INCOMPLETE"));
  } finally {
    second?.close();
    first?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("meeting capture: a source failing mid-run aborts the remaining sources deterministically", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter({
      sessions: (request) => new ScriptedNativeSession(request, {
        capability: request.capability,
        chunkIntervalMs: 8,
        ...(request.capability === "SYSTEM_AUDIO" ? { failAfter: 2 } : {}),
      }),
    });
    const { orchestrator } = orchestratorStack(adapter, store);
    const finished = await orchestrator.run(ALL_SOURCES, {
      durationMs: 2_000,
      pollIntervalMs: 30,
    });
    assert.equal(finished.meetingStatus, "INCOMPLETE");
    assert.equal(finished.failure?.source, "SYSTEM_LOOPBACK");
    assert.equal(finished.failure?.failed, false);
    assert.equal(sourceOf(finished, "SYSTEM_LOOPBACK").state, "INCOMPLETE");
    assert.equal(sourceOf(finished, "MICROPHONE").state, "INCOMPLETE");
    assert.equal(sourceOf(finished, "SCREEN").state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(finished.meetingId).filter((record) => record.finalStatus === "COMMITTED").length, 0);
    // The failing source's journal entry preserves the failure evidence.
    const operations = store.database.listArtifactOperations().filter((operation) => operation.meetingId === finished.meetingId);
    assert.ok(operations.every((operation) => operation.state === "INCOMPLETE" && operation.error !== undefined));
  });
});

test("meeting capture: SCREEN and WINDOW capabilities stay isolated and resolve deterministically", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start({ microphone: false, systemLoopback: false, screen: true });
    assert.equal(sourceOf(started, "SCREEN").sourceId, "screen-2"); // isDefault wins deterministically
    assert.equal(started.meetingStatus, "RECORDING");

    // WINDOW selects deterministically through the validated window path
    // (prefers ordinary windows over the shell desktop).
    const windowed = await orchestrator.start({ microphone: false, systemLoopback: false, screen: false, window: "hwnd:3000" });
    assert.equal(windowed.meetingStatus, "RECORDING");
    assert.equal(sourceOf(windowed, "WINDOW").sourceId, "hwnd:3000");
    assert.equal(sourceOf(windowed, "WINDOW").sourceLabel, "Excel - Budget.xlsx");

    // Deterministic default WINDOW selection: prefers ordinary windows over
    // the shell desktop, ordered by numeric HWND.
    const windowDefault = await orchestrator.start({
      microphone: false, systemLoopback: false, screen: false,
      window: "",
    });
    assert.equal(windowDefault.meetingStatus, "RECORDING");
    assert.equal(sourceOf(windowDefault, "WINDOW").sourceId, "hwnd:2000");
    assert.equal(sourceOf(windowDefault, "WINDOW").sourceLabel, "Notepad - notes.txt");
    await orchestrator.abort(windowDefault.meetingId);

    const windowInvalid = await orchestrator.start({
      microphone: false, systemLoopback: false, screen: false,
      window: "hwnd:9999",
    });
    assert.equal(windowInvalid.meetingStatus, "FAILED");
    assert.ok(windowInvalid.failure?.reason.includes("not listed"));

    const stoppedWindow = await orchestrator.stop(windowed.meetingId);
    assert.equal(stoppedWindow.meetingStatus, "COMPLETED");
    const stoppedScreen = await orchestrator.stop(started.meetingId);
    assert.equal(stoppedScreen.meetingStatus, "COMPLETED");
    // SCREEN and WINDOW never fall back to each other.
    const windowArtifact = store.database.listRecordings(windowed.meetingId)[0];
    const screenArtifact = store.database.listRecordings(started.meetingId)[0];
    assert.ok(windowArtifact?.captureSource?.includes(":WINDOW"));
    assert.ok(screenArtifact?.captureSource?.includes(":SCREEN"));
  });
});

test("meeting capture: microphone and system-loopback capabilities stay isolated", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter({
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        SYSTEM_AUDIO: unavailableCapability("SYSTEM_AUDIO", "No loopback device."),
      },
    });
    const { orchestrator } = orchestratorStack(adapter, store);
    const failed = await orchestrator.start({ microphone: true, systemLoopback: true, screen: false });
    assert.equal(failed.meetingStatus, "FAILED");
    assert.equal(sourceOf(failed, "SYSTEM_LOOPBACK").state, "NOT_STARTED");

    // A microphone-only flow still works when loopback is unavailable.
    const micOnly = await runFlow(store, adapter, { microphone: true, systemLoopback: false, screen: false });
    assert.equal(micOnly.meetingStatus, "COMPLETED");
    const record = store.database.listRecordings(micOnly.meetingId)[0];
    assert.equal(record?.captureSource, "scripted-native-capture:MICROPHONE_AUDIO");
  });
});

test("meeting capture: snapshots never expose absolute DATA_ROOT paths", async () => {
  await withTempStore(async (store, root) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    const json = JSON.stringify(started);
    assert.equal(json.includes(root), false);
    assert.equal(/([A-Za-z]:[\\/])|(file:\/\/)/.test(json), false);
    assert.equal(json.includes("relativePath"), false);
    const stopped = await orchestrator.stop(started.meetingId);
    assert.equal(JSON.stringify(stopped).includes(root), false);
  });
});

test("meeting capture: recording bytes never enter SQLite; artifacts stay on disk only", async () => {
  await withTempStore(async (store, root) => {
    const adapter = new ScriptedNativeAdapter();
    const started = await runFlow(store, adapter, ALL_SOURCES);
    const recordings = store.database.listRecordings(started.meetingId);
    const artifacts = recordingArtifacts(store, started.meetingId);
    assert.equal(recordings.length, 3);
    assert.equal(artifacts.length, 3);
    const marker = `"source":"SCREEN","tag":"test","sequence":0`;
    const databaseBytes = await store.storage.readFile("Database/ai-workmate.sqlite");
    assert.equal(databaseBytes.includes(marker), false);
    for (const artifact of artifacts) {
      assert.ok(!artifact.relativePath.includes(".tmp-"));
      assert.ok(artifact.size > 0);
      const bytes = await store.readArtifactBytes(artifact.relativePath);
      assert.equal(bytes.length, artifact.size);
      const fileDatabase = await store.storage.readFile("Database/ai-workmate.sqlite");
      const needle = Buffer.from(bytes.subarray(0, 24)).toString("utf8");
      assert.equal(fileDatabase.includes(needle), false, "artifact payload is not copied into SQLite");
    }
    const files = await store.storage.listFiles();
    assert.ok(files.every((file) => !file.relativePath.includes(".tmp-")), "no temporary files remain after commit");
    void root;
  });
});

test("meeting capture: journal and SQLite commit ordering completes the meeting last", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    const meetingId = started.meetingId;
    const before = store.getMeeting(meetingId);
    assert.equal(before?.status, "RECORDING");
    assert.equal(store.database.listArtifactOperations().filter((operation) => operation.meetingId === meetingId).length, 3);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stopped = await orchestrator.stop(meetingId);
    assert.equal(stopped.meetingStatus, "COMPLETED");
    const operations = store.database.listArtifactOperations().filter((operation) => operation.meetingId === meetingId);
    assert.equal(operations.filter((operation) => operation.state === "COMMITTED").length, 3);
    for (const operation of operations) {
      assert.ok(operation.fileId !== undefined);
      assert.equal(operation.actualSha256?.length, 64);
    }
    const audits = store.database.listAuditRecords(500).filter((record) => record.meetingId === meetingId);
    const order = audits.map((record) => record.action);
    const indexOf = (action: string): number => order.indexOf(action);
    const lastIndexOf = (action: string): number => order.lastIndexOf(action);
    // Newest-first audit ordering: flow completion must be the newest terminal
    // entry, and every per-source CAPTURE_COMMITTED precedes it.
    assert.ok(indexOf("CAPTURE_FLOW_COMPLETED") < indexOf("CAPTURE_FLOW_STARTED"));
    for (const action of ["CAPTURE_STARTED", "CAPTURE_COMMITTED"]) {
      assert.ok(lastIndexOf(action) > indexOf("CAPTURE_FLOW_COMPLETED"), `${action} precedes flow completion`);
    }
    assert.ok(indexOf("CAPTURE_FLOW_RECORDING") > indexOf("CAPTURE_FLOW_STOPPING"));
  });
});

test("meeting capture: SHA-256 verification matches engine, artifact row, and file", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const started = await runFlow(store, adapter, ALL_SOURCES);
    for (const kind of ["MICROPHONE", "SYSTEM_LOOPBACK", "SCREEN"] as const) {
      const source = sourceOf(started, kind);
      const artifact = recordingArtifacts(store, started.meetingId).find((item) =>
        store.database.listRecordings(started.meetingId).some(
          (record) => record.artifactId === item.fileId && record.captureSource?.includes(MEETING_CAPTURE_KIND_TO_NATIVE[kind]),
        ),
      );
      assert.ok(artifact !== undefined);
      assert.equal(artifact.sha256, source.sha256);
      const bytes = await store.readArtifactBytes(artifact.relativePath);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(fileHash, source.sha256);
      const verification = await store.storage.inspectFile(artifact.relativePath, source.sha256);
      assert.equal(verification.status, "AVAILABLE");
    }
  });
});

test("meeting capture: a meeting can only host one active capture flow at a time", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    await assert.rejects(
      orchestrator.start({ microphone: true, systemLoopback: false, screen: false }, { meetingId: started.meetingId }),
      /already active/,
    );
    await orchestrator.abort(started.meetingId);
    await assert.rejects(orchestrator.stop(started.meetingId), /No active capture flow/);
    await assert.rejects(orchestrator.abort(started.meetingId), /No active capture flow/);
  });
});

test("meeting capture: two truly concurrent start() calls for the same brand-new meetingId never both succeed", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    const meetingId = randomUUID();
    // Fire both calls without awaiting the first, so both race the meeting
    // creation step before either has reserved the active-flow slot on a
    // *previous* implementation. With the fix, the in-memory reservation
    // happens synchronously before any `await`, so the second caller is
    // rejected immediately with a clean "already active" error instead of a
    // raw SQLite unique-constraint failure or a silently duplicated flow.
    const results = await Promise.allSettled([
      orchestrator.start(ALL_SOURCES, { meetingId }),
      orchestrator.start(ALL_SOURCES, { meetingId }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent start() call must succeed");
    assert.equal(rejected.length, 1, "the other concurrent start() call must be rejected");
    const rejection = rejected[0] as PromiseRejectedResult;
    assert.match(String((rejection.reason as Error).message), /already active/);
    assert.equal(store.database.listMeetings().length, 1, "only one meeting row is ever created");
    await orchestrator.abort(meetingId);
  });
});

test("meeting capture: window sourceId rejects path-like values", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter();
    const { orchestrator } = orchestratorStack(adapter, store);
    await assert.rejects(
      orchestrator.start({ microphone: false, systemLoopback: false, screen: false, window: "C:\\Users\\secret" }),
      /not a path/,
    );
    await assert.rejects(
      orchestrator.start({ microphone: false, systemLoopback: false, screen: false, window: "/etc/passwd" }),
      /not a path/,
    );
    await assert.rejects(
      orchestrator.start({ microphone: false, systemLoopback: false, screen: false }),
      /requires at least one capture source/,
    );
    assert.equal(store.database.listMeetings().length, 0, "validation failures never create meetings");
  });
});

test("meeting capture: unsupported platform fails closed before any source starts", async () => {
  await withTempStore(async (store) => {
    const adapter = new ScriptedNativeAdapter({ supported: false, platform: "linux" });
    const { orchestrator } = orchestratorStack(adapter, store);
    const started = await orchestrator.start(ALL_SOURCES);
    assert.equal(started.meetingStatus, "FAILED");
    assert.equal(started.sources.every((source) => source.state === "NOT_STARTED"), true);
    assert.equal(store.database.listArtifactOperations().filter((operation) => operation.meetingId === started.meetingId).length, 0);
  });
});
