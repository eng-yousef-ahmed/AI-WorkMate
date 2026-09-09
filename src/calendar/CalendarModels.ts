import { createHash } from "node:crypto";

import type {
  CalendarEventAssociation,
  CalendarEventAttendee,
  CalendarEventPerson,
  CalendarOnlineMeetingInfo,
  CalendarProvider,
  CalendarSyncMetadata,
  MeetingPlatform,
} from "../domain/models";

export interface NormalizedCalendarEvent {
  provider: CalendarProvider;
  /** Non-secret account identity scoping this event; undefined means unknown/legacy single-account. */
  accountId?: string;
  /** Optional non-secret calendar identifier within the account. */
  calendarId?: string;
  externalEventId: string;
  subject: string;
  startTime: string;
  endTime: string;
  /** Source timezone label as given by the provider when non-UTC; UTC is encoded by the ISO `Z` form. */
  startTimeZone?: string;
  endTimeZone?: string;
  organizer?: CalendarEventPerson;
  attendees: CalendarEventAttendee[];
  location?: string;
  onlineMeeting?: CalendarOnlineMeetingInfo;
  webUrl?: string;
  description?: string;
  /** Provider-native event status verbatim; `isCancelled` stays authoritative. */
  status?: string;
  isCancelled: boolean;
  lastModifiedAt?: string;
  syncMetadata?: CalendarSyncMetadata;
  meetingPlatform?: MeetingPlatform;
  normalizedFingerprint?: string;
}

export interface CalendarEventListRequest {
  startTime: string;
  endTime: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface CalendarEventLookupRequest {
  externalEventId: string;
  signal?: AbortSignal;
}

export interface CalendarDeltaRequest {
  syncToken: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface CalendarDeltaPage {
  events: NormalizedCalendarEvent[];
  nextSyncToken?: string;
  hasMore: boolean;
}

export interface CalendarEventProvider {
  /** Provider identity; when absent the sync service falls back to its configured provider. */
  readonly providerId?: CalendarProvider;
  /** Non-secret account identity when the provider is bound to one account; otherwise undefined. */
  readonly accountId?: string;
  listEvents(request: CalendarEventListRequest): Promise<NormalizedCalendarEvent[]>;
  getEventById(request: CalendarEventLookupRequest): Promise<NormalizedCalendarEvent>;
  /**
   * Phase 10B seam for incremental/delta synchronization. Providers that do
   * not implement it return full-range results via listEvents only.
   */
  listChangedEvents?(request: CalendarDeltaRequest): Promise<CalendarDeltaPage>;
}

export interface CalendarSyncRange {
  startTime: string;
  endTime: string;
  signal?: AbortSignal;
}

export interface CalendarSyncErrorInfo {
  provider: CalendarProvider;
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  externalEventId?: string;
}

export interface CalendarSyncResult {
  provider: CalendarProvider;
  startTime: string;
  endTime: string;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  cancelledCount: number;
  errorCount: number;
  errors: CalendarSyncErrorInfo[];
}

export interface RendererCalendarSyncResult {
  provider: CalendarProvider;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  cancelledCount: number;
  errorCount: number;
  errors: Array<{ code: string; retryable: boolean; status?: number }>;
}

export type CalendarMeetingUpsertAction = "CREATED" | "UPDATED" | "UNCHANGED" | "CANCELLED_SKIPPED";

export interface CalendarMeetingUpsertResult {
  action: CalendarMeetingUpsertAction;
  meetingId?: string;
  association?: CalendarEventAssociation;
}

export function withCalendarFingerprint(
  event: NormalizedCalendarEvent,
  meetingPlatform: MeetingPlatform,
): NormalizedCalendarEvent & { meetingPlatform: MeetingPlatform; normalizedFingerprint: string } {
  const normalized: NormalizedCalendarEvent & { meetingPlatform: MeetingPlatform } = {
    ...event,
    meetingPlatform,
  };
  return {
    ...normalized,
    normalizedFingerprint: createCalendarEventFingerprint(normalized),
  };
}

export function createCalendarEventFingerprint(event: NormalizedCalendarEvent): string {
  return createHash("sha256").update(stableStringify({
    provider: event.provider,
    accountId: event.accountId,
    calendarId: event.calendarId,
    externalEventId: event.externalEventId,
    subject: event.subject,
    startTime: event.startTime,
    endTime: event.endTime,
    startTimeZone: event.startTimeZone,
    endTimeZone: event.endTimeZone,
    organizer: event.organizer,
    attendees: event.attendees,
    location: event.location,
    onlineMeeting: event.onlineMeeting,
    webUrl: event.webUrl,
    description: event.description,
    status: event.status,
    isCancelled: event.isCancelled,
    lastModifiedAt: event.lastModifiedAt,
    // Only the stable iCalUId participates in change detection; volatile
    // provider sync state (etag, syncToken) must never flip UPDATED on its own.
    iCalUId: event.syncMetadata?.iCalUId,
    meetingPlatform: event.meetingPlatform,
  })).digest("hex");
}

/**
 * Stable internal calendar-event ID, deterministic from the natural sync key
 * (provider + account + external event ID). The same event synchronized
 * repeatedly — or re-synchronized after a database rebuild — always resolves
 * to the same ID, so updates retain identity without a lookup table.
 */
export function calendarEventAssociationId(provider: CalendarProvider, accountId: string, externalEventId: string): string {
  return createHash("sha256").update(`calendar-event-v1:${provider}|${accountId}|${externalEventId}`).digest("hex");
}

/**
 * Deterministic attendee deduplication. Providers may repeat attendees across
 * pages or instances; dedupe by lowercase email when present, otherwise by
 * display name, keeping the first occurrence and the original order.
 */
export function deduplicateCalendarAttendees(attendees: CalendarEventAttendee[]): CalendarEventAttendee[] {
  const seen = new Set<string>();
  const deduplicated: CalendarEventAttendee[] = [];
  for (const attendee of attendees) {
    const email = attendee.email?.trim().toLowerCase();
    const name = attendee.displayName?.trim().toLowerCase();
    const key = email !== undefined && email.length > 0 ? `email:${email}` : `name:${name ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push(attendee);
  }
  return deduplicated;
}

export function toRendererCalendarSyncResult(result: CalendarSyncResult): RendererCalendarSyncResult {
  return {
    provider: result.provider,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    unchangedCount: result.unchangedCount,
    cancelledCount: result.cancelledCount,
    errorCount: result.errorCount,
    errors: result.errors.map((error) => {
      const safe: { code: string; retryable: boolean; status?: number } = {
        code: error.code,
        retryable: error.retryable,
      };
      if (error.status !== undefined) {
        safe.status = error.status;
      }
      return safe;
    }),
  };
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createAbortError();
  }
}

export function createAbortError(): Error {
  const error = new Error("Calendar synchronization was cancelled.");
  error.name = "AbortError";
  return error;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
