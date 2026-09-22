import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { AutomationEngine } from "../src/automation/AutomationEngine";
import { DEFAULT_AUTOMATION_PREFERENCES } from "../src/automation/AutomationPreferences";
import type { HubAutomationPreferences } from "../src/domain/hub";
import { withTempStore } from "./helpers";

function localIso(now: Date, dayOffset: number, hour: number, minute = 0): string {
  const date = new Date(now.getTime());
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

test("detects upcoming calendar meetings without notifying when preparation is off", async () => {
  const now = new Date("2026-09-09T15:00:00");
  await withTempStore(async (store) => {
    const startTime = localIso(now, 0, 15, 10);
    const created = await store.upsertCalendarMeeting({
      provider: "GOOGLE_CALENDAR",
      externalEventId: randomUUID(),
      subject: "Soon standup",
      startTime,
      endTime: localIso(now, 0, 16, 0),
      attendees: [],
      isCancelled: false,
      meetingPlatform: "NONE",
      normalizedFingerprint: randomUUID(),
    });
    const toasts: string[] = [];
    const engine = new AutomationEngine({
      store,
      clock: () => now,
      notifier: { notify: ({ title }) => toasts.push(title) },
      preferences: () => ({ ...DEFAULT_AUTOMATION_PREFERENCES, meetingDetection: true, meetingPreparation: false }),
    });
    const result = await engine.runTick();
    assert.equal(result.detectedMeetings, 1);
    assert.equal(result.createdNotifications, 0);
    assert.equal(toasts.length, 0);
    assert.equal(store.getMeeting(created.meetingId ?? "")?.status, "DETECTED");
  }, { spaceSafetyMarginBytes: 0, clock: () => now });
});

test("preparation, summary, overdue, assigned, daily, and follow-up automations are opt-in and de-duplicated", async () => {
  const now = new Date("2026-09-09T14:50:00");
  await withTempStore(async (store) => {
    const startTime = localIso(now, 0, 15, 0);
    const meetingId = (await store.upsertCalendarMeeting({
      provider: "MICROSOFT_GRAPH",
      externalEventId: randomUUID(),
      subject: "Architecture review",
      startTime,
      endTime: localIso(now, 0, 16, 0),
      attendees: [],
      isCancelled: false,
      meetingPlatform: "TEAMS",
      normalizedFingerprint: randomUUID(),
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3Aabc" },
    })).meetingId;
    assert.ok(meetingId !== undefined);

    const completed = await store.createMeeting({ title: "Yesterday sync", meetingDate: "2026-09-08", startedAt: "2026-09-08T10:00:00.000Z" });
    await store.saveRecording({ meetingId: completed.meetingId, contents: Buffer.from("bytes"), extension: "wav", mimeType: "audio/wav" });
    const transcript = await store.saveTranscript({
      meetingId: completed.meetingId,
      speakers: [],
      timestamps: true,
      language: "en",
      createdAt: "2026-09-08T11:00:00.000Z",
      segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 1000, text: "Keep analysis local." }],
    });
    await store.saveAnalysis({
      meetingId: completed.meetingId,
      createdAt: "2026-09-08T11:05:00.000Z",
      summary: "Keep analysis local.",
      decisions: [],
      tasks: [{ taskId: randomUUID(), text: "Verify restore", assignee: "Ada", dueDate: "2026-09-01", status: "OPEN" }],
      risks: [],
      questions: [],
      followups: ["File the installer notes."],
    }, { sourceTranscriptIds: transcript.json.fileId });

    const prefs: HubAutomationPreferences = {
      ...DEFAULT_AUTOMATION_PREFERENCES,
      meetingDetection: true,
      meetingPreparation: true,
      meetingPreparationMinutes: 15,
      meetingSummaries: true,
      assignedTaskNotifications: true,
      overdueReminders: true,
      dailyMeetingReports: true,
      unresolvedFollowupReminders: true,
    };
    const toasts: string[] = [];
    const engine = new AutomationEngine({
      store,
      clock: () => now,
      notifier: { notify: ({ title }) => toasts.push(title) },
      preferences: () => prefs,
    });
    const first = await engine.runTick();
    assert.equal(first.detectedMeetings, 1);
    assert.equal(first.createdNotifications >= 5, true);
    assert.equal(toasts.length, first.createdNotifications);
    assert.equal(JSON.stringify(engine.listNotifications()).includes("/home"), false);
    assert.equal(JSON.stringify(engine.listNotifications()).includes("token"), false);

    const second = await engine.runTick();
    assert.equal(second.detectedMeetings, 0);
    assert.equal(second.createdNotifications, 0);
    // Detection toasts are not re-attempted after SCHEDULED → DETECTED, so the
    // second tick skips every remaining fingerprint except that one.
    assert.equal(second.skippedDuplicates >= 5, true);

    const unread = engine.listNotifications({ unreadOnly: true });
    const firstItem = unread[0];
    assert.ok(firstItem !== undefined);
    const marked = engine.markNotificationRead(firstItem.notificationId);
    assert.equal(marked?.read, true);
  }, { spaceSafetyMarginBytes: 0, clock: () => now });
});

test("disabled automations produce no notifications even when work exists", async () => {
  const now = new Date("2026-09-09T15:00:00");
  await withTempStore(async (store) => {
    await store.upsertCalendarMeeting({
      provider: "GOOGLE_CALENDAR",
      externalEventId: randomUUID(),
      subject: "Quiet meeting",
      startTime: localIso(now, 0, 15, 5),
      endTime: localIso(now, 0, 16, 0),
      attendees: [],
      isCancelled: false,
      meetingPlatform: "NONE",
      normalizedFingerprint: randomUUID(),
    });
    const engine = new AutomationEngine({
      store,
      clock: () => now,
      preferences: () => ({
        ...DEFAULT_AUTOMATION_PREFERENCES,
        meetingDetection: false,
        meetingPreparation: false,
        meetingSummaries: false,
        assignedTaskNotifications: false,
        overdueReminders: false,
        dailyMeetingReports: false,
        unresolvedFollowupReminders: false,
      }),
    });
    const result = await engine.runTick();
    assert.equal(result.detectedMeetings, 0);
    assert.equal(result.createdNotifications, 0);
    assert.equal(engine.listNotifications().length, 0);
  }, { spaceSafetyMarginBytes: 0, clock: () => now });
});
