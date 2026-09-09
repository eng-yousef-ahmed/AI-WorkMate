import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { classifyOnlinePlatform, MeetingAssistService } from "../src/meetings/MeetingAssistService";
import type { HubCaptureCapabilities } from "../src/domain/hub";
import type { CalendarEventAssociation } from "../src/domain/models";

const FIXED = new Date("2026-09-09T08:00:00.000Z");

function capabilities(overrides: Partial<HubCaptureCapabilities> = {}): HubCaptureCapabilities {
  return {
    supported: true,
    platform: "win32",
    adapterId: "windows-test",
    microphone: true,
    systemLoopback: true,
    screen: true,
    window: true,
    ...overrides,
  };
}

function association(overrides: Partial<CalendarEventAssociation> = {}): CalendarEventAssociation {
  return {
    provider: "GOOGLE_CALENDAR",
    externalEventId: "external-1",
    meetingId: "meeting-1",
    subject: "Design review",
    startTime: "2026-09-09T09:00:00.000Z",
    endTime: "2026-09-09T10:00:00.000Z",
    attendees: [],
    isCancelled: false,
    meetingPlatform: "OTHER_ONLINE",
    normalizedFingerprint: "design-review",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

async function withStore(
  run: (store: LocalFirstStore, meetingId: string) => Promise<void>,
  meetingOverrides: Partial<CalendarEventAssociation> = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-assist-"));
  const store = new LocalFirstStore(root, { clock: () => FIXED });
  try {
    await store.initialize();
    const meeting = await store.createMeeting({ title: "Design review", meetingDate: "2026-09-09" });
    store.database.upsertCalendarEventAssociation(association({ ...meetingOverrides, meetingId: meeting.meetingId }));
    await run(store, meeting.meetingId);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("assist: classifies Teams/Zoom/Google Meet/other from persisted URLs only", () => {
  assert.equal(classifyOnlinePlatform("https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2"), "TEAMS");
  assert.equal(classifyOnlinePlatform("https://gov.teams.microsoft.us/meeting"), "TEAMS");
  assert.equal(classifyOnlinePlatform("https://meet.teams.live.com/x"), "TEAMS");
  assert.equal(classifyOnlinePlatform("https://us02web.zoom.us/j/123456789?pwd=abc"), "ZOOM");
  assert.equal(classifyOnlinePlatform("https://zoom.com/j/42"), "ZOOM");
  assert.equal(classifyOnlinePlatform("https://cfa.zoomgov.com/j/7"), "ZOOM");
  assert.equal(classifyOnlinePlatform("https://meet.google.com/abc-defg-hij"), "GOOGLE_MEET");
  assert.equal(classifyOnlinePlatform("https://calendar.google.com/calendar/event?eid=x"), "OTHER_ONLINE");
  assert.equal(classifyOnlinePlatform("https://company.webex.com/meet/ada"), "OTHER_ONLINE");
  assert.equal(classifyOnlinePlatform("https://whereby.com/room"), "OTHER_ONLINE");
  assert.equal(classifyOnlinePlatform(undefined, "https://teams.microsoft.com/l/join"), "TEAMS");
  assert.equal(classifyOnlinePlatform("not a url"), "NONE");
  assert.equal(classifyOnlinePlatform(""), "NONE");
  assert.equal(classifyOnlinePlatform(undefined, undefined), "NONE");
  // The join link is the primary signal and is examined first.
  assert.equal(classifyOnlinePlatform("https://zoom.us/j/1", "https://teams.microsoft.com/l/join"), "ZOOM");
  assert.equal(classifyOnlinePlatform("https://teams.microsoft.com/l/join", "https://zoom.us/j/1"), "TEAMS");
});

test("assist: full remote capability plan records window + system audio and explains choices", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities());
    assert.equal(plan.platform, "ZOOM");
    assert.equal(plan.platformLabel, "Zoom");
    assert.equal(plan.meetingId, meetingId);
    assert.equal(plan.captureSupported, true);
    assert.equal(plan.joinLinkAvailable, true);
    assert.deepEqual(plan.recommended, { meetingId, microphone: false, systemLoopback: true, screen: false, window: "" });
    assert.ok(plan.rationale.some((line) => line.includes("meeting window")));
    assert.ok(plan.rationale.some((line) => line.includes("microphone only if you speak")));
    assert.equal(plan.checklist.length, 4);
    assert.equal(plan.checklist[0]!.id, "join");
    assert.ok(plan.checklist[0]!.note!.includes("browser"));
    assert.ok(plan.checklist[2]!.note!.includes("stays on this device"));
    // Renderer-safe: no URLs, paths, or window source ids leak into the plan.
    const json = JSON.stringify(plan);
    assert.equal(json.includes("https://"), false, `url leaked: ${json}`);
    assert.equal(json.includes(":\\"), false, `path leaked: ${json}`);
    assert.equal(json.includes("zoom.us"), false, `url leaked: ${json}`);
  }, { onlineMeeting: { joinUrl: "https://us02web.zoom.us/j/123456789?pwd=abc" }, webUrl: "https://zoom.us/rec/play/x" });
});

test("assist: teams meeting prefers deterministic window capture over screen", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities({ screen: false }));
    assert.equal(plan.platform, "TEAMS");
    assert.equal(plan.recommended.window, "");
    assert.equal(plan.recommended.screen, false);
    assert.ok(plan.rationale.some((line) => line.includes("window")));
  }, { onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" }, meetingPlatform: "TEAMS" });
});

test("assist: without window, screen capture is recommended for shared content", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities({ window: false }));
    assert.equal(plan.recommended.screen, true);
    assert.equal(plan.recommended.window, undefined);
    assert.ok(plan.rationale.some((line) => line.includes("screen")));
  }, { onlineMeeting: { joinUrl: "https://meet.google.com/abc-defg-hij" } });
});

test("assist: audio-only fallback with microphone when system audio is unavailable", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities({ systemLoopback: false, screen: false, window: false }));
    assert.equal(plan.recommended.systemLoopback, false);
    assert.equal(plan.recommended.microphone, true);
    assert.equal(plan.recommended.screen, false);
    assert.ok(plan.rationale.some((line) => line.includes("microphone")));
    assert.ok(plan.rationale.some((line) => line.includes("not available")));
  }, { onlineMeeting: { joinUrl: "https://company.webex.com/meet/ada" } });
});

test("assist: no shared-content capture available is stated instead of guessed", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities({ window: false, screen: false }));
    assert.equal(plan.recommended.screen, false);
    assert.equal(plan.recommended.window, undefined);
    assert.ok(plan.rationale.some((line) => line.includes("will not be recorded")));
  }, { onlineMeeting: { joinUrl: "https://us02web.zoom.us/j/1" } });
});

test("assist: unsupported capture yields a join-and-note plan without sources", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities({ supported: false }));
    assert.equal(plan.captureSupported, false);
    assert.deepEqual(plan.recommended, { meetingId, microphone: false, systemLoopback: false, screen: false });
    assert.ok(plan.rationale.some((line) => line.includes("not available")));
    assert.ok(plan.checklist.some((item) => item.note?.includes("join as usual")));
    const json = JSON.stringify(plan);
    assert.equal(json.includes("https://"), false);
  }, { onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" } });
});

test("assist: no stored link classifies as in person and plans microphone room audio", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, capabilities());
    assert.equal(plan.platform, "NONE");
    assert.equal(plan.platformLabel, "In person / no online link");
    assert.equal(plan.joinLinkAvailable, false);
    assert.equal(plan.captureSupported, true);
    assert.equal(plan.recommended.microphone, true);
    assert.equal(plan.recommended.systemLoopback, false);
    assert.equal(plan.recommended.screen, false);
    assert.ok(plan.rationale.some((line) => line.includes("room audio")));
    assert.ok(plan.checklist[0]!.note!.includes("in person"));
  });
});

test("assist: meetings without any usable source are honest about it", async () => {
  await withStore(async (store, meetingId) => {
    const plan = new MeetingAssistService({ store }).plan(meetingId, {
      supported: true,
      microphone: false,
      systemLoopback: false,
      screen: false,
      window: false,
    });
    assert.equal(plan.captureSupported, false);
    assert.deepEqual(plan.recommended, { meetingId, microphone: false, systemLoopback: false, screen: false });
    assert.ok(plan.rationale.some((line) => line.includes("not available")));
  }, { onlineMeeting: { joinUrl: "https://whereby.com/room" } });
});

test("assist: hub capability provider errors degrade to a non-capture plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-assist-"));
  const store = new LocalFirstStore(root, { clock: () => FIXED });
  await store.initialize();
  try {
    const meeting = await store.createMeeting({ title: "Design review", meetingDate: "2026-09-09" });
    const plan = new MeetingAssistService({ store }).plan(meeting.meetingId, {
      supported: false,
      microphone: false,
      systemLoopback: false,
      screen: false,
      window: false,
    });
    assert.equal(plan.captureSupported, false);
    assert.equal(plan.meetingTitle, "Design review");
    assert.equal(plan.meetingDate, "2026-09-09");
    assert.equal(plan.checklist.length, 4);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
