import assert from "node:assert/strict";
import { test } from "node:test";

import { GoogleCalendarProvider, normalizeGoogleCalendarEvent, type GoogleCalendarEvent } from "../src/integrations/google/GoogleCalendarProvider";
import { GoogleApiClient, type GoogleApiRequest, type GoogleApiResponse, type GoogleApiTransport } from "../src/integrations/google/GoogleApiClient";
import type { GoogleGraphAuthProvider } from "../src/integrations/google/GoogleAuth";

const FAKE_AUTH: GoogleGraphAuthProvider = {
  getAccessToken: async () => ({ accessToken: "ya29.token", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
};

function event(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: "event-1",
    status: "confirmed",
    htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
    updated: "2026-09-08T10:00:00.000Z",
    summary: "Design Review",
    location: "Room 4",
    creator: { email: "ada@gmail.com", displayName: "Ada" },
    organizer: { email: "ada@gmail.com", displayName: "Ada" },
    start: { dateTime: "2026-09-10T09:00:00Z" },
    end: { dateTime: "2026-09-10T10:00:00Z" },
    attendees: [{ email: "grace@gmail.com", displayName: "Grace", responseStatus: "accepted" }],
    ...overrides,
  };
}

function transport(handler: (request: GoogleApiRequest) => GoogleApiResponse): GoogleApiTransport {
  return { send: async (request) => handler(request) };
}

test("normalizes a full Google event into the shared calendar model", () => {
  const normalized = normalizeGoogleCalendarEvent(event());
  assert.equal(normalized.provider, "GOOGLE_CALENDAR");
  assert.equal(normalized.externalEventId, "event-1");
  assert.equal(normalized.subject, "Design Review");
  assert.equal(normalized.startTime, "2026-09-10T09:00:00.000Z");
  assert.equal(normalized.endTime, "2026-09-10T10:00:00.000Z");
  assert.equal(normalized.isCancelled, false);
  assert.equal(normalized.location, "Room 4");
  assert.equal(normalized.webUrl, "https://calendar.google.com/calendar/event?eid=abc");
  assert.equal(normalized.organizer?.email, "ada@gmail.com");
  assert.deepEqual(normalized.attendees, [{ email: "grace@gmail.com", displayName: "Grace", responseStatus: "accepted" }]);
  assert.equal(normalized.lastModifiedAt, "2026-09-08T10:00:00.000Z");
});

test("maps cancelled status, Meet conference join URLs, all-day dates, and defaults", () => {
  const cancelled = normalizeGoogleCalendarEvent(event({ status: "cancelled" }));
  assert.equal(cancelled.isCancelled, true);

  const meeting = normalizeGoogleCalendarEvent(event({
    conferenceData: {
      conferenceId: "abc-def-ghi",
      conferenceSolution: { name: "Google Meet", key: { type: "hangoutsMeet" } },
      entryPoints: [
        { entryPointType: "video", uri: "https://meet.google.com/abc-def-ghi", label: "Join with Google Meet" },
        { entryPointType: "phone", uri: "tel:+1-555-0100", label: "+1 555 0100", pin: "123456" },
      ],
    },
  }));
  assert.equal(meeting.onlineMeeting?.provider, "Google Meet");
  assert.equal(meeting.onlineMeeting?.joinUrl, "https://meet.google.com/abc-def-ghi");
  assert.equal(meeting.onlineMeeting?.conferenceId, "abc-def-ghi");

  const allDay = normalizeGoogleCalendarEvent(event({
    summary: undefined,
    start: { date: "2026-09-10" },
    end: { date: "2026-09-11" },
  }));
  assert.equal(allDay.subject, "Untitled meeting");
  assert.equal(allDay.startTime, "2026-09-10T00:00:00.000Z");
  assert.equal(allDay.endTime, "2026-09-11T00:00:00.000Z");
});

test("zone-less event times resolve as UTC (the request pins timeZone=UTC)", () => {
  const naive = normalizeGoogleCalendarEvent(event({ start: { dateTime: "2026-09-10T09:00:00" }, end: { dateTime: "2026-09-10T10:00:00" } }));
  assert.equal(naive.startTime, "2026-09-10T09:00:00.000Z");

  const offset = normalizeGoogleCalendarEvent(event({ start: { dateTime: "2026-09-10T09:00:00+02:00" }, end: { dateTime: "2026-09-10T10:00:00+02:00" } }));
  assert.equal(offset.startTime, "2026-09-10T07:00:00.000Z");
});

test("listEvents pages through nextPageToken and window-queries with UTC and showDeleted", async () => {
  const requests: GoogleApiRequest[] = [];
  const api = new GoogleApiClient(FAKE_AUTH, transport((request) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.searchParams.get("pageToken") === null) {
      return {
        status: 200,
        headers: {},
        body: {
          items: [event({ id: "e1" }), event({ id: "e2" })],
          nextPageToken: "token-2",
        },
      };
    }
    return { status: 200, headers: {}, body: { items: [event({ id: "e3", status: "cancelled" })], nextSyncToken: "sync-token-final" } };
  }), { retry: { sleeper: async () => undefined } });
  const provider = new GoogleCalendarProvider(api);
  const events = await provider.listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" });

  assert.equal(events.length, 3);
  assert.equal(events[2]?.isCancelled, true);
  assert.equal(requests.length, 2);
  const first = new URL(requests[0]?.url ?? "");
  assert.equal(first.searchParams.get("timeMin"), "2026-09-01T00:00:00.000Z");
  assert.equal(first.searchParams.get("timeMax"), "2026-10-01T00:00:00.000Z");
  assert.equal(first.searchParams.get("singleEvents"), "true");
  assert.equal(first.searchParams.get("showDeleted"), "true");
  assert.equal(first.searchParams.get("timeZone"), "UTC");
  const second = new URL(requests[1]?.url ?? "");
  assert.equal(second.searchParams.get("pageToken"), "token-2");
});

test("malformed items reject loudly rather than storing partial events", async () => {
  const api = new GoogleApiClient(FAKE_AUTH, transport(() => ({ status: 200, headers: {}, body: { items: [{ summary: "no id" }] } })), {
    retry: { sleeper: async () => undefined },
  });
  const provider = new GoogleCalendarProvider(api);
  await assert.rejects(
    provider.listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" }),
    /missing its id/,
  );

  const invalidCollection = new GoogleApiClient(FAKE_AUTH, transport(() => ({ status: 200, headers: {}, body: { items: "nope" } })), {
    retry: { sleeper: async () => undefined },
  });
  await assert.rejects(
    new GoogleCalendarProvider(invalidCollection).listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" }),
    /invalid items collection/,
  );
});

test("getEventById requests a single event without pagination fields", async () => {
  const requests: GoogleApiRequest[] = [];
  const api = new GoogleApiClient(FAKE_AUTH, transport((request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: event({ id: "event-9", summary: "One-on-one" }) };
  }), { retry: { sleeper: async () => undefined } });
  const provider = new GoogleCalendarProvider(api);
  const normalized = await provider.getEventById({ externalEventId: "event-9" });
  assert.equal(normalized.subject, "One-on-one");
  assert.equal(requests.length, 1);
  const fields = new URL(requests[0]?.url ?? "").searchParams.get("fields") ?? "";
  assert.equal(fields.includes("nextPageToken"), false);
  assert.equal(fields.includes("id"), true);
});
