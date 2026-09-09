import type { CalendarDeltaRequest, CalendarDeltaResult } from "../../calendar/CalendarModels";
import { assertNotAborted } from "../../calendar/CalendarModels";
import type { GoogleApiClient } from "./GoogleApiClient";
import { GoogleApiError } from "./GoogleApiClient";
import type { GoogleCalendarProvider } from "./GoogleCalendarProvider";
import { GOOGLE_CALENDAR_ID_PRIMARY } from "./GoogleAuth";

/**
 * Google Calendar API v3 incremental sync (syncToken) on top of the shared
 * provider abstraction.
 *
 * Google's sync rules (events.list):
 *  - A `syncToken` request must NOT carry timeMin/timeMax/orderBy/q/updatedMin
 *    (HTTP 400); it returns every event created, updated, or deleted since
 *    the token, so a token permanently encodes the change window. All other
 *    parameters (singleEvents, showDeleted, maxResults, fields, timeZone)
 *    must stay identical to the initial full sync.
 *  - Deletions arrive as items with `status: "cancelled"` (with
 *    recurringEventId/originalStartTime for cancelled instances) — Google
 *    never emits tombstone-only records for the windowed instance stream, so
 *    cancelled events flow through the shared isCancelled upsert path.
 *  - `nextSyncToken` is only present on the FINAL page of a response; when a
 *    page carries `nextPageToken` the client must page to the end before
 *    capturing it.
 *  - A stale/expired token fails with HTTP 410 GONE; the coordinator clears
 *    the local cursor and runs a full sync.
 */
export class GoogleCalendarDeltaProvider {
  public constructor(
    private readonly client: GoogleApiClient,
    private readonly provider: GoogleCalendarProvider,
    private readonly calendarId: string = GOOGLE_CALENDAR_ID_PRIMARY,
  ) {}

  public async getDelta(request: CalendarDeltaRequest): Promise<CalendarDeltaResult> {
    assertNotAborted(request.signal);
    const syncToken = request.deltaLink?.trim();
    if (syncToken !== undefined && syncToken.length > 0) {
      return this.incremental(syncToken, request.signal);
    }
    return this.fullWindow(request, request.signal);
  }

  private async incremental(syncToken: string, signal: AbortSignal | undefined): Promise<CalendarDeltaResult> {
    const params = new URLSearchParams({
      syncToken,
      singleEvents: "true",
      showDeleted: "true",
      timeZone: "UTC",
      maxResults: "2500",
      fields: incrementalFields(),
    });
    const path = `/calendars/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`;
    const page = await this.provider.fetchEventsPage(path, signal);
    return { events: page.events, deletions: [], nextDeltaLink: page.nextSyncToken ?? "" };
  }

  private async fullWindow(request: CalendarDeltaRequest, signal: AbortSignal | undefined): Promise<CalendarDeltaResult> {
    const startTime = request.startTime;
    const endTime = request.endTime;
    if (startTime === undefined || endTime === undefined) {
      throw new Error("A Google Calendar delta window (startTime and endTime) is required for the first synchronization.");
    }
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new Error("Google Calendar delta synchronization requires a valid start/end time range.");
    }
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      showDeleted: "true",
      timeZone: "UTC",
      maxResults: "2500",
      orderBy: "startTime",
      fields: incrementalFields(),
    });
    const path = `/calendars/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`;
    const page = await this.provider.fetchEventsPage(path, signal);
    return { events: page.events, deletions: [], nextDeltaLink: page.nextSyncToken ?? "" };
  }
}

function incrementalFields(): string {
  return "items(id,status,htmlLink,updated,summary,location,creator,organizer,start,end," +
    "recurrence,recurringEventId,originalStartTime,attendees,attendeesOmitted," +
    "conferenceData,conferenceData.conferenceId,conferenceData.conferenceSolution," +
    "conferenceData.entryPoints,transparency,visibility,iCalUID),nextPageToken,nextSyncToken";
}

/**
 * A Google API error is a stale-sync-token condition when the transport
 * reports HTTP 410 GONE (the Calendar API's documented signal) — regardless
 * of the body reason.
 */
export function isStaleGoogleSyncTokenError(error: unknown): boolean {
  if (error instanceof GoogleApiError) {
    return error.status === 410;
  }
  if (typeof error === "object" && error !== null) {
    const typed = error as { code?: unknown; status?: unknown };
    const code = typeof typed.code === "string" ? typed.code : undefined;
    return (code === "syncTokenInvalid" || code === "SyncTokenInvalid" || code === "http_410") || typed.status === 410;
  }
  return false;
}
