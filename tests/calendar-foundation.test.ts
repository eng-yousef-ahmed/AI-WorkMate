import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { join } from "node:path";

import {
  CalendarSyncService,
  calendarEventAssociationId,
  deduplicateCalendarAttendees,
  toRendererCalendarSyncResult,
  type CalendarEventProvider,
  type CalendarProvider,
  type NormalizedCalendarEvent,
} from "../src";
import { DATABASE_SCHEMA_VERSION } from "../src/domain/models";
import { LocalDatabase } from "../src/storage/LocalDatabase";
import { temporaryDirectory, withTempStore } from "./helpers";

class FoundationCalendarProvider implements CalendarEventProvider {
  public readonly providerId: CalendarProvider | undefined;
  public readonly accountId: string | undefined;

  public constructor(
    public events: NormalizedCalendarEvent[],
    identity: { providerId?: CalendarProvider; accountId?: string } = {},
  ) {
    this.providerId = identity.providerId;
    this.accountId = identity.accountId;
  }

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

test("computes stable internal event IDs from provider, account, and external ID", () => {
  const first = calendarEventAssociationId("MICROSOFT_GRAPH", "ada@example.com", "event-1");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, calendarEventAssociationId("MICROSOFT_GRAPH", "ada@example.com", "event-1"));
  assert.notEqual(first, calendarEventAssociationId("MICROSOFT_GRAPH", "grace@example.com", "event-1"));
  assert.notEqual(first, calendarEventAssociationId("MICROSOFT_GRAPH", "ada@example.com", "event-2"));
  assert.notEqual(first, calendarEventAssociationId("GOOGLE_CALENDAR", "ada@example.com", "event-1"));
});

test("retains the stable internal event ID across sync updates", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider([
      foundationEvent({ externalEventId: "stable-1", accountId: "ada@example.com", subject: "Original" }),
    ]);
    const service = new CalendarSyncService(provider, store);
    const first = await service.syncRange(syncRange());
    assert.equal(first.createdCount, 1);
    const created = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "stable-1", "ada@example.com");
    assert.ok(created);

    provider.events = [
      foundationEvent({ externalEventId: "stable-1", accountId: "ada@example.com", subject: "Renamed" }),
    ];
    const second = await service.syncRange(syncRange());
    assert.equal(second.updatedCount, 1);
    const updated = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "stable-1", "ada@example.com");
    assert.equal(updated?.associationId, created.associationId);
    assert.equal(updated?.subject, "Renamed");
    assert.equal(updated?.associationId, calendarEventAssociationId("MICROSOFT_GRAPH", "ada@example.com", "stable-1"));
    assert.equal(store.listMeetings().length, 1);
  });
});

test("scopes sync identity by account so the same external ID never collides", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider([
      foundationEvent({ externalEventId: "shared-1", accountId: "ada@example.com", subject: "Ada planning" }),
      foundationEvent({ externalEventId: "shared-1", accountId: "grace@example.com", subject: "Grace planning" }),
    ]);
    const result = await new CalendarSyncService(provider, store).syncRange(syncRange());

    assert.equal(result.createdCount, 2);
    assert.equal(store.listMeetings().length, 2);
    const ada = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "shared-1", "ada@example.com");
    const grace = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "shared-1", "grace@example.com");
    assert.ok(ada);
    assert.ok(grace);
    assert.notEqual(ada.associationId, grace.associationId);
    assert.notEqual(ada.meetingId, grace.meetingId);
    assert.equal(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "shared-1"), undefined);
  });
});

test("links repeat syncs to the existing meeting without duplicates", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider([
      foundationEvent({ externalEventId: "repeat-1", accountId: "ada@example.com" }),
    ]);
    const service = new CalendarSyncService(provider, store);

    assert.equal((await service.syncRange(syncRange())).createdCount, 1);
    const second = await service.syncRange(syncRange());
    assert.equal(second.unchangedCount, 1);
    assert.equal(second.createdCount, 0);
    assert.equal(store.listMeetings().length, 1);
    assert.equal(store.database.listCalendarEventAssociations().length, 1);
  });
});

test("uses provider-declared identity when events omit it", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider(
      [foundationEvent({ externalEventId: "declared-1", subject: "Stamped" })],
      { providerId: "GOOGLE_CALENDAR", accountId: "ada@example.com" },
    );
    const result = await new CalendarSyncService(provider, store).syncRange(syncRange());

    assert.equal(result.provider, "GOOGLE_CALENDAR");
    assert.equal(result.createdCount, 1);
    const association = store.database.getCalendarEventAssociation("GOOGLE_CALENDAR", "declared-1", "ada@example.com");
    assert.equal(association?.provider, "GOOGLE_CALENDAR");
    assert.equal(association?.accountId, "ada@example.com");
    assert.equal(store.listMeetings()[0]?.calendarEventId, "GOOGLE_CALENDAR:ada@example.com:declared-1");
  });
});

test("deduplicates calendar attendees deterministically", () => {
  const deduplicated = deduplicateCalendarAttendees([
    { displayName: "Ada", email: "ADA@example.com" },
    { displayName: "ada duplicate", email: "ada@EXAMPLE.com" },
    { displayName: "Name Only" },
    { displayName: "Name Only" },
    { email: "solo@example.com" },
  ]);
  assert.deepEqual(deduplicated, [
    { displayName: "Ada", email: "ADA@example.com" },
    { displayName: "Name Only" },
    { email: "solo@example.com" },
  ]);
});

test("removes duplicate attendees during sync so repeats are unchanged", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider([
      foundationEvent({
        externalEventId: "attendees-1",
        attendees: [
          { displayName: "Ada", email: "ADA@example.com" },
          { displayName: "ada duplicate", email: "ada@example.com" },
        ],
      }),
    ]);
    const service = new CalendarSyncService(provider, store);

    assert.equal((await service.syncRange(syncRange())).createdCount, 1);
    assert.deepEqual(store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "attendees-1")?.attendees, [
      { displayName: "Ada", email: "ADA@example.com" },
    ]);
    const second = await service.syncRange(syncRange());
    assert.equal(second.unchangedCount, 1);
    assert.equal(store.listMeetings().length, 1);
  });
});

test("correlates a synced event to an existing meeting by join URL and overlapping time", async () => {
  await withTempStore(async (store) => {
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/correlated";
    await new CalendarSyncService(new FoundationCalendarProvider([
      foundationEvent({
        externalEventId: "source-event",
        accountId: "ada@example.com",
        subject: "Weekly sync",
        startTime: "2026-09-01T10:00:00.000Z",
        endTime: "2026-09-01T11:00:00.000Z",
        onlineMeeting: { provider: "teamsForBusiness", joinUrl },
      }),
    ]), store).syncRange(syncRange());
    const existing = store.listMeetings()[0];
    assert.ok(existing);

    const result = await new CalendarSyncService(new FoundationCalendarProvider([
      foundationEvent({
        externalEventId: "other-external-id",
        accountId: "grace@example.com",
        subject: "Weekly sync (other calendar)",
        startTime: "2026-09-01T10:30:00.000Z",
        endTime: "2026-09-01T11:30:00.000Z",
        onlineMeeting: { provider: "teamsForBusiness", joinUrl },
      }),
    ]), store).syncRange(syncRange());

    assert.equal(result.updatedCount, 1);
    assert.equal(result.createdCount, 0);
    assert.equal(store.listMeetings().length, 1);
    const linked = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "other-external-id", "grace@example.com");
    assert.equal(linked?.meetingId, existing.meetingId);
  });
});

test("does not correlate meetings that share only a join URL outside the time window", async () => {
  await withTempStore(async (store) => {
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/recurring";
    await new CalendarSyncService(new FoundationCalendarProvider([
      foundationEvent({
        externalEventId: "recurring-a",
        startTime: "2026-09-01T10:00:00.000Z",
        endTime: "2026-09-01T11:00:00.000Z",
        onlineMeeting: { provider: "teamsForBusiness", joinUrl },
      }),
    ]), store).syncRange(syncRange());

    const result = await new CalendarSyncService(new FoundationCalendarProvider([
      foundationEvent({
        externalEventId: "recurring-b",
        accountId: "grace@example.com",
        startTime: "2026-09-01T12:00:00.000Z",
        endTime: "2026-09-01T13:00:00.000Z",
        onlineMeeting: { provider: "teamsForBusiness", joinUrl },
      }),
    ]), store).syncRange(syncRange());

    assert.equal(result.createdCount, 1);
    assert.equal(store.listMeetings().length, 2);
  });
});

test("marks synced events cancelled while retaining the stable internal ID", async () => {
  await withTempStore(async (store) => {
    const provider = new FoundationCalendarProvider([
      foundationEvent({ externalEventId: "cancel-1", accountId: "ada@example.com" }),
    ]);
    const service = new CalendarSyncService(provider, store);
    assert.equal((await service.syncRange(syncRange())).createdCount, 1);
    const created = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "cancel-1", "ada@example.com");
    assert.ok(created);

    provider.events = [
      foundationEvent({ externalEventId: "cancel-1", accountId: "ada@example.com", isCancelled: true }),
    ];
    const second = await service.syncRange(syncRange());
    assert.equal(second.cancelledCount, 1);
    const cancelled = store.database.getCalendarEventAssociation("MICROSOFT_GRAPH", "cancel-1", "ada@example.com");
    assert.equal(cancelled?.isCancelled, true);
    assert.equal(cancelled?.associationId, created.associationId);
    assert.equal(store.listMeetings()[0]?.status, "CANCELLED");
  });
});

test("migrates legacy calendar rows into the account-scoped schema", async () => {
  const directory = await temporaryDirectory("ai-workmate-calendar-migration-");
  try {
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE meetings (
        meeting_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        folder_name TEXT NOT NULL UNIQUE,
        folder_relative_path TEXT NOT NULL UNIQUE,
        meeting_date TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provider_meeting_id TEXT,
        calendar_event_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'DETECTED', 'PREPARING', 'RECORDING', 'FINALIZING', 'PROCESSING', 'COMPLETED', 'INCOMPLETE', 'FAILED', 'CANCELLED')),
        storage_version INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
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
      CREATE INDEX calendar_event_associations_meeting_index ON calendar_event_associations(meeting_id);
      CREATE INDEX calendar_event_associations_start_index ON calendar_event_associations(start_time);
      CREATE INDEX calendar_event_associations_platform_index ON calendar_event_associations(meeting_platform);
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-01-01T00:00:00.000Z');
      INSERT INTO meetings (
        meeting_id, title, slug, folder_name, folder_relative_path, meeting_date,
        created_at, updated_at, status, storage_version
      ) VALUES (
        'meeting-legacy-1', 'Legacy planning', 'legacy-planning', '2026-08-01-legacy-planning',
        '2026-08-01/2026-08-01-legacy-planning', '2026-08-01',
        '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z', 'SCHEDULED', 1
      );
      INSERT INTO calendar_event_associations (
        provider, external_event_id, meeting_id, subject, start_time, end_time,
        attendees_json, online_meeting_json, is_cancelled,
        meeting_platform, normalized_fingerprint, created_at, updated_at
      ) VALUES (
        'MICROSOFT_GRAPH', 'legacy-event-1', 'meeting-legacy-1', 'Legacy planning',
        '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z',
        '[]', '{"provider":"teamsForBusiness","joinUrl":"https://teams.microsoft.com/l/meetup-join/legacy"}', 0,
        'TEAMS', 'legacy-fingerprint', '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new LocalDatabase(databasePath);
    try {
      const association = migrated.getCalendarEventAssociation("MICROSOFT_GRAPH", "legacy-event-1");
      assert.ok(association);
      assert.equal(association.accountId, "");
      assert.equal(association.associationId, calendarEventAssociationId("MICROSOFT_GRAPH", "", "legacy-event-1"));
      assert.equal(association.subject, "Legacy planning");
      assert.equal(association.joinUrl, "https://teams.microsoft.com/l/meetup-join/legacy");
      assert.equal(association.meetingPlatform, "TEAMS");
    } finally {
      migrated.close();
    }

    const verification = new DatabaseSync(databasePath);
    try {
      const row = verification.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number } | undefined;
      assert.equal(row?.version, DATABASE_SCHEMA_VERSION);
      const indexes = verification.prepare("PRAGMA index_list(calendar_event_associations)").all() as { name: string }[];
      assert.deepEqual(
        indexes.map((index) => index.name).sort(),
        [
          "calendar_event_associations_join_url_index",
          "calendar_event_associations_meeting_index",
          "calendar_event_associations_platform_index",
          "calendar_event_associations_start_index",
          "calendar_event_associations_web_url_index",
          "sqlite_autoindex_calendar_event_associations_1",
          "sqlite_autoindex_calendar_event_associations_2",
        ].sort(),
      );
    } finally {
      verification.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sanitizes calendar sync results at the renderer boundary", () => {
  const renderer = toRendererCalendarSyncResult({
    provider: "MICROSOFT_GRAPH",
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z",
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    cancelledCount: 0,
    errorCount: 1,
    errors: [
      {
        provider: "MICROSOFT_GRAPH",
        code: "InvalidAuthenticationToken",
        message: "Bearer secret-token-value under C:\\Users\\ada\\AppData\\Local\\ai-workmate",
        retryable: false,
        status: 401,
        externalEventId: "event-1",
      },
    ],
  });
  const serialized = JSON.stringify(renderer);
  assert.ok(!serialized.includes("secret-token-value"));
  assert.ok(!serialized.includes("AppData"));
  assert.ok(!serialized.includes("event-1"));
  assert.equal(renderer.errors[0]?.code, "InvalidAuthenticationToken");
  assert.equal(renderer.errors[0]?.status, 401);
});

function syncRange(): { startTime: string; endTime: string } {
  return {
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z",
  };
}

function foundationEvent(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    provider: "MICROSOFT_GRAPH",
    externalEventId: "foundation-event-1",
    subject: "Planning",
    startTime: "2026-09-01T10:00:00.000Z",
    endTime: "2026-09-01T11:00:00.000Z",
    attendees: [],
    isCancelled: false,
    ...overrides,
  };
}
