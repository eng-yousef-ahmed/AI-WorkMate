import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CalendarSyncService,
  DuplicateMeetingError,
  detectMeetingPlatform,
  withCalendarFingerprint,
  type CalendarEventProvider,
  type NormalizedCalendarEvent,
} from "../src";
import { withTempStore } from "./helpers";

class MutableCalendarProvider implements CalendarEventProvider {
  public constructor(public events: NormalizedCalendarEvent[]) {}

  public async listEvents(): Promise<NormalizedCalendarEvent[]> {
    return this.events;
  }

  public async getEventById(): Promise<NormalizedCalendarEvent> {
    const event = this.events[0];
    if (event === undefined) {
      throw new Error("missing event");
    }
    return event;
  }
}

test("creates scheduled local meetings and Teams associations from discovered Graph events", async () => {
  await withTempStore(async (store) => {
    const provider = new MutableCalendarProvider([
      calendarEvent({
        externalEventId: "teams-event-1",
        subject: "Teams Standup",
        onlineMeeting: { provider: "teamsForBusiness", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      }),
    ]);
    const result = await new CalendarSyncService(provider, store).syncRange(syncRange());

    assert.equal(result.createdCount, 1);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.unchangedCount, 0);
    const meetings = store.listMeetings();
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.status, "SCHEDULED");
    assert.equal(meetings[0]?.calendarEventId, "teams-event-1");
    const association = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "teams-event-1");
    assert.equal(association?.meetingId, meetings[0]?.meetingId);
    assert.equal(association?.meetingPlatform, "TEAMS");
    assert.equal(association?.onlineMeeting?.joinUrl, "https://teams.microsoft.com/l/meetup-join/abc");
  });
});

test("repeated calendar synchronization is idempotent and does not duplicate meetings", async () => {
  await withTempStore(async (store) => {
    const event = calendarEvent({ externalEventId: "idempotent-event", subject: "Weekly Sync" });
    const provider = new MutableCalendarProvider([event, event]);
    const service = new CalendarSyncService(provider, store);

    const first = await service.syncRange(syncRange());
    const second = await service.syncRange(syncRange());

    assert.equal(first.createdCount, 1);
    assert.equal(first.unchangedCount, 1);
    assert.equal(second.createdCount, 0);
    assert.equal(second.updatedCount, 0);
    assert.equal(second.unchangedCount, 2);
    assert.equal(store.listMeetings().length, 1);
    assert.equal(store.database.listCalendarEventAssociations().length, 1);
  });
});

test("updates normalized event metadata while preserving recordings transcripts and analysis", async () => {
  await withTempStore(async (store) => {
    const provider = new MutableCalendarProvider([calendarEvent({ externalEventId: "update-event", subject: "Original title" })]);
    const service = new CalendarSyncService(provider, store);
    await service.syncRange(syncRange());
    const meeting = store.listMeetings()[0];
    assert.ok(meeting);
    await store.saveAudio(meeting.meetingId, { extension: "m4a", mimeType: "audio/mp4", contents: "audio bytes" });
    await store.ingestTranscript({
      meetingId: meeting.meetingId,
      format: "PLAIN_TEXT",
      content: "Transcript remains local.",
      language: "en-US",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    await store.saveAnalysis({
      meetingId: meeting.meetingId,
      createdAt: "2026-09-01T12:10:00.000Z",
      summary: "Existing analysis remains.",
      decisions: [],
      tasks: [],
      risks: [],
      questions: [],
      followups: [],
    });

    provider.events = [calendarEvent({
      externalEventId: "update-event",
      subject: "Updated title",
      lastModifiedAt: "2026-09-01T13:00:00.000Z",
    })];
    const result = await service.syncRange(syncRange());

    assert.equal(result.updatedCount, 1);
    assert.equal(store.listMeetings().length, 1);
    assert.equal(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "update-event")?.subject, "Updated title");
    assert.equal(store.database.listArtifacts(meeting.meetingId).some((artifact) => artifact.artifactType === "AUDIO"), true);
    assert.equal(store.database.listTranscripts(meeting.meetingId).length, 1);
    assert.equal(store.database.listAnalysis(meeting.meetingId).length, 7);
  });
});

test("cancelled events are safe and do not imply recording lifecycle transitions", async () => {
  await withTempStore(async (store) => {
    const skippedProvider = new MutableCalendarProvider([calendarEvent({ externalEventId: "cancelled-new", isCancelled: true })]);
    const skipped = await new CalendarSyncService(skippedProvider, store).syncRange(syncRange());
    assert.equal(skipped.cancelledCount, 1);
    assert.equal(skipped.createdCount, 0);
    assert.equal(store.listMeetings().length, 0);

    const provider = new MutableCalendarProvider([calendarEvent({ externalEventId: "cancelled-existing" })]);
    const service = new CalendarSyncService(provider, store);
    await service.syncRange(syncRange());
    const meeting = store.listMeetings()[0];
    assert.ok(meeting);
    store.database.updateMeetingStatus(meeting.meetingId, "DETECTED");
    store.database.updateMeetingStatus(meeting.meetingId, "PREPARING");
    store.database.updateMeetingStatus(meeting.meetingId, "RECORDING");

    provider.events = [calendarEvent({ externalEventId: "cancelled-existing", isCancelled: true })];
    const cancelled = await service.syncRange(syncRange());

    assert.equal(cancelled.cancelledCount, 1);
    assert.equal(cancelled.updatedCount, 1);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "RECORDING");
    assert.equal(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "cancelled-existing")?.isCancelled, true);
  });
});

test("calendar sync preserves progressed lifecycle state and never resets it backwards", async () => {
  await withTempStore(async (store) => {
    const provider = new MutableCalendarProvider([calendarEvent({ externalEventId: "progressed-event" })]);
    const service = new CalendarSyncService(provider, store);
    await service.syncRange(syncRange());
    const meeting = store.listMeetings()[0];
    assert.ok(meeting);
    store.database.updateMeetingStatus(meeting.meetingId, "DETECTED");
    store.database.updateMeetingStatus(meeting.meetingId, "PREPARING");

    const result = await service.syncRange(syncRange());

    assert.equal(result.unchangedCount, 1);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PREPARING");
  });
});

test("external Microsoft event IDs remain unique while internal meeting UUIDs stay authoritative", async () => {
  await withTempStore(async (store) => {
    const normalized = withCalendarFingerprint(
      calendarEvent({ externalEventId: "unique-external-event", subject: "Unique external" }),
      "NONE",
    );
    const created = await store.upsertCalendarMeeting(normalized);
    assert.equal(created.action, "CREATED");
    const firstMeeting = store.getMeeting(created.meetingId ?? "");
    assert.ok(firstMeeting);
    const secondMeeting = await store.createMeeting({ title: "Other local meeting", meetingDate: "2026-09-01" });
    const existingAssociation = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "unique-external-event");
    assert.ok(existingAssociation);

    await assert.rejects(
      Promise.resolve().then(() => store.database.upsertCalendarEventAssociation({
        ...existingAssociation,
        meetingId: secondMeeting.meetingId,
        updatedAt: "2026-09-01T12:00:00.000Z",
      })),
      DuplicateMeetingError,
    );
    assert.notEqual(firstMeeting.meetingId, "unique-external-event");
    assert.equal(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "unique-external-event")?.meetingId, firstMeeting.meetingId);
  });
});

test("meeting ownership stays isolated for multiple Graph events with the same title", async () => {
  await withTempStore(async (store) => {
    const provider = new MutableCalendarProvider([
      calendarEvent({ externalEventId: "same-title-1", subject: "Recurring planning", startTime: "2026-09-01T10:00:00.000Z" }),
      calendarEvent({ externalEventId: "same-title-2", subject: "Recurring planning", startTime: "2026-09-02T10:00:00.000Z" }),
    ]);
    const result = await new CalendarSyncService(provider, store).syncRange({
      startTime: "2026-09-01T00:00:00.000Z",
      endTime: "2026-09-03T00:00:00.000Z",
    });

    assert.equal(result.createdCount, 2);
    const meetings = store.listMeetings();
    const ids = new Set(meetings.map((meeting) => meeting.meetingId));
    assert.equal(ids.size, 2);
    assert.notEqual(meetings[0]?.meetingId, "same-title-1");
    assert.equal(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "same-title-1")?.meetingId !== store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "same-title-2")?.meetingId, true);
  });
});

function syncRange(): { startTime: string; endTime: string } {
  return {
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z",
  };
}

function calendarEvent(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  const event: NormalizedCalendarEvent = {
    provider: "MICROSOFT_GRAPH",
    externalEventId: "graph-event-1",
    subject: "Planning",
    startTime: "2026-09-01T10:00:00.000Z",
    endTime: "2026-09-01T11:00:00.000Z",
    attendees: [],
    isCancelled: false,
    ...overrides,
  };
  event.meetingPlatform = detectMeetingPlatform(event);
  return event;
}
