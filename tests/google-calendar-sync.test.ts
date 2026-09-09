import assert from "node:assert/strict";
import { test } from "node:test";

import type { CalendarDeltaProvider, CalendarDeltaRequest, CalendarEventProvider } from "../src/calendar/CalendarModels";
import { CalendarSyncService } from "../src/calendar/CalendarSyncService";
import { GoogleApiClient, type GoogleApiRequest, type GoogleApiResponse, type GoogleApiTransport } from "../src/integrations/google/GoogleApiClient";
import { GoogleCalendarProvider, type GoogleCalendarEvent, type GoogleEventsListResponse } from "../src/integrations/google/GoogleCalendarProvider";
import { GoogleCalendarDeltaProvider } from "../src/integrations/google/GoogleCalendarDeltaProvider";
import type { GoogleGraphAuthProvider } from "../src/integrations/google/GoogleAuth";
import { withTempStore } from "./helpers";

const FAKE_AUTH: GoogleGraphAuthProvider = {
  getAccessToken: async () => ({ accessToken: "ya29.token", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
};

const RANGE = { startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" };

function googleEvent(id: string, overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id,
    status: "confirmed",
    summary: "Sync Meeting",
    start: { dateTime: "2026-09-10T09:00:00Z" },
    end: { dateTime: "2026-09-10T10:00:00Z" },
    updated: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

interface ScriptedState {
  requests: GoogleApiRequest[];
  /** Full responses returned for windowed (no syncToken) requests, in order. */
  fullPages: Array<GoogleEventsListResponse | { status: number; body: GoogleEventsListResponse }>;
  /** Handler for incremental (syncToken) requests; default echoes fullPages[0]. */
  deltaHandler?: (params: URLSearchParams, requestIndex: number) => GoogleApiResponse;
  /** Handler for all requests; when set it overrides fullPages/deltaHandler. */
  globalHandler?: (request: GoogleApiRequest, params: URLSearchParams, index: number) => GoogleApiResponse;
}

function createTransport(script: ScriptedState): { transport: GoogleApiTransport; requests: GoogleApiRequest[] } {
  return {
    transport: {
      send: async (request) => {
        const index = script.requests.length;
        script.requests.push(request);
        if (script.globalHandler !== undefined) {
          return script.globalHandler(request, new URL(request.url).searchParams, index);
        }
        const params = new URL(request.url).searchParams;
        if (params.get("syncToken") !== null) {
          if (script.deltaHandler !== undefined) {
            return script.deltaHandler(params, index);
          }
          return { status: 200, headers: {}, body: { items: [], nextSyncToken: params.get("syncToken") } };
        }
        const page = script.fullPages.shift();
        if (page === undefined) {
          return { status: 500, headers: {}, body: { error: { code: 500, message: "no scripted page" } } };
        }
        if ("status" in page) {
          const errorPage = page as { status: number; body: GoogleEventsListResponse };
          return { status: errorPage.status, headers: {}, body: errorPage.body };
        }
        return { status: 200, headers: {}, body: page };
      },
    },
    requests: script.requests,
  };
}

function makeDeltaProvider(transport: GoogleApiTransport): CalendarEventProvider & CalendarDeltaProvider {
  const client = new GoogleApiClient(FAKE_AUTH, transport, { retry: { sleeper: async () => undefined, maxAttempts: 2 } });
  const provider = new GoogleCalendarProvider(client);
  const delta = new GoogleCalendarDeltaProvider(client, provider);
  return {
    listEvents: (request) => provider.listEvents(request),
    getEventById: (request) => provider.getEventById(request),
    getDelta: (request: CalendarDeltaRequest) => delta.getDelta(request),
  };
}

test("first Google sync is a full windowed fetch that stores the syncToken; later syncs use only the token", async () => {
  await withTempStore(async (store) => {
    const script: ScriptedState = {
      requests: [],
      fullPages: [{ items: [googleEvent("evt-a", { summary: "Design Review" })], nextSyncToken: "sync-token-1" }],
    };
    const harness = createTransport(script);
    const service = new CalendarSyncService(makeDeltaProvider(harness.transport), store, "GOOGLE_CALENDAR");

    const first = await service.syncCalendar(RANGE);
    assert.equal(first.mode, "FULL");
    assert.equal(first.createdCount, 1);
    assert.equal(first.errorCount, 0);
    const fullUrl = new URL(harness.requests[0]?.url ?? "");
    assert.equal(fullUrl.searchParams.get("syncToken"), null);
    assert.equal(fullUrl.searchParams.get("timeMin"), "2026-09-01T00:00:00.000Z");
    assert.equal(fullUrl.searchParams.get("timeMax"), "2026-10-01T00:00:00.000Z");
    assert.equal(fullUrl.searchParams.get("singleEvents"), "true");
    assert.equal(fullUrl.searchParams.get("showDeleted"), "true");

    const state = store.getCalendarSyncState("GOOGLE_CALENDAR");
    assert.equal(state?.deltaCursor, "sync-token-1");
    assert.equal(state?.syncWindowStart, RANGE.startTime);
    assert.equal(state?.syncWindowEnd, RANGE.endTime);
    assert.equal(store.listMeetings().length, 1);

    // Second sync: incremental — the request MUST carry the syncToken and
    // must NOT carry timeMin/timeMax (Google returns HTTP 400 otherwise).
    script.deltaHandler = (params) => {
      assert.equal(params.get("syncToken"), "sync-token-1");
      assert.equal(params.get("timeMin"), null);
      assert.equal(params.get("timeMax"), null);
      return {
        status: 200,
        headers: {},
        body: {
          items: [
            googleEvent("evt-a", { summary: "Design Review (updated)", start: { dateTime: "2026-09-10T11:00:00Z" }, end: { dateTime: "2026-09-10T12:00:00Z" } }),
            googleEvent("evt-b", { summary: "New Planning" }),
            googleEvent("evt-c", { status: "cancelled", summary: "Cancelled Old" }),
          ],
          nextSyncToken: "sync-token-2",
        },
      };
    };
    const second = await service.syncCalendar(RANGE);
    assert.equal(second.mode, "DELTA");
    assert.equal(second.updatedCount, 1);
    assert.equal(second.createdCount, 1);
    assert.equal(second.cancelledCount, 1);
    assert.equal(second.errorCount, 0);
    assert.equal(second.deltaCursorAdvanced, true);
    assert.equal(store.getCalendarSyncState("GOOGLE_CALENDAR")?.deltaCursor, "sync-token-2");
    assert.equal(store.listMeetings().length, 2); // cancelled events do not create meetings
  });
});

test("a stale Google syncToken (HTTP 410) self-heals with a full re-sync", async () => {
  await withTempStore(async (store) => {
    const script: ScriptedState = {
      requests: [],
      fullPages: [{ items: [googleEvent("evt-a")], nextSyncToken: "sync-token-1" }],
      deltaHandler: () => ({
        status: 410,
        headers: {},
        body: { error: { code: 410, message: "The requested sync token is no longer valid.", errors: [{ reason: "syncTokenInvalid" }] } },
      }),
    };
    const harness = createTransport(script);
    const service = new CalendarSyncService(makeDeltaProvider(harness.transport), store, "GOOGLE_CALENDAR");
    await service.syncCalendar(RANGE);

    // A token-expiry request outside the window is impossible (the token
    // already exists), so re-run inside the window to force the delta path.
    script.deltaHandler = () => ({
      status: 410,
      headers: {},
      body: { error: { code: 410, message: "sync token invalid" } },
    });
    script.fullPages = [
      { items: [googleEvent("evt-a"), googleEvent("evt-d", { summary: "After Reset" })], nextSyncToken: "sync-token-2" },
    ];
    const healed = await service.syncCalendar(RANGE);
    assert.equal(healed.mode, "DELTA"); // coordinator keeps the mode label of the interrupted delta run
    assert.equal(healed.staleCursorDetected, true);
    assert.equal(healed.errorCount, 0);
    assert.equal(healed.createdCount, 1); // evt-d is new
    assert.equal(store.getCalendarSyncState("GOOGLE_CALENDAR")?.deltaCursor, "sync-token-2");
  });
});

test("nextSyncToken is only captured from the final page of a multi-page response", async () => {
  await withTempStore(async (store) => {
    const script: ScriptedState = {
      requests: [],
      fullPages: [
        // First page: nextPageToken, NO nextSyncToken.
        { items: [googleEvent("evt-a")], nextPageToken: "page-2" },
        // Final page: token present.
        { items: [googleEvent("evt-b")], nextSyncToken: "final-sync-token" },
      ],
    };
    const harness = createTransport(script);
    const service = new CalendarSyncService(makeDeltaProvider(harness.transport), store, "GOOGLE_CALENDAR");
    const result = await service.syncCalendar(RANGE);
    assert.equal(result.createdCount, 2);
    assert.equal(harness.requests.length, 2);
    const page2 = new URL(harness.requests[1]?.url ?? "");
    assert.equal(page2.searchParams.get("pageToken"), "page-2");
    assert.equal(store.getCalendarSyncState("GOOGLE_CALENDAR")?.deltaCursor, "final-sync-token");
  });
});

test("re-delivering the same Google delta after an interrupted run is idempotent", async () => {
  await withTempStore(async (store) => {
    const script: ScriptedState = {
      requests: [],
      fullPages: [{ items: [googleEvent("evt-a")], nextSyncToken: "sync-token-1" }],
      deltaHandler: () => ({
        status: 200,
        headers: {},
        body: { items: [googleEvent("evt-a", { summary: "Updated Subject" })], nextSyncToken: "sync-token-2" },
      }),
    };
    const harness = createTransport(script);
    const service = new CalendarSyncService(makeDeltaProvider(harness.transport), store, "GOOGLE_CALENDAR");
    await service.syncCalendar(RANGE);

    const first = await service.syncCalendar(RANGE);
    assert.equal(first.updatedCount, 1);

    // Crash before the cursor advanced: stored cursor is still token-1 and
    // the same delta is delivered again. Deterministic upserts make it a no-op.
    store.saveCalendarSyncState("GOOGLE_CALENDAR", { deltaCursor: "sync-token-1" });
    const replay = await service.syncCalendar(RANGE);
    assert.equal(replay.mode, "DELTA");
    assert.equal(replay.updatedCount, 0);
    assert.equal(replay.unchangedCount, 1);
    assert.equal(replay.errorCount, 0);
    assert.equal(store.getCalendarSyncState("GOOGLE_CALENDAR")?.deltaCursor, "sync-token-2");
    assert.equal(store.listMeetings().length, 1);
  });
});

test("Google cancelled events cancel only the matching scheduled meeting", async () => {
  await withTempStore(async (store) => {
    const script: ScriptedState = {
      requests: [],
      fullPages: [{ items: [googleEvent("evt-a", { summary: "Team Sync" })], nextSyncToken: "sync-token-1" }],
      deltaHandler: () => ({
        status: 200,
        headers: {},
        body: { items: [googleEvent("evt-a", { summary: "Team Sync", status: "cancelled" })], nextSyncToken: "sync-token-2" },
      }),
    };
    const harness = createTransport(script);
    const service = new CalendarSyncService(makeDeltaProvider(harness.transport), store, "GOOGLE_CALENDAR");
    await service.syncCalendar(RANGE);
    const meetings = store.listMeetings();
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.status, "SCHEDULED");

    const result = await service.syncCalendar(RANGE);
    assert.equal(result.cancelledCount, 1);
    assert.equal(result.errorCount, 0);
    const after = store.listMeetings();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.status, "CANCELLED");

    // Replaying the same cancelled event never revives the meeting.
    store.saveCalendarSyncState("GOOGLE_CALENDAR", { deltaCursor: "sync-token-1" });
    const replay = await service.syncCalendar(RANGE);
    assert.equal(replay.cancelledCount, 1);
    assert.equal(store.listMeetings()[0]?.status, "CANCELLED");
  });
});
