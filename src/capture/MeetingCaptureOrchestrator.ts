import { randomUUID } from "node:crypto";

import type { MeetingStatus } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { DataRootValidationError, StorageError } from "../storage/errors";
import type { CaptureStateSnapshot } from "./CaptureEngine";
import type { LocalRecordingCaptureEngine } from "./LocalRecordingCaptureEngine";
import type {
  NativeCaptureCapabilities,
  NativeCaptureErrorCode,
  NativeCaptureErrorInfo,
  NativeCaptureKind,
  NativeCaptureStateSnapshot,
} from "./NativeCaptureAdapter";
import type { NativeCaptureCoordinator } from "./NativeCaptureCoordinator";
import {
  WINDOWS_AUDIO_CAPTURE_FORMAT,
  WINDOWS_AUDIO_CAPTURE_MIME_TYPE,
} from "./WindowsNativeAudioProvider";
import {
  WINDOWS_SCREEN_CAPTURE_FORMAT,
  WINDOWS_SCREEN_CAPTURE_MIME_TYPE,
} from "./WindowsNativeScreenProvider";
import { defaultSourceId } from "./WindowsRuntimeScreenCaptureVerification";
import { selectDeterministicWindowSource } from "./WindowsRuntimeWindowCaptureVerification";

/**
 * Unified meeting capture orchestrator (Phase 8).
 *
 * Coordinates several independent capture sources under ONE meeting lifecycle:
 *   STARTING (storage PREPARING) -> RECORDING -> STOPPING (storage FINALIZING)
 *   -> COMPLETED, with INCOMPLETE/FAILED recovery outcomes.
 *
 * Source model: MICROPHONE / SYSTEM_LOOPBACK / SCREEN / WINDOW. Each source is
 * started through the existing native-capture boundary (NativeCaptureAdapter ->
 * NativeCaptureCoordinator -> LocalRecordingCaptureEngine) with its own
 * captureId, artifact-operation journal entry, SQLite artifact/recording rows,
 * sequence counter, SHA-256 and staged-file lifecycle. Sources run concurrently
 * and remain independent; the meeting status transitions exactly once per flow.
 *
 * The orchestrator never exposes absolute DATA_ROOT paths in snapshots and never
 * stores recording bytes in SQLite (artifacts live on the LocalStorageService
 * filesystem, indexed by relative path only).
 */
export type MeetingCaptureSourceKind = "MICROPHONE" | "SYSTEM_LOOPBACK" | "SCREEN" | "WINDOW";

export const MEETING_CAPTURE_SOURCE_KINDS: readonly MeetingCaptureSourceKind[] = Object.freeze([
  "MICROPHONE",
  "SYSTEM_LOOPBACK",
  "SCREEN",
  "WINDOW",
]);

export const MEETING_CAPTURE_KIND_TO_NATIVE: Readonly<Record<MeetingCaptureSourceKind, NativeCaptureKind>> = {
  MICROPHONE: "MICROPHONE_AUDIO",
  SYSTEM_LOOPBACK: "SYSTEM_AUDIO",
  SCREEN: "SCREEN",
  WINDOW: "WINDOW",
};

export const MEETING_CAPTURE_KIND_LABELS: Readonly<Record<MeetingCaptureSourceKind, string>> = {
  MICROPHONE: "Microphone",
  SYSTEM_LOOPBACK: "System loopback",
  SCREEN: "Screen",
  WINDOW: "Window",
};

/**
 * Typed capture configuration. `window` requests the WINDOW source and is a
 * native WINDOW sourceId; the empty string "" requests WINDOW with the
 * deterministic default selection (the same validated path the Windows window
 * verification uses). The orchestrator never accepts renderer-controlled
 * filesystem paths.
 */
export interface MeetingCaptureConfig {
  microphone: boolean;
  systemLoopback: boolean;
  screen: boolean;
  window?: string;
}

export interface MeetingCaptureStartOptions {
  /** Start a flow for an existing meeting. */
  meetingId?: string;
  /** Title used when the flow creates a new meeting. */
  title?: string;
}

export type MeetingCapturePhase =
  | "STARTING"
  | "RECORDING"
  | "STOPPING"
  | "COMPLETED"
  | "INCOMPLETE"
  | "FAILED"
  | "CANCELLED";

export type MeetingCaptureSourceState =
  | "STARTING"
  | "RECORDING"
  | "STOPPING"
  | "COMMITTED"
  | "INCOMPLETE"
  | "FAILED"
  | "NOT_STARTED";

export type MeetingCaptureJournalState =
  | "STARTED"
  | "WRITING"
  | "FINALIZING"
  | "COMMITTED"
  | "INCOMPLETE"
  | "FAILED";

export interface MeetingCaptureSourceSnapshot {
  kind: MeetingCaptureSourceKind;
  capability: NativeCaptureKind;
  captureId?: string;
  sourceId?: string;
  /** Renderer-safe display label (never a filesystem path). */
  sourceLabel: string;
  state: MeetingCaptureSourceState;
  journalState: MeetingCaptureJournalState | "NOT_STARTED";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  chunksWritten: number;
  bytesWritten: number;
  /** First and last contiguous sequence numbers written (chunk index base 0). */
  firstSequence?: number;
  lastSequence?: number;
  sha256?: string;
  /** True only after the per-source artifact and recording rows are committed. */
  artifactCommitted: boolean;
  error?: NativeCaptureErrorInfo;
}

export interface MeetingCaptureFlowSnapshot {
  flowId: string;
  meetingId: string;
  meetingStatus: MeetingStatus;
  phase: MeetingCapturePhase;
  requestedCapabilities: MeetingCaptureSourceKind[];
  startedCapabilities: MeetingCaptureSourceKind[];
  /** Sources that are still running (RECORDING or STOPPING). */
  activeSources: MeetingCaptureSourceKind[];
  sources: MeetingCaptureSourceSnapshot[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  failure?: { failed: boolean; reason: string; source?: MeetingCaptureSourceKind };
}

export interface MeetingCaptureRunOptions {
  durationMs?: number;
  pollIntervalMs?: number;
}

export interface MeetingCaptureOrchestratorDependencies {
  store: LocalFirstStore;
  coordinator: NativeCaptureCoordinator;
  engine: LocalRecordingCaptureEngine;
  clock?: () => Date;
}

const DEFAULT_RUN_DURATION_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

interface ActiveFlowSource {
  kind: MeetingCaptureSourceKind;
  capability: NativeCaptureKind;
  captureId: string;
  sourceId?: string;
  descriptorLabel?: string;
  /** Last native coordinator snapshot (may be stale; engine state is authoritative). */
  nativeSnapshot?: NativeCaptureStateSnapshot;
}

interface ActiveFlow {
  flowId: string;
  meetingId: string;
  requestedCapabilities: MeetingCaptureSourceKind[];
  startedCapabilities: MeetingCaptureSourceKind[];
  startedAt: string;
  sources: ActiveFlowSource[];
  startFinished: boolean;
}

/**
 * Storage/main-process capture lifecycle for one meeting with multiple
 * independent capture sources. Production path only: native sessions come from
 * a real NativeCaptureAdapter (test doubles are confined to tests behind the
 * NativeCaptureAdapter interface).
 */
export class MeetingCaptureOrchestrator {
  private readonly store: LocalFirstStore;
  private readonly coordinator: NativeCaptureCoordinator;
  private readonly engine: LocalRecordingCaptureEngine;
  private readonly clock: () => Date;
  private readonly activeByMeetingId = new Map<string, ActiveFlow>();
  private readonly activeByFlowId = new Map<string, ActiveFlow>();

  public constructor(dependencies: MeetingCaptureOrchestratorDependencies) {
    this.store = dependencies.store;
    this.coordinator = dependencies.coordinator;
    this.engine = dependencies.engine;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  public getActiveMeetingIds(): string[] {
    return [...this.activeByMeetingId.keys()];
  }

  /**
   * Sanitized live snapshots of every active capture flow. Used by the meeting
   * hub to render recording controls from the real orchestrator state; flows
   * started in this process are the only ones reported (crash recovery of
   * interrupted flows is handled by persisted meeting status recovery).
   */
  public getActiveFlowSnapshots(): MeetingCaptureFlowSnapshot[] {
    return [...this.activeByMeetingId.values()].map((flow) => this.snapshot(flow));
  }

  /** Native capture capability discovery (delegates to the coordinator). */
  public discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    return this.coordinator.discoverCapabilities();
  }

  /**
   * Transactional flow start: create/reuse the meeting in STARTING (PREPARING),
   * validate requested capabilities, resolve SCREEN/WINDOW/audio sources through
   * the existing deterministic selection paths, then start each requested source
   * through the native capture boundary. Every per-source capture is recorded
   * only after its native session actually started. If any required source
   * cannot start, already-started sources are aborted, no committed recording
   * is left behind, and the meeting is marked FAILED (recoverable via the
   * existing FAILED -> PREPARING retry path).
   */
  public async start(config: MeetingCaptureConfig, options: MeetingCaptureStartOptions = {}): Promise<MeetingCaptureFlowSnapshot> {
    const requested = requestedKinds(config);
    validateWindowSourceId(config.window);
    if (requested.length === 0) {
      throw new DataRootValidationError("A meeting capture flow requires at least one capture source.");
    }
    const meetingId = options.meetingId ?? randomUUID();
    const existing = this.store.getMeeting(meetingId);
    if (existing === undefined) {
      await this.store.createMeeting({
        meetingId,
        title: options.title?.trim() || "Meeting capture",
        // meetingDate is a LOCAL day everywhere the hub buckets by day; the
        // UTC startedAt alone would park late-evening local recordings on
        // "tomorrow" and hide them from Today.
        meetingDate: localDateKey(this.clock()),
        startedAt: this.clock().toISOString(),
      });
    } else if (this.activeByMeetingId.has(meetingId)) {
      throw new StorageError(`A capture flow is already active for meeting ${meetingId}.`);
    }
    const flowId = randomUUID();
    const startedAt = this.clock().toISOString();
    this.store.startCaptureFlow({
      meetingId,
      flowId,
      requestedCapabilities: requested,
    });
    const flow: ActiveFlow = {
      flowId,
      meetingId,
      requestedCapabilities: requested,
      startedCapabilities: [],
      startedAt,
      sources: [],
      startFinished: false,
    };
    this.activeByMeetingId.set(meetingId, flow);
    this.activeByFlowId.set(flowId, flow);

    // Validate every requested capability and resolve sources BEFORE any native
    // session starts so a missing provider cannot silently drop a requested
    // source after other sources are already running.
    let capabilities: NativeCaptureCapabilities;
    try {
      capabilities = await this.coordinator.discoverCapabilities();
    } catch (error: unknown) {
      return this.finishStartFailure(flow, "Native capture capability discovery failed.", errorMessage(error));
    }

    const preflight: Array<{ kind: MeetingCaptureSourceKind; capability: NativeCaptureKind; sourceId?: string; descriptorLabel?: string }> = [];
    for (const kind of requested) {
      const capabilityKind = MEETING_CAPTURE_KIND_TO_NATIVE[kind];
      const capability = capabilities.capabilities[capabilityKind];
      if (!capabilities.supported || capability === undefined || !capability.available) {
        const message = capability?.error?.message ?? `Native capture capability ${capabilityKind} is unavailable.`;
        return this.finishStartFailure(flow, `Required source ${kind} cannot start: ${message}`, message);
      }
      const explicitSourceId = kind === "WINDOW" && (config.window?.length ?? 0) > 0 ? config.window : undefined;
      let sourceId: string | undefined;
      if (explicitSourceId !== undefined) {
        sourceId = explicitSourceId;
        if (capability.sources !== undefined && !capability.sources.some((source) => source.sourceId === explicitSourceId)) {
          return this.finishStartFailure(
            flow,
            `Required source ${kind} cannot start: sourceId ${explicitSourceId} is not listed by the native provider.`,
            `WINDOW source ${explicitSourceId} is not listed by the native provider.`,
          );
        }
      } else if (kind === "WINDOW") {
        sourceId = selectDeterministicWindowSource(capability.sources)?.sourceId;
        if (sourceId === undefined) {
          return this.finishStartFailure(
            flow,
            `Required source ${kind} cannot start: no capturable window is available.`,
            "No capturable window is available for deterministic WINDOW selection.",
          );
        }
      } else {
        sourceId = defaultSourceId(capability);
      }
      const descriptor = capability.sources?.find((source) => source.sourceId === sourceId);
      preflight.push({
        kind,
        capability: capabilityKind,
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(descriptor?.label === undefined ? {} : { descriptorLabel: descriptor.label }),
      });
    }

    // Start each source through the existing capture boundary, in the fixed
    // canonical order (deterministic). Sessions run concurrently once started.
    for (const item of preflight) {
      if (!this.activeByFlowId.has(flow.flowId)) {
        // A concurrent abort() already terminated the flow.
        return this.snapshot(flow);
      }
      try {
        const started = await this.coordinator.startCapture({
          meetingId,
          capability: item.capability,
          ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
          format: formatFor(item.kind),
          mimeType: mimeTypeFor(item.kind),
          flowId,
        });
        flow.sources.push({
          kind: item.kind,
          capability: item.capability,
          captureId: started.captureId,
          ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
          ...(item.descriptorLabel === undefined ? {} : { descriptorLabel: item.descriptorLabel }),
          nativeSnapshot: started,
        });
        flow.startedCapabilities.push(item.kind);
      } catch (error: unknown) {
        const reason = errorMessage(error);
        await this.abortSources(flow, `Rolling back started sources after ${item.kind} failed to start.`);
        return this.finishStartFailure(flow, `Required source ${item.kind} could not start: ${reason}`, reason, item.kind);
      }
    }

    if (!this.activeByFlowId.has(flow.flowId)) {
      // A concurrent abort() terminated the flow between source starts.
      return this.snapshot(flow);
    }
    try {
      this.store.markCaptureFlowRecording(meetingId);
    } catch (error: unknown) {
      await this.abortSources(flow, "Rolling back started sources; the flow could not enter RECORDING.");
      return this.finishStartFailure(flow, errorMessage(error), errorMessage(error));
    }
    flow.startFinished = true;
    return this.snapshot(flow);
  }

  /**
   * STOPPING: stops every active source, finalizes every artifact, verifies
   * files/journals/SQLite through the existing commit path, and only then marks
   * the meeting COMPLETED. Any required-source finalization failure prevents
   * COMPLETED and leaves the meeting INCOMPLETE/FAILED through the existing
   * recovery semantics.
   */
  public async stop(meetingId: string, options: { endedAt?: string } = {}): Promise<MeetingCaptureFlowSnapshot> {
    const flow = this.requireActiveFlow(meetingId);
    if (!flow.startFinished) {
      throw new StorageError(`Capture flow for meeting ${meetingId} is still starting; stop() is not valid while STARTING.`);
    }
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new StorageError(`Meeting not found: ${meetingId}`);
    }
    if (meeting.status === "PREPARING") {
      // Every source started but the RECORDING mark raced a terminal outcome;
      // an orderly stop of the sources that did start is still deterministic.
      this.store.markCaptureFlowRecording(meetingId);
    }
    if (meeting.status === "INCOMPLETE" || meeting.status === "FAILED") {
      // A concurrent failure already made the meeting terminal. Stop whatever
      // is still running and report the existing outcome.
      await this.abortSources(flow, "The capture flow was already INCOMPLETE/FAILED; stopping remaining sources.");
      this.removeFlow(flow);
      return this.snapshot(flow, {
        failure: { failed: meeting.status === "FAILED", reason: "The capture flow ended INCOMPLETE/FAILED before the stop completed." },
      });
    }
    this.store.markCaptureFlowStopping(meetingId);

    const endedAt = options.endedAt ?? this.clock().toISOString();
    const activeSources = [...flow.sources];
    // Sources stop independently and concurrently; one failing stop cannot
    // deadlock the others.
    const settled = await Promise.allSettled(activeSources.map((source) =>
      this.coordinator.stopCapture({
        captureId: source.captureId,
        meetingId,
        ...(endedAt === undefined ? {} : { endedAt }),
      }),
    ));
    settled.forEach((outcome, index) => {
      const source = activeSources[index];
      if (source !== undefined && outcome.status === "fulfilled") {
        source.nativeSnapshot = outcome.value;
      }
    });

    // Deterministic terminal evaluation in canonical source order: a FAILED
    // source marks the meeting FAILED; an INCOMPLETE source marks it
    // INCOMPLETE; COMPLETED is only reachable when every required source
    // committed.
    let worst: { failed: boolean; reason: string; source?: MeetingCaptureSourceKind } | undefined;
    for (const source of flow.sources) {
      const outcome = settled[flow.sources.indexOf(source)];
      if (outcome?.status === "fulfilled" && outcome.value.state === "COMPLETED") {
        continue;
      }
      const live = this.liveEngineState(source);
      if (live !== undefined && live.state === "COMPLETED") {
        continue;
      }
      const failed = live?.state === "FAILED";
      const reason =
        live?.error?.message ??
        (outcome?.status === "rejected"
          ? outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          : `Source ${source.kind} did not reach COMMITTED (${live?.state ?? "no state"})`);
      if (worst === undefined || (failed && !worst.failed)) {
        worst = { failed, reason, source: source.kind };
      }
    }

    if (worst === undefined) {
      this.store.completeCaptureFlow(meetingId, endedAt);
    } else {
      this.store.failCaptureFlow(meetingId, worst.reason, worst.failed);
    }
    this.removeFlow(flow);
    return this.snapshot(flow, worst === undefined ? {} : { failure: worst });
  }

  /**
   * Abort: stops all active captures, never claims COMPLETED, keeps the meeting
   * and artifact-operation journals recoverable, and preserves failure
   * evidence. A meeting that already ended FAILED or CANCELLED is never
   * downgraded to INCOMPLETE; otherwise the meeting is marked INCOMPLETE.
   */
  public async abort(meetingId: string, reason = "Capture flow aborted by the caller."): Promise<MeetingCaptureFlowSnapshot> {
    const flow = this.requireActiveFlow(meetingId);
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new StorageError(`Meeting not found: ${meetingId}`);
    }
    const terminalStatus = meeting.status;
    if (terminalStatus === "FAILED" || terminalStatus === "CANCELLED") {
      // Keep the stronger outcome; journal the abort as evidence.
      this.store.journalCaptureFlowOutcome(meetingId, "CAPTURE_FLOW_ABORTED", reason);
    } else {
      this.store.failCaptureFlow(meetingId, reason, false);
    }
    await this.abortSources(flow, reason);
    this.removeFlow(flow);
    return this.snapshot(flow, { failure: { failed: terminalStatus === "FAILED", reason } });
  }

  /** Abort every active flow (runtime shutdown path). */
  public async abortAllActive(reason: string): Promise<void> {
    const flows = [...this.activeByMeetingId.values()];
    for (const flow of flows) {
      await this.abort(flow.meetingId, reason).catch(() => undefined);
    }
  }

  /**
   * Convenience lifecycle used by verification and tests: start the flow, keep
   * sources running for durationMs, then stop. If any required source fails
   * while the others run, the remaining sources are aborted deterministically
   * and the meeting ends INCOMPLETE (existing failure semantics) with the
   * failure evidence preserved.
   */
  public async run(config: MeetingCaptureConfig, options: MeetingCaptureStartOptions & MeetingCaptureRunOptions = {}): Promise<MeetingCaptureFlowSnapshot> {
    const durationMs = options.durationMs ?? DEFAULT_RUN_DURATION_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const started = await this.start(config, options);
    if (started.meetingStatus === "FAILED" || started.meetingStatus === "INCOMPLETE" || started.meetingStatus === "CANCELLED") {
      return started;
    }
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await wait(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      const flow = this.activeByFlowId.get(started.flowId);
      if (flow === undefined) {
        // A concurrent abort() ended the flow; the abort caller owns the result.
        return this.snapshotForRemovedFlow(started.meetingId);
      }
      for (const source of [...flow.sources]) {
        const live = this.liveEngineState(source);
        if (live !== undefined && (live.state === "INCOMPLETE" || live.state === "FAILED")) {
          const reason = live.error?.message ?? `Source ${source.kind} failed while the flow was running.`;
          await this.abortSources(flow, `A required source failed while running; stopping the remaining sources. (${reason})`);
          if (this.activeByFlowId.has(flow.flowId)) {
            this.store.failCaptureFlow(flow.meetingId, reason, live.state === "FAILED");
            this.removeFlow(flow);
          }
          return this.snapshot(flow, { failure: { failed: live.state === "FAILED", reason, source: source.kind } });
        }
      }
    }
    return this.stop(started.meetingId);
  }

  private async abortSources(flow: ActiveFlow, reason: string): Promise<void> {
    const sources = [...flow.sources];
    const settled = await Promise.allSettled(sources.map((source) =>
      this.coordinator.abortCapture({
        captureId: source.captureId,
        meetingId: flow.meetingId,
        reason,
      }),
    ));
    settled.forEach((outcome, index) => {
      const source = sources[index];
      if (source !== undefined && outcome.status === "fulfilled") {
        source.nativeSnapshot = outcome.value;
      }
    });
  }

  private finishStartFailure(flow: ActiveFlow, reason: string, detail: string, source?: MeetingCaptureSourceKind): MeetingCaptureFlowSnapshot {
    this.store.failCaptureFlow(flow.meetingId, detail, true);
    this.removeFlow(flow);
    return this.snapshot(flow, { failure: { failed: true, reason, ...(source === undefined ? {} : { source }) } });
  }

  private removeFlow(flow: ActiveFlow): void {
    this.activeByMeetingId.delete(flow.meetingId);
    this.activeByFlowId.delete(flow.flowId);
  }

  private requireActiveFlow(meetingId: string): ActiveFlow {
    const flow = this.activeByMeetingId.get(meetingId);
    if (flow === undefined) {
      throw new StorageError(`No active capture flow for meeting ${meetingId}.`);
    }
    return flow;
  }

  private snapshotForRemovedFlow(meetingId: string): MeetingCaptureFlowSnapshot {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new StorageError(`Meeting not found: ${meetingId}`);
    }
    const status = meeting.status;
    return {
      flowId: "",
      meetingId,
      meetingStatus: status,
      phase: phaseForStatus(status),
      requestedCapabilities: [],
      startedCapabilities: [],
      activeSources: [],
      sources: [],
      startedAt: meeting.startedAt ?? meeting.createdAt,
      ...(meeting.endedAt === undefined ? {} : { endedAt: meeting.endedAt }),
    };
  }

  private snapshot(flow: ActiveFlow, extra: { failure?: MeetingCaptureFlowSnapshot["failure"] } = {}): MeetingCaptureFlowSnapshot {
    const meeting = this.store.getMeeting(flow.meetingId);
    const meetingStatus = meeting?.status ?? "FAILED";
    const phase = phaseForStatus(meetingStatus);
    const terminal = phase === "COMPLETED" || phase === "INCOMPLETE" || phase === "FAILED" || phase === "CANCELLED";
    const sources: MeetingCaptureSourceSnapshot[] = flow.sources.map((source) => this.sourceSnapshot(source));
    for (const kind of flow.requestedCapabilities) {
      if (!sources.some((source) => source.kind === kind)) {
        sources.push({
          kind,
          capability: MEETING_CAPTURE_KIND_TO_NATIVE[kind],
          sourceLabel: MEETING_CAPTURE_KIND_LABELS[kind],
          state: "NOT_STARTED",
          journalState: "NOT_STARTED",
          chunksWritten: 0,
          bytesWritten: 0,
          artifactCommitted: false,
        });
      }
    }
    const snapshot: MeetingCaptureFlowSnapshot = {
      flowId: flow.flowId,
      meetingId: flow.meetingId,
      meetingStatus,
      phase,
      requestedCapabilities: [...flow.requestedCapabilities],
      startedCapabilities: [...flow.startedCapabilities],
      activeSources: sources.filter((source) => source.state === "RECORDING" || source.state === "STOPPING").map((source) => source.kind),
      sources,
      startedAt: flow.startedAt,
      ...(extra.failure === undefined ? {} : { failure: extra.failure }),
    };
    if (terminal) {
      const endedAt = meeting?.endedAt ?? this.clock().toISOString();
      snapshot.endedAt = endedAt;
      const elapsed = durationMs(flow.startedAt, endedAt);
      if (elapsed !== undefined) {
        snapshot.durationMs = elapsed;
      }
    }
    return snapshot;
  }

  /** Live per-source state from the engine (authoritative), else last coordinator snapshot. */
  private liveEngineState(source: ActiveFlowSource): CaptureStateSnapshot | undefined {
    try {
      return this.engine.getCaptureState(source.captureId);
    } catch {
      return source.nativeSnapshot;
    }
  }

  private sourceSnapshot(source: ActiveFlowSource): MeetingCaptureSourceSnapshot {
    const live = source.captureId === undefined ? undefined : this.liveEngineState(source);
    const state: MeetingCaptureSourceState = live === undefined
      ? "NOT_STARTED"
      : live.state === "COMPLETED"
        ? "COMMITTED"
        : live.state === "FINALIZING"
          ? "STOPPING"
          : live.state === "RECORDING"
            ? "RECORDING"
            : live.state === "FAILED"
              ? "FAILED"
              : live.state === "INCOMPLETE"
                ? "INCOMPLETE"
                : "STARTING";
    const journalState: MeetingCaptureJournalState | "NOT_STARTED" = state === "NOT_STARTED" || state === "STARTING"
      ? "STARTED"
      : state === "RECORDING"
        ? "WRITING"
        : state === "STOPPING"
          ? "FINALIZING"
          : state === "COMMITTED"
            ? "COMMITTED"
            : state;
    const snapshot: MeetingCaptureSourceSnapshot = {
      kind: source.kind,
      capability: source.capability,
      captureId: source.captureId,
      ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }),
      sourceLabel: source.descriptorLabel === undefined ? MEETING_CAPTURE_KIND_LABELS[source.kind] : source.descriptorLabel,
      state,
      journalState,
      chunksWritten: live?.chunksWritten ?? 0,
      bytesWritten: live?.bytesWritten ?? 0,
      artifactCommitted: live?.artifact !== undefined || live?.state === "COMPLETED",
    };
    addOptional(snapshot, "startedAt", live?.startedAt);
    addOptional(snapshot, "endedAt", live?.endedAt);
    addOptional(snapshot, "durationMs", live?.durationMs);
    addOptional(snapshot, "sha256", live?.sha256);
    if (live !== undefined && live.chunksWritten > 0) {
      snapshot.firstSequence = 0;
      snapshot.lastSequence = live.chunksWritten - 1;
    }
    const error = live?.error;
    if (error !== undefined) {
      const native = source.nativeSnapshot?.nativeError;
      snapshot.error = native ?? { code: error.code as NativeCaptureErrorCode, message: error.message, retryable: false };
    }
    return snapshot;
  }
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function requestedKinds(config: MeetingCaptureConfig): MeetingCaptureSourceKind[] {
  const kinds: MeetingCaptureSourceKind[] = [];
  if (config.microphone === true) kinds.push("MICROPHONE");
  if (config.systemLoopback === true) kinds.push("SYSTEM_LOOPBACK");
  if (config.screen === true) kinds.push("SCREEN");
  // Presence of `window` requests WINDOW; an empty string selects the
  // deterministic default window through the existing validated path.
  if (config.window !== undefined) kinds.push("WINDOW");
  return kinds;
}

function formatFor(kind: MeetingCaptureSourceKind): string {
  return kind === "MICROPHONE" || kind === "SYSTEM_LOOPBACK"
    ? WINDOWS_AUDIO_CAPTURE_FORMAT
    : WINDOWS_SCREEN_CAPTURE_FORMAT;
}

function mimeTypeFor(kind: MeetingCaptureSourceKind): string {
  return kind === "MICROPHONE" || kind === "SYSTEM_LOOPBACK"
    ? WINDOWS_AUDIO_CAPTURE_MIME_TYPE
    : WINDOWS_SCREEN_CAPTURE_MIME_TYPE;
}

function validateWindowSourceId(sourceId: string | undefined): void {
  if (sourceId === undefined || sourceId.length === 0) {
    return;
  }
  if (containsControlCharacters(sourceId) || sourceId.includes("/") || sourceId.includes("\\")) {
    throw new DataRootValidationError("WINDOW capture sourceId must identify a native capture source, not a path.");
  }
  if (sourceId.length > 300) {
    throw new DataRootValidationError("WINDOW capture sourceId is too long.");
  }
  if (/^[a-zA-Z]:/.test(sourceId) || /^file:\/\//i.test(sourceId)) {
    throw new DataRootValidationError("WINDOW capture sourceId must identify a native capture source, not a path.");
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function phaseForStatus(status: MeetingStatus): MeetingCapturePhase {
  switch (status) {
    case "PREPARING":
      return "STARTING";
    case "RECORDING":
      return "RECORDING";
    case "FINALIZING":
      return "STOPPING";
    case "COMPLETED":
      return "COMPLETED";
    case "INCOMPLETE":
      return "INCOMPLETE";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "INCOMPLETE";
  }
}

function durationMs(startedAt: string, endedAt: string): number | undefined {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
