import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CalendarSyncService,
  MicrosoftGraphCalendarProvider,
  MicrosoftGraphClient,
  MicrosoftGraphError,
  detectMeetingPlatform,
  normalizeGraphCalendarEvent,
  type CalendarEventProvider,
  type GraphCalendarEvent,
  type MicrosoftGraphRequest,
  type MicrosoftGraphTransport,
  type NormalizedCalendarEvent,
} from "../src";
import { withTempStore } from "./helpers";

class StaticCalendarProvider implements CalendarEventProvider {
  public constructor(private readonly events: NormalizedCalendarEvent[] = []) {}

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

test("normalizes Microsoft Graph events without persisting raw Graph responses", () => {
  const graphEvent: GraphCalendarEvent = {
    id: "graph-event-1",
    subject: "Architecture Review",
    start: { dateTime: "2026-09-01T10:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-09-01T11:00:00Z", timeZone: "UTC" },
    organizer: { emailAddress: { name: "Ada Lovelace", address: "ADA@EXAMPLE.COM" } },
    attendees: [
      {
        emailAddress: { name: "Grace Hopper", address: "grace@example.com" },
        type: "required",
        status: { response: "accepted" },
      },
    ],
    location: { displayName: "Microsoft Teams Meeting" },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    onlineMeeting: {
      joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      conferenceId: "123 456 789",
      tollNumber: "+1 555 0100",
    },
    webLink: "https://outlook.office.com/calendar/item/graph-event-1",
    isCancelled: false,
    lastModifiedDateTime: "2026-08-31T12:00:00Z",
  };

  const normalized = normalizeGraphCalendarEvent(graphEvent);

  assert.deepEqual(normalized, {
    provider: "MICROSOFT_GRAPH",
    externalEventId: "graph-event-1",
    subject: "Architecture Review",
    startTime: "2026-09-01T10:00:00.000Z",
    endTime: "2026-09-01T11:00:00.000Z",
    organizer: { displayName: "Ada Lovelace", email: "ada@example.com" },
    attendees: [
      {
        displayName: "Grace Hopper",
        email: "grace@example.com",
        type: "required",
        responseStatus: "accepted",
      },
    ],
    location: "Microsoft Teams Meeting",
    onlineMeeting: {
      provider: "teamsForBusiness",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      conferenceId: "123 456 789",
      tollNumber: "+1 555 0100",
    },
    webUrl: "https://outlook.office.com/calendar/item/graph-event-1",
    isCancelled: false,
    lastModifiedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.equal(detectMeetingPlatform(normalized), "TEAMS");
});

test("deterministically distinguishes Teams, other online meetings, and normal events", () => {
  const teamsByProvider = calendarEvent({
    onlineMeeting: { provider: "teamsForBusiness", joinUrl: "https://example.invalid/not-teams" },
  });
  const teamsByUrl = calendarEvent({
    onlineMeeting: { provider: "unknown", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
  });
  const zoomMeeting = calendarEvent({
    onlineMeeting: { provider: "unknown", joinUrl: "https://example.zoom.us/j/123" },
  });
  const skypeMeeting = calendarEvent({
    onlineMeeting: { provider: "skypeForBusiness" },
  });
  const plainCalendarEvent = calendarEvent({ onlineMeeting: undefined, location: "Conference Room 4" });

  assert.equal(detectMeetingPlatform(teamsByProvider), "TEAMS");
  assert.equal(detectMeetingPlatform(teamsByUrl), "TEAMS");
  assert.equal(detectMeetingPlatform(zoomMeeting), "OTHER_ONLINE");
  assert.equal(detectMeetingPlatform(skypeMeeting), "OTHER_ONLINE");
  assert.equal(detectMeetingPlatform(plainCalendarEvent), "NONE");
});

test("uses injected Microsoft Graph transport for pagination and event lookup", async () => {
  const requests: MicrosoftGraphRequest[] = [];
  const transport: MicrosoftGraphTransport = {
    send: async (request) => {
      requests.push(request);
      if (request.url.includes("/me/events/lookup-event")) {
        return { status: 200, headers: {}, body: graphEvent("lookup-event", "Lookup Event") };
      }
      if (request.url.includes("skiptoken=page-2")) {
        return { status: 200, headers: {}, body: { value: [graphEvent("event-2", "Second page")] } };
      }
      return {
        status: 200,
        headers: {},
        body: {
          value: [graphEvent("event-1", "First page")],
          "@odata.nextLink": "https://graph.example/v1.0/me/calendarView?skiptoken=page-2",
        },
      };
    },
  };
  const client = new MicrosoftGraphClient(
    { getAccessToken: async () => ({ accessToken: "test-access-token", scopes: ["Calendars.Read"] }) },
    transport,
    { baseUrl: "https://graph.example/v1.0" },
  );
  const provider = new MicrosoftGraphCalendarProvider(client);

  const events = await provider.listEvents({
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z",
    pageSize: 1,
  });
  const lookup = await provider.getEventById({ externalEventId: "lookup-event" });

  assert.deepEqual(events.map((event) => event.externalEventId), ["event-1", "event-2"]);
  assert.equal(lookup.subject, "Lookup Event");
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.headers.authorization === "Bearer test-access-token"));
  assert.ok(requests[0]?.url.includes("%24top=1"));
  assert.ok(requests[0]?.url.includes("%24select="));
});

test("reports Microsoft Graph errors structurally without touching local storage", async () => {
  await withTempStore(async (store) => {
    const provider = {
      listEvents: async () => {
        throw new MicrosoftGraphError("TooManyRequests", "Graph throttled calendarView.", 429, true);
      },
      getEventById: async () => calendarEvent(),
    } satisfies CalendarEventProvider;
    const result = await new CalendarSyncService(provider, store).syncRange({
      startTime: "2026-09-01T00:00:00.000Z",
      endTime: "2026-09-02T00:00:00.000Z",
    });

    assert.equal(result.errorCount, 1);
    assert.equal(result.errors[0]?.code, "TooManyRequests");
    assert.equal(result.errors[0]?.retryable, true);
    assert.equal(result.errors[0]?.status, 429);
    assert.equal(store.listMeetings().length, 0);
  });
});

test("honors cancellation before Graph retrieval or local persistence", async () => {
  await withTempStore(async (store) => {
    const controller = new AbortController();
    controller.abort();
    const service = new CalendarSyncService(new StaticCalendarProvider([calendarEvent()]), store);

    await assert.rejects(
      service.syncRange({
        startTime: "2026-09-01T00:00:00.000Z",
        endTime: "2026-09-02T00:00:00.000Z",
        signal: controller.signal,
      }),
      /cancelled/,
    );
    assert.equal(store.listMeetings().length, 0);
  });
});

function calendarEvent(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    provider: "MICROSOFT_GRAPH",
    externalEventId: "graph-event-1",
    subject: "Planning",
    startTime: "2026-09-01T10:00:00.000Z",
    endTime: "2026-09-01T11:00:00.000Z",
    attendees: [],
    isCancelled: false,
    ...overrides,
  };
}

test("normalizes Phase 10 provider fields while preserving the source timezone", () => {
  const normalized = normalizeGraphCalendarEvent(
    {
      ...graphEvent("graph-event-10", "Phase 10 Review"),
      iCalUId: "ical-uid-10",
      bodyPreview: "Review the Phase 10 foundation.",
      showAs: "busy",
      start: { dateTime: "2026-09-01T10:00:00", timeZone: "Arabian Standard Time" },
      end: { dateTime: "2026-09-01T11:00:00", timeZone: "Arabian Standard Time" },
    },
    "ada@example.com",
  );

  assert.equal(normalized.accountId, "ada@example.com");
  assert.equal(normalized.startTime, "2026-09-01T10:00:00 [Arabian Standard Time]");
  assert.equal(normalized.endTime, "2026-09-01T11:00:00 [Arabian Standard Time]");
  assert.equal(normalized.startTimeZone, "Arabian Standard Time");
  assert.equal(normalized.endTimeZone, "Arabian Standard Time");
  assert.equal(normalized.description, "Review the Phase 10 foundation.");
  assert.equal(normalized.status, "busy");
  assert.deepEqual(normalized.syncMetadata, { iCalUId: "ical-uid-10" });
});

test("omits redundant timezone labels for UTC and explicit-offset timestamps", () => {
  const normalized = normalizeGraphCalendarEvent({
    ...graphEvent("graph-event-utc", "UTC Event"),
    start: { dateTime: "2026-09-01T10:00:00+03:00", timeZone: "Arabian Standard Time" },
    end: { dateTime: "2026-09-01T11:00:00Z", timeZone: "UTC" },
  });

  assert.equal(normalized.startTime, "2026-09-01T07:00:00.000Z");
  assert.equal(normalized.endTime, "2026-09-01T11:00:00.000Z");
  assert.equal(normalized.startTimeZone, undefined);
  assert.equal(normalized.endTimeZone, undefined);
  assert.equal(normalized.accountId, undefined);
  assert.equal(normalized.syncMetadata, undefined);
});

test("exposes provider identity and leaves incremental sync unimplemented", () => {
  const client = new MicrosoftGraphClient({
    getAccessToken: async () => ({ accessToken: "unused", scopes: ["Calendars.Read"] }),
  });
  const provider = new MicrosoftGraphCalendarProvider(client, { accountId: "ada@example.com" });
  const anonymous = new MicrosoftGraphCalendarProvider(client, { accountId: "  " });

  assert.equal(provider.providerId, "MICROSOFT_GRAPH");
  assert.equal(provider.accountId, "ada@example.com");
  assert.equal(anonymous.accountId, undefined);
  const asProvider: CalendarEventProvider = provider;
  assert.equal(asProvider.listChangedEvents, undefined);
});

function graphEvent(id: string, subject: string): GraphCalendarEvent {
  return {
    id,
    subject,
    start: { dateTime: "2026-09-01T10:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-09-01T11:00:00", timeZone: "UTC" },
    isCancelled: false,
  };
}
