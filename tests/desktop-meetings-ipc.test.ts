import assert from "node:assert/strict";
import { test } from "node:test";

import type { StorageRuntime } from "../src/storage/StorageRuntime";
import type { MeetingHubService } from "../src/meetings/MeetingHubService";
import { MeetingHubError } from "../src/meetings/MeetingHubService";
import { StorageError } from "../src/storage/errors";
import { MEETINGS_IPC_CHANNELS } from "../src/desktop/storage-api";
import { registerMeetingsIpc } from "../src/desktop/meetings-ipc";
import type { HubCaptureSnapshot, HubMeetingSummary, MeetingHubOverview } from "../src/domain/hub";

type IpcHandler = (...args: unknown[]) => unknown;

const AUTHORIZED_EVENT = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
const UNAUTHORIZED_EVENT = { sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

async function invoke(handlers: Map<string, IpcHandler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(...args);
}

function overviewStub(): MeetingHubOverview {
  const meeting: HubMeetingSummary = {
    meetingId: "meeting-1",
    title: "Standup",
    meetingDate: "2026-09-09",
    status: "SCHEDULED",
    createdAt: "2026-09-09T07:00:00.000Z",
    updatedAt: "2026-09-09T07:00:00.000Z",
    isActive: false,
    artifactCount: 0,
    hasRecording: false,
    hasTranscript: false,
    hasAnalysis: false,
  };
  return { serverTime: "2026-09-09T08:00:00.000Z", todayLabel: "Tuesday", today: [meeting], upcoming: [], recent: [], historyTotal: 0 };
}

interface HubStubOptions {
  capture?: {
    startError?: unknown;
    stopError?: unknown;
    startResult?: HubCaptureSnapshot;
  };
  openUrl?: string | undefined;
  analysis?: unknown;
  meetingNotFound?: boolean;
}

function createStubs(options: HubStubOptions = {}): {
  calls: string[];
  runtime: StorageRuntime;
} {
  const calls: string[] = [];
  const meetingId = "meeting-1";
  const hub = {
    getOverview: () => { calls.push("getOverview"); return overviewStub(); },
    getMeetingDetail: (id: string) => { calls.push("getMeetingDetail"); if (options.meetingNotFound === true) throw new MeetingHubError("MEETING_NOT_FOUND", `Meeting not found: ${id}`); return { meeting: overviewStub().today[0] }; },
    getTranscriptContent: async (id: string, transcriptId: string) => { calls.push(`getTranscriptContent:${id}:${transcriptId}`); return { transcriptId, meetingId: id, language: "en", createdAt: "2026-09-09T07:00:00.000Z", available: true, truncated: false, artifactFileId: "artifact-1" }; },
    searchTranscripts: async (query: string, optionsArg?: { limit?: number }) => { calls.push(`searchTranscripts:${query}:${optionsArg?.limit ?? "default"}`); return { query, hitCount: 0, matches: [], truncated: false }; },
    getAnalysisDocument: async (id: string) => { calls.push(`getAnalysis:${id}`); return options.analysis; },
    getCaptureCapabilities: async () => { calls.push("getCaptureCapabilities"); return { supported: true, platform: "win32", adapterId: "test", microphone: true, systemLoopback: true, screen: false, window: false }; },
    startMeetingCapture: async () => { calls.push("startMeetingCapture"); if (options.capture?.startError !== undefined) throw options.capture.startError; return options.capture?.startResult ?? { flowId: "flow-1", meetingId, phase: "RECORDING", meetingStatus: "RECORDING", startedAt: "2026-09-09T08:00:00.000Z", requestedCapabilities: ["MICROPHONE"], startedCapabilities: ["MICROPHONE"], activeSources: ["MICROPHONE"] }; },
    stopMeetingCapture: async () => { calls.push("stopMeetingCapture"); if (options.capture?.stopError !== undefined) throw options.capture.stopError; return { flowId: "flow-1", meetingId, phase: "COMPLETED", meetingStatus: "COMPLETED", startedAt: "2026-09-09T08:00:00.000Z", requestedCapabilities: ["MICROPHONE"], startedCapabilities: ["MICROPHONE"], activeSources: [] }; },
    abortMeetingCapture: async () => { calls.push("abortMeetingCapture"); return { flowId: "flow-1", meetingId, phase: "CANCELLED", meetingStatus: "CANCELLED", startedAt: "2026-09-09T08:00:00.000Z", requestedCapabilities: ["MICROPHONE"], startedCapabilities: ["MICROPHONE"], activeSources: [] }; },
    listActiveCaptures: () => { calls.push("listActiveCaptures"); return []; },
    getLinkedUrl: (id: string, kind: "JOIN" | "WEB") => { calls.push(`getLinkedUrl:${id}:${kind}`); return options.openUrl; },
  } as unknown as MeetingHubService;

  const runtime = {
    requireMeetingHub: () => hub,
    processCompletedMeeting: async (id: string) => { calls.push(`processCompletedMeeting:${id}`); },
  } as unknown as StorageRuntime;

  return { calls, runtime };
}

function register(runtime: StorageRuntime, opened: string[] = []): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerMeetingsIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
    openExternal: async (url: string) => { opened.push(url); },
  });
  return handlers;
}

test("meetings IPC overview reaches the hub only from the authorized renderer", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);
  const result = await invoke(handlers, MEETINGS_IPC_CHANNELS.getOverview, AUTHORIZED_EVENT);
  assert.deepEqual(calls, ["getOverview"]);
  assert.deepEqual((result as MeetingHubOverview).today[0]?.title, "Standup");

  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.getOverview, UNAUTHORIZED_EVENT),
    /unauthorized renderer/,
  );
  assert.deepEqual(calls, ["getOverview"]);
});

test("meetings IPC validates meeting and transcript ids before hub calls", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);

  await invoke(handlers, MEETINGS_IPC_CHANNELS.getDetail, AUTHORIZED_EVENT, "meeting-1");
  assert.deepEqual(calls, ["getMeetingDetail"]);

  for (const bad of [undefined, "", "   ", "x".repeat(200), 42, null]) {
    await assert.rejects(
      invoke(handlers, MEETINGS_IPC_CHANNELS.getDetail, AUTHORIZED_EVENT, bad),
      /invalid/i,
    );
  }
  assert.deepEqual(calls, ["getMeetingDetail"]);

  await invoke(handlers, MEETINGS_IPC_CHANNELS.getTranscriptContent, AUTHORIZED_EVENT, "meeting-1", "transcript-1");
  assert.deepEqual(calls, ["getMeetingDetail", "getTranscriptContent:meeting-1:transcript-1"]);

  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.getTranscriptContent, AUTHORIZED_EVENT, "meeting-1", ""),
    /invalid/i,
  );
  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.getTranscriptContent, AUTHORIZED_EVENT, "", "transcript-1"),
    /invalid/i,
  );
});

test("meetings IPC search and analysis route validated inputs", async () => {
  const { calls, runtime } = createStubs({ analysis: { meetingId: "meeting-1", createdAt: "2026-09-09T00:00:00.000Z", summary: "s", decisions: [], tasks: [], risks: [], questions: [], followups: [] } });
  const handlers = register(runtime);

  const search = await invoke(handlers, MEETINGS_IPC_CHANNELS.searchTranscripts, AUTHORIZED_EVENT, "encryption", 5);
  assert.equal((search as { query: string }).query, "encryption");
  assert.deepEqual(calls, ["searchTranscripts:encryption:5"]);

  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.searchTranscripts, AUTHORIZED_EVENT, "x".repeat(5000), 5),
    /invalid/i,
  );
  assert.deepEqual(calls, ["searchTranscripts:encryption:5"]);

  await invoke(handlers, MEETINGS_IPC_CHANNELS.getAnalysis, AUTHORIZED_EVENT, "meeting-1");
  assert.deepEqual(calls, ["searchTranscripts:encryption:5", "getAnalysis:meeting-1"]);
});

test("meetings IPC capture controls route requests and sanitize hub errors", async () => {
  const meetingId = "meeting-1";
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);

  const caps = await invoke(handlers, MEETINGS_IPC_CHANNELS.getCaptureCapabilities, AUTHORIZED_EVENT);
  assert.equal((caps as { microphone: boolean }).microphone, true);
  assert.deepEqual(calls, ["getCaptureCapabilities"]);

  const started = await invoke(handlers, MEETINGS_IPC_CHANNELS.startCapture, AUTHORIZED_EVENT, {
    meetingId,
    microphone: true,
    systemLoopback: true,
    screen: false,
  }) as HubCaptureSnapshot;
  assert.equal(started.phase, "RECORDING");
  assert.deepEqual(calls, ["getCaptureCapabilities", "startMeetingCapture"]);

  for (const bad of [
    { meetingId, microphone: false, systemLoopback: false, screen: false },
    { meetingId: "", microphone: true, systemLoopback: false, screen: false },
    { meetingId },
    { microphone: true },
    "capture",
  ]) {
    await assert.rejects(
      invoke(handlers, MEETINGS_IPC_CHANNELS.startCapture, AUTHORIZED_EVENT, bad),
      /invalid|requires at least one/i,
    );
  }
  assert.deepEqual(calls, ["getCaptureCapabilities", "startMeetingCapture"]);

  await invoke(handlers, MEETINGS_IPC_CHANNELS.stopCapture, AUTHORIZED_EVENT, meetingId);
  await invoke(handlers, MEETINGS_IPC_CHANNELS.listActiveCaptures, AUTHORIZED_EVENT);
  assert.deepEqual(calls, ["getCaptureCapabilities", "startMeetingCapture", "stopMeetingCapture", "listActiveCaptures"]);
});

test("meetings IPC maps unexpected errors to a generic message and keeps hub codes", async () => {
  const { runtime } = createStubs({
    capture: { startError: new Error("C:\\Users\\ada\\data root paths must never reach the renderer") },
  });
  const handlers = register(runtime);
  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.startCapture, AUTHORIZED_EVENT, {
      meetingId: "meeting-1",
      microphone: true,
      systemLoopback: false,
      screen: false,
    }),
    /could not be completed/,
  );

  const notFound = createStubs({ meetingNotFound: true });
  const notFoundHandlers = register(notFound.runtime);
  await assert.rejects(
    invoke(notFoundHandlers, MEETINGS_IPC_CHANNELS.getDetail, AUTHORIZED_EVENT, "missing"),
    (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
  );
});

test("meetings IPC processMeeting runs the processing pipeline then returns fresh detail", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);
  const result = await invoke(handlers, MEETINGS_IPC_CHANNELS.processMeeting, AUTHORIZED_EVENT, "meeting-1", true);
  assert.deepEqual(calls, ["processCompletedMeeting:meeting-1", "getMeetingDetail"]);
  assert.equal((result as { meeting: { meetingId: string } }).meeting.meetingId, "meeting-1");

  const noApproval = createStubs();
  const handlers2 = register(noApproval.runtime);
  await invoke(handlers2, MEETINGS_IPC_CHANNELS.processMeeting, AUTHORIZED_EVENT, "meeting-1", false);
  assert.deepEqual(noApproval.calls, ["processCompletedMeeting:meeting-1", "getMeetingDetail"]);
});

test("meetings IPC openLinkedUrl opens only persisted safe links resolved by the hub", async () => {
  const opened: string[] = [];
  const { runtime, calls } = createStubs({ openUrl: "https://teams.microsoft.com/l/meetup-join/19%3Aabc" });
  const handlers = register(runtime, opened);

  await invoke(handlers, MEETINGS_IPC_CHANNELS.openLinkedUrl, AUTHORIZED_EVENT, "meeting-1", "JOIN");
  assert.deepEqual(opened, ["https://teams.microsoft.com/l/meetup-join/19%3Aabc"]);
  assert.deepEqual(calls, ["getLinkedUrl:meeting-1:JOIN"]);

  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.openLinkedUrl, AUTHORIZED_EVENT, "meeting-1", "FILE"),
    /invalid/i,
  );
  assert.deepEqual(opened, ["https://teams.microsoft.com/l/meetup-join/19%3Aabc"]);
});

test("meetings IPC refuses to open links that the hub does not consider safe", async () => {
  const opened: string[] = [];
  const { runtime } = createStubs({ openUrl: undefined });
  const handlers = register(runtime, opened);
  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.openLinkedUrl, AUTHORIZED_EVENT, "meeting-1", "WEB"),
    /no safe calendar link/i,
  );
  assert.deepEqual(opened, []);
});

test("meetings IPC storage errors surface with their fixed message and never raw details", async () => {
  const { runtime } = createStubs({
    capture: { stopError: new StorageError("Choose a local data location before using the meeting hub.") },
  });
  const handlers = register(runtime);
  await assert.rejects(
    invoke(handlers, MEETINGS_IPC_CHANNELS.stopCapture, AUTHORIZED_EVENT, "meeting-1"),
    /Choose a local data location/,
  );
});
