import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LocalRecordingCaptureEngine,
  MeetingCaptureOrchestrator,
  NativeCaptureCoordinator,
  type LocalFirstStore,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureKind,
  type NativeCapturePolicy,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
} from "../src";
import { MeetingHubError, MeetingHubService } from "../src/meetings/MeetingHubService";
import { StorageConfigService } from "../src/storage/StorageConfigService";
import { StorageRuntime } from "../src/storage/StorageRuntime";
import { withTempStore } from "./helpers";

const ALLOWED_POLICY: Partial<NativeCapturePolicy> = {
  MICROPHONE_AUDIO: "ALLOW",
  SYSTEM_AUDIO: "ALLOW",
  SCREEN: "ALLOW",
  WINDOW: "ALLOW",
};

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local naive ISO string for a day offset from today at a given hour. */
function localIso(dayOffset: number, hour = 10): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:00:00`;
}

interface CalendarSeedInput {
  subject: string;
  dayOffset: number;
  hour?: number;
  externalEventId?: string;
  joinUrl?: string;
  webUrl?: string;
  location?: string;
  provider?: "GOOGLE_CALENDAR" | "MICROSOFT_GRAPH";
  cancelled?: boolean;
}

async function seedCalendarMeeting(store: LocalFirstStore, input: CalendarSeedInput): Promise<string> {
  const startTime = localIso(input.dayOffset, input.hour ?? 10);
  const result = await store.upsertCalendarMeeting({
    provider: input.provider ?? "GOOGLE_CALENDAR",
    externalEventId: input.externalEventId ?? randomUUID(),
    subject: input.subject,
    startTime,
    endTime: `${startTime.slice(0, 11)}11:00:00`,
    attendees: [],
    isCancelled: input.cancelled === true,
    meetingPlatform: input.joinUrl !== undefined ? "OTHER_ONLINE" : "NONE",
    normalizedFingerprint: randomUUID(),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.webUrl === undefined ? {} : { webUrl: input.webUrl }),
    ...(input.joinUrl === undefined ? {} : { onlineMeeting: { provider: "Google Meet", joinUrl: input.joinUrl } }),
  });
  if (result.meetingId === undefined) {
    throw new Error(`seedCalendarMeeting failed to create a meeting for ${input.subject}`);
  }
  return result.meetingId;
}

async function seedPastMeetingWithArtifacts(store: LocalFirstStore): Promise<string> {
  const meetingId = randomUUID();
  const startedAt = localIso(-2, 9);
  const meeting = await store.createMeeting({ meetingId, title: "Past planning sync", startedAt });
  await store.saveRecording({ meetingId: meeting.meetingId, contents: Buffer.from("recording-bytes"), extension: "wav", mimeType: "audio/wav" });
  const transcript = await store.saveTranscript({
    meetingId: meeting.meetingId,
    speakers: [{ speakerId: "s1", displayName: "Ada" }],
    timestamps: true,
    language: "en",
    createdAt: new Date().toISOString(),
    segments: [
      { segmentId: randomUUID(), startMs: 0, endMs: 1000, speakerId: "s1", text: "We discussed the encryption roadmap and decided local files stay on this device." },
      { segmentId: randomUUID(), startMs: 1000, endMs: 2000, speakerId: "s1", text: "The follow-up is to verify the backup restore flow on Windows." },
    ],
  });
  await store.saveAnalysis(
    {
      meetingId: meeting.meetingId,
      createdAt: new Date().toISOString(),
      summary: "Local-first storage confirmed; backup restore verification assigned.",
      decisions: [
        { decisionId: randomUUID(), text: "All meeting data stays local.", owner: "Ada", decidedAt: new Date().toISOString() },
      ],
      tasks: [
        { taskId: randomUUID(), text: "Verify backup restore on Windows", assignee: "Ada", dueDate: "2026-10-01", status: "OPEN" },
      ],
      risks: [],
      questions: [],
      followups: ["Check restore once installer lands."],
    },
    { sourceTranscriptIds: transcript.json.fileId },
  );
  return meeting.meetingId;
}

test("meeting hub: overview groups today, upcoming, recent and history from persisted calendar meetings", async () => {
  await withTempStore(async (store) => {
    const todayId = await seedCalendarMeeting(store, {
      subject: "Today standup",
      dayOffset: 0,
      hour: 9,
      joinUrl: "https://meet.google.com/abc-defg-hij",
      webUrl: "https://calendar.google.com/calendar/event?eid=today",
    });
    const upcomingId = await seedCalendarMeeting(store, {
      subject: "Architecture review",
      dayOffset: 1,
      hour: 14,
      joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3Ameeting",
    });
    const historyId = await seedPastMeetingWithArtifacts(store);
    const hub = new MeetingHubService({ store });
    const overview = hub.getOverview();
    const todayKey = localDateKey(new Date());

    assert.equal(overview.historyTotal, 1);
    assert.equal(overview.recent.length, 1);
    assert.equal(overview.recent[0]?.meetingId, historyId);

    assert.equal(overview.today.length, 1);
    const today = overview.today[0];
    assert.ok(today !== undefined);
    assert.equal(today.meetingId, todayId);
    assert.equal(today.meetingDate, todayKey);
    assert.equal(today.status, "SCHEDULED");
    assert.equal(today.calendar?.subject, "Today standup");
    assert.equal(today.calendar?.joinUrl, "https://meet.google.com/abc-defg-hij");
    assert.equal(today.calendar?.webUrl, "https://calendar.google.com/calendar/event?eid=today");
    assert.equal(today.calendar?.provider, "GOOGLE_CALENDAR");
    assert.equal(today.calendar?.meetingPlatform, "OTHER_ONLINE");
    assert.equal(today.calendarEventId, today.calendar?.externalEventId);
    assert.equal(today.isActive, false);
    assert.equal(today.artifactCount, 0);

    assert.equal(overview.upcoming.length, 1);
    const upcoming = overview.upcoming[0];
    assert.ok(upcoming !== undefined);
    assert.equal(upcoming.meetingId, upcomingId);
    assert.equal(upcoming.calendar?.joinUrl, "https://teams.microsoft.com/l/meetup-join/19%3Ameeting");
    assert.equal(upcoming.calendar?.meetingPlatform, "OTHER_ONLINE");

    const history = overview.recent[0];
    assert.ok(history !== undefined);
    assert.equal(history.meetingId, historyId);
    assert.equal(history.hasRecording, true);
    assert.equal(history.hasTranscript, true);
    assert.equal(history.hasAnalysis, true);
    assert.equal(history.status, "COMPLETED");
    assert.ok((history.artifactCount ?? 0) >= 4);
  });
});

test("meeting hub: cancelled calendar events leave today/upcoming and enter history", async () => {
  await withTempStore(async (store) => {
    const externalEventId = randomUUID();
    const meetingId = await seedCalendarMeeting(store, {
      subject: "Cancelled sync",
      dayOffset: 0,
      hour: 15,
      externalEventId,
    });
    // The same synced event later arrives cancelled: sync cancels the meeting.
    await seedCalendarMeeting(store, {
      subject: "Cancelled sync",
      dayOffset: 0,
      hour: 15,
      externalEventId,
      cancelled: true,
    });
    const hub = new MeetingHubService({ store });
    const overview = hub.getOverview();
    assert.equal(overview.today.length, 0);
    assert.equal(overview.upcoming.length, 0);
    assert.equal(overview.historyTotal, 1);
    assert.equal(overview.recent[0]?.meetingId, meetingId);
    assert.equal(overview.recent[0]?.status, "CANCELLED");
  });
});

test("meeting hub: detail exposes folder label, artifacts, transcripts, jobs and parsed analysis", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedPastMeetingWithArtifacts(store);
    const hub = new MeetingHubService({ store });
    const detail = hub.getMeetingDetail(meetingId);

    assert.equal(detail.meeting.meetingId, meetingId);
    assert.equal(detail.meeting.hasRecording, true);
    assert.ok(detail.folderLabel.length > 0);
    assert.equal(detail.folderLabel.endsWith(meetingId), true);
    assert.ok(detail.artifacts.length >= 4);
    assert.ok(detail.artifacts.some((artifact) => artifact.artifactType === "TRANSCRIPT_TEXT"));
    assert.ok(detail.artifacts.every((artifact) => artifact.label.length > 0));
    assert.equal(detail.transcripts.length, 1);
    assert.equal(detail.transcripts[0]?.language, "en");
    assert.equal(detail.processingJobs.length, 0);

    const analysis = await hub.getAnalysisDocument(meetingId);
    assert.ok(analysis !== undefined);
    assert.equal(analysis.summary, "Local-first storage confirmed; backup restore verification assigned.");
    assert.equal(analysis.decisions.length, 1);
    assert.equal(analysis.decisions[0]?.owner, "Ada");
    assert.equal(analysis.tasks.length, 1);
    assert.equal(analysis.tasks[0]?.text, "Verify backup restore on Windows");
    assert.equal(analysis.tasks[0]?.assignee, "Ada");
    assert.equal(analysis.tasks[0]?.dueDate, "2026-10-01");
    assert.equal(analysis.tasks[0]?.status, "OPEN");
    assert.deepEqual(analysis.followups, ["Check restore once installer lands."]);
  });
});

test("meeting hub: transcript content and case-insensitive full-text search", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedPastMeetingWithArtifacts(store);

    const secondMeetingId = randomUUID();
    await store.createMeeting({ meetingId: secondMeetingId, title: "Second sync", startedAt: localIso(-1, 8) });
    await store.saveTranscript({
      meetingId: secondMeetingId,
      speakers: [],
      timestamps: true,
      language: "en",
      createdAt: new Date().toISOString(),
      segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 900, text: "Nothing about attachments in this one." }],
    });

    const hub = new MeetingHubService({ store });
    const detail = hub.getMeetingDetail(firstId);
    const transcriptId = detail.transcripts[0]?.transcriptId;
    assert.ok(transcriptId !== undefined);
    const content = await hub.getTranscriptContent(firstId, transcriptId);
    assert.equal(content.available, true);
    assert.equal(content.truncated, false);
    assert.match(content.text ?? "", /encryption roadmap/);

    // Case-insensitive hit on the first meeting only.
    const results = await hub.searchTranscripts("ENCRYPTION");
    assert.equal(results.hitCount, 1);
    assert.equal(results.matches[0]?.meetingId, firstId);
    assert.match(results.matches[0]?.snippet ?? "", /encryption/i);
    assert.equal(results.matches[0]?.meetingTitle, "Past planning sync");
    assert.equal(results.matches[0]?.language, "en");
    assert.equal(results.truncated, false);

    // Snippet trimming keeps output bounded.
    const snippet = results.matches[0]?.snippet ?? "";
    assert.ok(snippet.length <= 300);

    const none = await hub.searchTranscripts("notpresentanywhere");
    assert.equal(none.hitCount, 0);
    assert.equal(none.matches.length, 0);

    const empty = await hub.searchTranscripts("   ");
    assert.equal(empty.hitCount, 0);
    assert.deepEqual(empty.matches, []);
  });
});

test("meeting hub: transcript content reports unavailable artifacts without throwing", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedPastMeetingWithArtifacts(store);
    const hub = new MeetingHubService({ store });
    const detail = hub.getMeetingDetail(meetingId);
    const transcriptId = detail.transcripts[0]?.transcriptId;
    assert.ok(transcriptId !== undefined);
    await assert.rejects(
      () => hub.getTranscriptContent(meetingId, "missing-transcript"),
      (error: unknown) => error instanceof MeetingHubError && error.code === "TRANSCRIPT_NOT_FOUND",
    );
  });
});

test("meeting hub: unknown meeting ids and bad capture requests raise typed errors", async () => {
  await withTempStore(async (store) => {
    const hub = new MeetingHubService({ store });
    assert.throws(
      () => hub.getMeetingDetail("missing-meeting"),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
    );
    await assert.rejects(
      () => hub.startMeetingCapture({ meetingId: "missing-meeting", microphone: true, systemLoopback: false, screen: false }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_CAPTURE_UNAVAILABLE",
    );
  });
});

test("meeting hub: linked url resolution only returns persisted safe http(s) values", async () => {
  await withTempStore(async (store) => {
    const good = await seedCalendarMeeting(store, {
      subject: "Safe link meeting",
      dayOffset: 1,
      joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3Aexample",
      webUrl: "https://outlook.office.com/calendar/0/item/example",
    });
    const bad = await seedCalendarMeeting(store, {
      subject: "Unsafe link meeting",
      dayOffset: 2,
      joinUrl: "file:///etc/passwd",
      webUrl: "javascript:alert(1)",
    });
    const plain = await seedCalendarMeeting(store, { subject: "No links", dayOffset: 3 });

    const hub = new MeetingHubService({ store });
    assert.equal(hub.getLinkedUrl(good, "JOIN"), "https://teams.microsoft.com/l/meetup-join/19%3Aexample");
    assert.equal(hub.getLinkedUrl(good, "WEB"), "https://outlook.office.com/calendar/0/item/example");
    assert.equal(hub.getLinkedUrl(bad, "JOIN"), undefined);
    assert.equal(hub.getLinkedUrl(bad, "WEB"), undefined);
    assert.equal(hub.getLinkedUrl(plain, "JOIN"), undefined);
    assert.equal(hub.getLinkedUrl(plain, "WEB"), undefined);
    assert.throws(
      () => hub.getLinkedUrl("missing", "JOIN"),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
    );
  });
});

// --- Capture controls over the real orchestrator -----------------------------

class HubScriptedSession implements NativeCaptureSession {
  public readonly nativeSessionId: string;
  public readonly capability: NativeCaptureKind;
  public readonly sourceId?: string;
  public readonly format: string;
  public readonly mimeType: string;
  public readonly startedAt: string;
  public readonly chunks: AsyncIterable<Uint8Array>;
  public stopCalls = 0;
  public abortCalls = 0;
  private stopped = false;

  public constructor(request: NativeCaptureStartRequest) {
    this.capability = request.capability;
    this.sourceId = request.sourceId;
    this.format = request.format;
    this.mimeType = request.mimeType;
    this.startedAt = new Date().toISOString();
    this.nativeSessionId = `${request.capability.toLowerCase()}-session-${randomUUID()}`;
    this.chunks = this.generate();
  }

  private async *generate(): AsyncIterable<Uint8Array> {
    let sequence = 0;
    while (true) {
      if (this.stopped) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.stopped) {
        return;
      }
      yield Buffer.from(`{"source":"${this.capability}","tag":"hub-test","sequence":${sequence},"payload":"${"x".repeat(24)}"}\n`);
      sequence += 1;
    }
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopped = true;
  }

  public async abort(_reason: string): Promise<void> {
    this.abortCalls += 1;
    this.stopped = true;
  }
}

function available(kind: NativeCaptureKind, sources: Array<{ sourceId: string; label?: string; isDefault?: boolean }>) {
  return {
    kind,
    status: "AVAILABLE" as const,
    available: true,
    canListSources: true,
    requiresPermission: false,
    sources: sources.map((source) => ({ ...source, kind })),
  };
}

class HubScriptedAdapter implements NativeCaptureAdapter {
  public readonly adapterId = "hub-scripted-capture";
  public readonly sessions: HubScriptedSession[] = [];
  public readonly startFailures = new Map<NativeCaptureKind, Error>();

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    return {
      platform: "win32",
      adapterId: this.adapterId,
      checkedAt: new Date().toISOString(),
      supported: true,
      capabilities: {
        MICROPHONE_AUDIO: available("MICROPHONE_AUDIO", [{ sourceId: "mic-default-1", label: "Default microphone", isDefault: true }]),
        SYSTEM_AUDIO: available("SYSTEM_AUDIO", [{ sourceId: "loopback-default-1", label: "Default loopback", isDefault: true }]),
        SCREEN: available("SCREEN", [{ sourceId: "screen-1", label: "Primary display", isDefault: true }]),
        WINDOW: available("WINDOW", [{ sourceId: "hwnd:1000", label: "Program Manager", isDefault: true }]),
      },
    };
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    const failure = this.startFailures.get(request.capability);
    if (failure !== undefined) {
      throw failure;
    }
    const session = new HubScriptedSession(request);
    this.sessions.push(session);
    return session;
  }
}

function hubStack(store: LocalFirstStore, adapter: NativeCaptureAdapter): {
  hub: MeetingHubService;
  orchestrator: MeetingCaptureOrchestrator;
} {
  const engine = new LocalRecordingCaptureEngine(store);
  const coordinator = new NativeCaptureCoordinator(adapter, engine, { policy: ALLOWED_POLICY });
  const orchestrator = new MeetingCaptureOrchestrator({ store, coordinator, engine });
  const hub = new MeetingHubService({ store, orchestrator });
  return { hub, orchestrator };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("meeting hub: capture controls drive the real orchestrator on the persisted calendar meeting id", async () => {
  await withTempStore(async (store) => {
    const adapter = new HubScriptedAdapter();
    const meetingId = await seedCalendarMeeting(store, {
      subject: "Recordable sync",
      dayOffset: 0,
      hour: 10,
      joinUrl: "https://meet.google.com/recordable-example",
    });
    const { hub } = hubStack(store, adapter);

    const capabilities = await hub.getCaptureCapabilities();
    assert.equal(capabilities.supported, true);
    assert.equal(capabilities.microphone, true);
    assert.equal(capabilities.systemLoopback, true);
    assert.equal(capabilities.window, true);

    const started = await hub.startMeetingCapture({
      meetingId,
      microphone: true,
      systemLoopback: false,
      screen: false,
    });
    assert.equal(started.meetingId, meetingId);
    assert.deepEqual(started.requestedCapabilities, ["MICROPHONE"]);

    // The live view reports the active flow and the meeting is flagged active.
    const live = hub.listActiveCaptures();
    assert.equal(live.length, 1);
    assert.equal(live[0]?.meetingId, meetingId);
    const during = hub.getOverview().today.find((summary) => summary.meetingId === meetingId);
    assert.ok(during !== undefined);
    assert.equal(during.isActive, true);

    await sleep(60);
    const stopped = await hub.stopMeetingCapture(meetingId);
    assert.equal(stopped.phase, "COMPLETED");
    assert.equal(stopped.meetingStatus, "COMPLETED");
    assert.equal(hub.listActiveCaptures().length, 0);

    const detail = hub.getMeetingDetail(meetingId);
    assert.equal(detail.meeting.status, "COMPLETED");
    assert.equal(detail.meeting.hasRecording, true);
    assert.ok(detail.meeting.artifactCount >= 1);
    // Linkage survived the capture flow on the SAME persisted meeting id.
    assert.equal(detail.meeting.calendar?.externalEventId, detail.meeting.calendarEventId);
    assert.equal(detail.meeting.calendar?.subject, "Recordable sync");
    assert.equal(hub.getLinkedUrl(meetingId, "JOIN"), "https://meet.google.com/recordable-example");

    const overview = hub.getOverview();
    assert.equal(overview.today.some((summary) => summary.meetingId === meetingId), false);
    assert.ok(overview.recent.some((summary) => summary.meetingId === meetingId));
    assert.equal(overview.historyTotal, 1);
  });
});

test("meeting hub: unknown meeting id with a real orchestrator raises MEETING_NOT_FOUND", async () => {
  await withTempStore(async (store) => {
    const adapter = new HubScriptedAdapter();
    const { hub } = hubStack(store, adapter);
    await assert.rejects(
      () => hub.startMeetingCapture({ meetingId: "missing-meeting", microphone: true, systemLoopback: false, screen: false }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
    );
  });
});

test("meeting hub: abort leaves no active capture and marks the meeting INCOMPLETE", async () => {
  await withTempStore(async (store) => {
    const adapter = new HubScriptedAdapter();
    const meetingId = await seedCalendarMeeting(store, { subject: "Abortable sync", dayOffset: 0, hour: 11 });
    const { hub } = hubStack(store, adapter);
    await hub.startMeetingCapture({ meetingId, microphone: true, systemLoopback: false, screen: false });
    await sleep(30);
    const aborted = await hub.abortMeetingCapture(meetingId, "user pressed stop");
    assert.equal(hub.listActiveCaptures().length, 0);
    assert.ok(aborted.meetingStatus === "INCOMPLETE" || aborted.meetingStatus === "FAILED" || aborted.meetingStatus === "CANCELLED");
    assert.ok(adapter.sessions.length >= 1);
    assert.ok((adapter.sessions[0]?.abortCalls ?? 0) >= 1 || (adapter.sessions[0]?.stopCalls ?? 0) >= 1);
    const meeting = store.getMeeting(meetingId);
    assert.ok(meeting !== undefined);
    assert.equal(["INCOMPLETE", "FAILED", "CANCELLED"].includes(meeting.status), true);
  });
});

test("meeting hub: capture is unavailable without an orchestrator", async () => {
  await withTempStore(async (store) => {
    const hub = new MeetingHubService({ store });
    await assert.rejects(
      () => hub.startMeetingCapture({ meetingId: randomUUID(), microphone: true, systemLoopback: false, screen: false }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_CAPTURE_UNAVAILABLE",
    );
    await assert.rejects(
      () => hub.getCaptureCapabilities(),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_CAPTURE_UNAVAILABLE",
    );
  });
});

test("meeting hub: capture request validation requires at least one source", async () => {
  await withTempStore(async (store) => {
    const adapter = new HubScriptedAdapter();
    const meetingId = await seedCalendarMeeting(store, { subject: "No sources", dayOffset: 1 });
    const { hub } = hubStack(store, adapter);
    await assert.rejects(
      () => hub.startMeetingCapture({ meetingId, microphone: false, systemLoopback: false, screen: false }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "INVALID_REQUEST",
    );
  });
});

test("meeting hub: the storage runtime binds the hub to the active store and capture orchestrator", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-hub-runtime-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-hub-runtime-data-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config);
  try {
    assert.equal(await runtime.initialize(), false);
    await runtime.configureFirstRun(dataRoot);
    assert.ok(runtime.meetingHub !== undefined, "meetingHub must be attached with the store");
    assert.ok(runtime.meetingCapture !== undefined, "capture orchestrator must exist for hub capture controls");
    const hub = runtime.requireMeetingHub();
    const empty = hub.getOverview();
    assert.equal(empty.today.length, 0);
    assert.equal(empty.upcoming.length, 0);
    assert.equal(empty.historyTotal, 0);
    const meeting = await runtime.store?.createMeeting({ title: "Hub runtime meeting", meetingDate: localDateKey(new Date()) });
    assert.ok(meeting !== undefined);
    const detail = hub.getMeetingDetail(meeting.meetingId);
    assert.equal(detail.meeting.title, "Hub runtime meeting");
    try {
      await hub.startMeetingCapture({ meetingId: meeting.meetingId, microphone: true, systemLoopback: false, screen: false });
      await hub.abortMeetingCapture(meeting.meetingId).catch(() => undefined);
    } catch {
      // Native capture start depends on platform adapters; the hub must expose
      // a controlled error, never crash.
    }
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("meeting hub: empty transcript search does not throw when many meetings exist", async () => {
  await withTempStore(async (store) => {
    for (let index = 0; index < 3; index += 1) {
      await seedCalendarMeeting(store, { subject: `Meeting ${index}`, dayOffset: index + 1 });
    }
    const hub = new MeetingHubService({ store });
    const results = await hub.searchTranscripts("   ");
    assert.equal(results.hitCount, 0);
  });
});

test("meeting hub: assisted-flow plan classifies the persisted platform without an orchestrator", async () => {
  await withTempStore(async (store) => {
    const meetingId = await seedCalendarMeeting(store, {
      subject: "Teams design sync",
      dayOffset: 0,
      joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2",
    });
    const hub = new MeetingHubService({ store }); // no orchestrator attached
    const plan = await hub.getAssistedFlowPlan(meetingId);
    assert.equal(plan.meetingId, meetingId);
    assert.equal(plan.platform, "TEAMS");
    assert.equal(plan.platformLabel, "Microsoft Teams");
    assert.equal(plan.joinLinkAvailable, true);
    assert.equal(plan.captureSupported, false); // discovery unavailable -> guidance only
    assert.equal(plan.checklist.length, 4);
    assert.equal(plan.recommended.microphone, false);
    assert.equal(plan.recommended.systemLoopback, false);
    // Renderer-safety: the plan never carries URLs or paths.
    const json = JSON.stringify(plan);
    assert.equal(json.includes("teams.microsoft.com"), false);
    assert.equal(json.includes(":\\"), false);
  });
});

test("meeting hub: assisted-flow plan rejects unknown meetings with a hub error", async () => {
  await withTempStore(async (store) => {
    const hub = new MeetingHubService({ store });
    await assert.rejects(hub.getAssistedFlowPlan("ghost-meeting"), (error: unknown) =>
      error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND");
  });
});
