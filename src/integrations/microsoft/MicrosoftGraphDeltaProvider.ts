import type {
  CalendarDeltaRequest,
  CalendarDeltaResult,
  CalendarEventDeletion,
} from "../../calendar/CalendarModels";
import { assertNotAborted } from "../../calendar/CalendarModels";
import type { NormalizedCalendarEvent } from "../../calendar/CalendarModels";
import type { MicrosoftGraphClient } from "./MicrosoftGraphClient";
import { normalizeGraphCalendarEvent, type GraphCalendarEvent } from "./MicrosoftGraphCalendarProvider";

/**
 * Microsoft Graph calendarView delta support: opaque cursor handling on top of
 * the shared MicrosoftGraphClient paging. A deltaLink without a window follows
 * exactly what the provider issued; the first request carries the window.
 * Events that Graph reports as `@removed` cannot be normalized (the payload
 * has no subject/times), so they are surfaced as deletions and the store
 * decides what they mean locally.
 */

const EVENT_SELECT_FIELDS = [
  "id",
  "iCalUId",
  "subject",
  "start",
  "end",
  "organizer",
  "attendees",
  "location",
  "locations",
  "isOnlineMeeting",
  "onlineMeetingProvider",
  "onlineMeeting",
  "webLink",
  "isCancelled",
  "lastModifiedDateTime",
].join(",");

const STALE_DELTA_ERROR_CODES = new Set(["syncStateNotFound", "SyncStateNotFound", "deltaLinkNotFound"]);

export class MicrosoftGraphDeltaProvider {
  public constructor(private readonly client: MicrosoftGraphClient) {}

  public async getDelta(request: CalendarDeltaRequest): Promise<CalendarDeltaResult> {
    assertNotAborted(request.signal);
    const deltaLink = request.deltaLink?.trim();
    let url: string;
    if (deltaLink !== undefined && deltaLink.length > 0) {
      if (!deltaLink.startsWith("https://")) {
        throw new Error("The Microsoft Graph delta cursor is invalid.");
      }
      url = deltaLink;
    } else {
      assertValidRange(request.startTime, request.endTime);
      const params = new URLSearchParams({
        startDateTime: request.startTime as string,
        endDateTime: request.endTime as string,
        $select: EVENT_SELECT_FIELDS,
      });
      url = `/me/calendarView/delta?${params.toString()}`;
    }
    const page = await this.client.getDeltaPages<GraphCalendarEvent>(url, request.signal);
    const events: NormalizedCalendarEvent[] = [];
    const deletions: CalendarEventDeletion[] = [];
    for (const raw of page.values) {
      assertNotAborted(request.signal);
      const removedReason = parseRemovedReason(raw);
      if (removedReason !== undefined) {
        const externalEventId = raw.id?.trim();
        if (externalEventId !== undefined && externalEventId.length > 0) {
          deletions.push({
            provider: "MICROSOFT_GRAPH",
            externalEventId,
            reason: removedReason === "deleted" ? "deleted" : "changed",
          });
        }
        continue;
      }
      events.push(normalizeGraphCalendarEvent(raw));
    }
    return {
      events,
      deletions,
      nextDeltaLink: page.deltaLink ?? "",
    };
  }
}

/** Microsoft Graph delta errors that mean the stored cursor is no longer usable. */
export function isStaleGraphDeltaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: unknown }).status;
  return (typeof code === "string" && STALE_DELTA_ERROR_CODES.has(code)) || status === 410;
}

function parseRemovedReason(raw: GraphCalendarEvent): "deleted" | "changed" | undefined {
  const removed = (raw as GraphCalendarEvent & { "@removed"?: { reason?: string } })["@removed"];
  const reason = removed?.reason?.trim().toLowerCase();
  if (reason === "deleted") {
    return "deleted";
  }
  if (reason === "changed") {
    return "changed";
  }
  return undefined;
}

function assertValidRange(startTime: string | undefined, endTime: string | undefined): void {
  if (startTime === undefined || endTime === undefined) {
    throw new Error("A calendar delta window (startTime and endTime) is required for the first synchronization.");
  }
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Calendar delta synchronization requires a valid start/end time range.");
  }
}
