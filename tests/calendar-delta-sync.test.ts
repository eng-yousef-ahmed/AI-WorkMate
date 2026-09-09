import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  detectMeetingPlatform,
  withCalendarFingerprint,
  type CalendarDeltaResult,
  type CalendarEventProvider,
  type NormalizedCalendarEvent,
} from "../src";
import { CalendarSyncService } from "../src/calendar/CalendarSyncService";
import { LocalDatabase } from "../src/storage/LocalDatabase";
import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore } from "./helpers";

function calendarEvent(overrides: Partial<NormalizedCalendarEvent> & { externalEventId: string }): NormalizedCalendarEvent {
  return {
    provider: "MICROSOFT_GRAPH",
    subject: "Delta Sync Meeting",
    startTime: "2026-09-10T09:00:00.000Z",
    endTime: "2026-09-10T10:00:00.000Z",
    attendees: [],
    isCancelled: false,
    ...overrides,
  };
}

/** Scriptable delta-capable provider for coordinator tests. */
class ScriptedDeltaProvider implements CalendarEventProvider {
  public fullCalls = 0;
  public deltaCalls: string[] = [];
  /** Each call to getDelta without a cursor shifts the script. */
  public fullScripts: CalendarDeltaResult[] = [];
  /** Cursor → result; null means "not implemented" (throws). */
  public deltaScripts: Map<string, CalendarDeltaResult> = new Map();
  public deltaFailures: Array<{ deltaLink: string; error: Error }> = [];

  public async listEvents(): Promise<NormalizedCalendarEvent[]> {
    throw new Error("listEvents should not be used by the delta path");
  }

  public async getEventById(): Promise<NormalizedCalendarEvent> {
    throw new Error("getEventById is not part of these scenarios");
  }

  public async getDelta(request: { deltaLink?: string; startTime?: string; endTime?: string }): Promise<CalendarDeltaResult> {
    const deltaLink = request.deltaLink?.trim();
    if (deltaLink !== undefined && deltaLink.length > 0) {
      this.deltaCalls.push(deltaLink);
      const failure = this.deltaFailures.find((entry) => entry.deltaLink === deltaLink);
      if (failure !== undefined) {
        throw failure.error;
      }
      const result = this.deltaScripts.get(deltaLink);
      if (result === undefined) {
        throw new Error(`no delta script for ${deltaLink}`);
      }
      return result;
    }
    const script = this.fullScripts.shift();
    if (script === undefined) {
      throw new Error("no full sync script");
    }
    this.fullCalls += 1;
    return script;
  }
}

const RANGE = { startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" };

test("first sync performs a full fetch, stores the cursor and window, and creates meetings", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [
        calendarEvent({ externalEventId: "evt-a", subject: "Design Review" }),
        calendarEvent({ externalEventId: "evt-b", subject: "Sync Standup" }),
      ],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    const result = await service.syncCalendar(RANGE);

    assert.equal(result.mode, "FULL");
    assert.equal(result.createdCount, 2);
    assert.equal(provider.fullCalls, 1);

    const state = store.getCalendarSyncState("MICROSOFT_GRAPH");
    assert.ok(state);
    assert.equal(state.deltaCursor, "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1");
    assert.equal(state.syncWindowStart, RANGE.startTime);
    assert.equal(state.syncWindowEnd, RANGE.endTime);
    assert.equal(state.lastFullSyncAt !== undefined, true);
    assert.equal(store.listMeetings().length, 2);
  });
});

test("a later sync inside the stored window uses the delta cursor and applies changes", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a", subject: "Design Review" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaScripts.set(
      "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
      {
        events: [
          calendarEvent({ externalEventId: "evt-a", subject: "Design Review (moved)", startTime: "2026-09-10T11:00:00.000Z" }),
          calendarEvent({ externalEventId: "evt-c", subject: "New Planning" }),
        ],
        deletions: [],
        nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2",
      },
    );

    const result = await service.syncCalendar(RANGE);
    assert.equal(result.mode, "DELTA");
    assert.equal(result.createdCount, 1);
    assert.equal(result.updatedCount, 1);
    assert.equal(result.unchangedCount, 0);
    assert.equal(result.deltaCursorAdvanced, true);
    assert.deepEqual(provider.deltaCalls, ["https://graph.microsoft.com/v1.0/delta?$deltatoken=D1"]);

    const state = store.getCalendarSyncState("MICROSOFT_GRAPH");
    assert.equal(state?.deltaCursor, "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2");
    assert.equal(state?.lastDeltaSyncAt !== undefined, true);
    assert.equal(store.listMeetings().length, 2);
    // Meeting lifecycle records keep their original title (folders/artifacts
    // are stable); the calendar association carries the updated subject.
    const updated = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "evt-a");
    assert.equal(updated?.subject, "Design Review (moved)");
    assert.equal(updated?.startTime, "2026-09-10T11:00:00.000Z");
  });
});

test("re-delivery of the same delta is idempotent (crash before cursor persistence)", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaScripts.set("https://graph.microsoft.com/v1.0/delta?$deltatoken=D1", {
      events: [calendarEvent({ externalEventId: "evt-a", subject: "Updated Subject" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2",
    });

    const result = await service.syncCalendar(RANGE);
    assert.equal(result.mode, "DELTA");
    assert.equal(result.updatedCount, 1);

    // Simulate a crash AFTER the events were applied but BEFORE the cursor
    // advanced: the stored cursor is still D1, so the next run re-delivers
    // the same delta. Deterministic upserts must make that a no-op.
    store.saveCalendarSyncState("MICROSOFT_GRAPH", { deltaCursor: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1" });
    const replay = await service.syncCalendar(RANGE);
    assert.equal(replay.mode, "DELTA");
    assert.equal(replay.updatedCount, 0);
    assert.equal(replay.unchangedCount, 1);
    assert.equal(replay.errorCount, 0);
    assert.equal(replay.deltaCursorAdvanced, true);
    assert.equal(store.getCalendarSyncState("MICROSOFT_GRAPH")?.deltaCursor, "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2");
    assert.equal(store.listMeetings().length, 1);
  });
});

test("a stale cursor self-heals with a full re-sync of the window", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaFailures.push({
      deltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
      error: Object.assign(new Error("syncStateNotFound: token expired"), {
        name: "MicrosoftGraphError",
        code: "syncStateNotFound",
        status: 410,
        retryable: false,
      }),
    });
    provider.fullScripts.push({
      events: [
        calendarEvent({ externalEventId: "evt-a" }),
        calendarEvent({ externalEventId: "evt-d", subject: "After Recovery" }),
      ],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D9",
    });

    const result = await service.syncCalendar(RANGE);
    assert.equal(result.mode, "DELTA");
    assert.equal(result.staleCursorDetected, true);
    assert.equal(provider.fullCalls, 2); // initial full + self-healing full
    assert.equal(result.createdCount, 1); // evt-d
    assert.equal(result.unchangedCount, 1); // evt-a reapplied deterministically
    const state = store.getCalendarSyncState("MICROSOFT_GRAPH");
    assert.equal(state?.deltaCursor, "https://graph.microsoft.com/v1.0/delta?$deltatoken=D9");
    assert.equal(store.listMeetings().length, 2);
  });
});

test("delta deletions cancel scheduled meetings and count deleted", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [
        calendarEvent({ externalEventId: "evt-keep" }),
        calendarEvent({ externalEventId: "evt-gone" }),
      ],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaScripts.set("https://graph.microsoft.com/v1.0/delta?$deltatoken=D1", {
      events: [],
      deletions: [{ provider: "MICROSOFT_GRAPH", externalEventId: "evt-gone", reason: "deleted" }],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2",
    });

    const result = await service.syncCalendar(RANGE);
    assert.equal(result.deletedCount, 1);
    assert.equal(result.movedOutCount, undefined);

    const meetings = store.listMeetings();
    assert.equal(meetings.length, 2);
    const gone = meetings.find((meeting) => meeting.title === "Delta Sync Meeting" && meeting.calendarEventId === "evt-gone");
    const kept = meetings.find((meeting) => meeting.calendarEventId === "evt-keep");
    assert.ok(gone);
    assert.equal(gone.status, "CANCELLED");
    assert.equal(kept?.status, "SCHEDULED");
    const association = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "evt-gone");
    assert.equal(association?.isCancelled, true);
  });
});

test("completed meetings are never cancelled by calendar deletion; unknown ids are no-ops", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({
      title: "Past Meeting",
      status: "COMPLETED",
      startedAt: "2026-08-01T09:00:00.000Z",
      endedAt: "2026-08-01T10:00:00.000Z",
      calendarEventId: "evt-past",
      metadata: { calendarDiscovery: { provider: "MICROSOFT_GRAPH", externalEventId: "evt-past" } },
    });
    const normalized = withCalendarFingerprint(
      calendarEvent({ externalEventId: "evt-past", subject: "Past Meeting" }),
      detectMeetingPlatform(calendarEvent({ externalEventId: "evt-past" })),
    );
    await store.upsertCalendarMeeting(normalized);

    const outcome = await store.applyCalendarEventDeletion({
      provider: "MICROSOFT_GRAPH",
      externalEventId: "evt-past",
      reason: "deleted",
    });
    assert.deepEqual(outcome, { cancelled: false, existed: true });
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "COMPLETED");

    const unknown = await store.applyCalendarEventDeletion({
      provider: "MICROSOFT_GRAPH",
      externalEventId: "never-seen",
      reason: "deleted",
    });
    assert.deepEqual(unknown, { cancelled: false, existed: false });
  });
});

test("moved-out (changed) deletions never cancel local meetings", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-moved" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaScripts.set("https://graph.microsoft.com/v1.0/delta?$deltatoken=D1", {
      events: [],
      deletions: [{ provider: "MICROSOFT_GRAPH", externalEventId: "evt-moved", reason: "changed" }],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2",
    });
    const result = await service.syncCalendar(RANGE);
    assert.equal(result.movedOutCount, 1);
    const meeting = store.listMeetings().find((entry) => entry.calendarEventId === "evt-moved");
    assert.equal(meeting?.status, "SCHEDULED");
  });
});

test("cancelled events arriving through the delta path cancel scheduled meetings once", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-cancelled" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);

    provider.deltaScripts.set("https://graph.microsoft.com/v1.0/delta?$deltatoken=D1", {
      events: [calendarEvent({ externalEventId: "evt-cancelled", isCancelled: true })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D2",
    });
    const result = await service.syncCalendar(RANGE);
    assert.equal(result.cancelledCount, 1);
    const meeting = store.listMeetings().find((entry) => entry.calendarEventId === "evt-cancelled");
    assert.equal(meeting?.status, "CANCELLED");

    // Re-delivery stays idempotent and never revives the meeting.
    const replay = await service.syncCalendar(RANGE);
    assert.equal(replay.mode, "DELTA");
    assert.equal(store.listMeetings().find((entry) => entry.calendarEventId === "evt-cancelled")?.status, "CANCELLED");
  });
});

test("a request outside the stored window forces a full sync even with a cursor", async () => {
  await withTempStore(async (store) => {
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D1",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);
    assert.equal(provider.deltaCalls.length, 0);

    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=D-wider",
    });
    const wider = { startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-12-01T00:00:00.000Z" };
    const result = await service.syncCalendar(wider);
    assert.equal(result.mode, "FULL");
    assert.equal(provider.fullCalls, 2);
    assert.equal(provider.deltaCalls.length, 0);
    const state = store.getCalendarSyncState("MICROSOFT_GRAPH");
    assert.equal(state?.syncWindowEnd, wider.endTime);
  });
});

test("sync state survives a store reopen (cursor persistence)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-sync-state-"));
  try {
    const store = new LocalFirstStore(root);
    await store.initialize();
    const provider = new ScriptedDeltaProvider();
    provider.fullScripts.push({
      events: [calendarEvent({ externalEventId: "evt-a" })],
      deletions: [],
      nextDeltaLink: "https://graph.microsoft.com/v1.0/delta?$deltatoken=persist-me",
    });
    const service = new CalendarSyncService(provider, store, "MICROSOFT_GRAPH");
    await service.syncCalendar(RANGE);
    store.close();

    const reopened = new LocalFirstStore(root);
    await reopened.initialize();
    const state = reopened.getCalendarSyncState("MICROSOFT_GRAPH");
    assert.equal(state?.deltaCursor, "https://graph.microsoft.com/v1.0/delta?$deltatoken=persist-me");
    assert.equal(state?.syncWindowStart, RANGE.startTime);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v8 migration widens the provider CHECK and preserves associations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-migration-"));
  try {
    const seed = new LocalFirstStore(root);
    await seed.initialize();
    const meeting = await seed.createMeeting({
      title: "Migration Meeting",
      meetingDate: "2026-09-09",
      calendarEventId: "evt-migrate",
    });
    const normalized = withCalendarFingerprint(
      calendarEvent({ externalEventId: "evt-migrate", subject: "Migration Meeting" }),
      detectMeetingPlatform(calendarEvent({ externalEventId: "evt-migrate" })),
    );
    await seed.upsertCalendarMeeting(normalized);
    seed.close();

    // Downgrade the database to the v7 shape: old provider CHECK, version 7.
    const databasePath = join(root, "Database", "ai-workmate.sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE calendar_event_associations RENAME TO calendar_event_associations_v8;
      CREATE TABLE calendar_event_associations (
        provider TEXT NOT NULL CHECK (provider IN ('MICROSOFT_GRAPH')),
        external_event_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        organizer_json TEXT,
        attendees_json TEXT NOT NULL DEFAULT '[]',
        location TEXT,
        online_meeting_json TEXT,
        web_url TEXT,
        is_cancelled INTEGER NOT NULL CHECK (is_cancelled IN (0, 1)),
        last_modified_at TEXT,
        meeting_platform TEXT NOT NULL CHECK (meeting_platform IN ('TEAMS', 'OTHER_ONLINE', 'NONE')),
        normalized_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, external_event_id)
      );
      INSERT INTO calendar_event_associations SELECT provider, external_event_id, meeting_id, subject,
        start_time, end_time, organizer_json, attendees_json, location, online_meeting_json, web_url,
        is_cancelled, last_modified_at, meeting_platform, normalized_fingerprint, created_at, updated_at
        FROM calendar_event_associations_v8;
      DROP TABLE calendar_event_associations_v8;
      CREATE INDEX IF NOT EXISTS calendar_event_associations_meeting_index ON calendar_event_associations(meeting_id);
      CREATE INDEX IF NOT EXISTS calendar_event_associations_start_index ON calendar_event_associations(start_time);
      CREATE INDEX IF NOT EXISTS calendar_event_associations_platform_index ON calendar_event_associations(meeting_platform);
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-09-09T00:00:00.000Z');
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    raw.close();

    // Reopening migrates v7 → v8 automatically.
    const migrated = new LocalDatabase(databasePath);
    const association = migrated.getCalendarEventAssociation("MICROSOFT_GRAPH", "evt-migrate");
    assert.ok(association);
    assert.equal(association.meetingId, meeting.meetingId);
    assert.equal(association.subject, "Migration Meeting");
    migrated.close();

    const verify = new DatabaseSync(databasePath);
    const ddlRow = verify
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'calendar_event_associations'")
      .get() as { sql: string };
    assert.match(ddlRow.sql, /MICROSOFT_GRAPH', 'GOOGLE_CALENDAR/);
    const version = verify.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    assert.equal(version.version, 8);
    verify.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy v8 association rows survive an interrupted-migration rerun (idempotent)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-migration-idem-"));
  try {
    const store = new LocalFirstStore(root);
    await store.initialize();
    await store.createMeeting({ title: "Idempotent", meetingDate: "2026-09-09", calendarEventId: "evt-idem" });
    const normalized = withCalendarFingerprint(
      calendarEvent({ externalEventId: "evt-idem", subject: "Idempotent" }),
      detectMeetingPlatform(calendarEvent({ externalEventId: "evt-idem" })),
    );
    await store.upsertCalendarMeeting(normalized);
    store.close();

    // First migration run (as if v7 was present).
    const databasePath = join(root, "Database", "ai-workmate.sqlite");
    const downgrade = new DatabaseSync(databasePath);
    downgrade.exec("DELETE FROM schema_migrations; INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-09-09T00:00:00.000Z');");
    downgrade.close();
    const first = new LocalDatabase(databasePath);
    first.close();

    // Second open must not duplicate or drop anything.
    const second = new LocalDatabase(databasePath);
    const association = second.getCalendarEventAssociation("MICROSOFT_GRAPH", "evt-idem");
    assert.ok(association);
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
