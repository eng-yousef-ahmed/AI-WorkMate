import { createHash } from "node:crypto";

import type {
  CalendarEventAssociation,
  CalendarEventAttendee,
  CalendarEventPerson,
  CalendarOnlineMeetingInfo,
  CalendarProvider,
  MeetingPlatform,
} from "../domain/models";

export interface NormalizedCalendarEvent {
  provider: CalendarProvider;
  externalEventId: string;
  subject: string;
  startTime: string;
  endTime: string;
  organizer?: CalendarEventPerson;
  attendees: CalendarEventAttendee[];
  location?: string;
  onlineMeeting?: CalendarOnlineMeetingInfo;
  webUrl?: string;
  isCancelled: boolean;
  lastModifiedAt?: string;
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

export interface CalendarEventProvider {
  listEvents(request: CalendarEventListRequest): Promise<NormalizedCalendarEvent[]>;
  getEventById(request: CalendarEventLookupRequest): Promise<NormalizedCalendarEvent>;
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
    externalEventId: event.externalEventId,
    subject: event.subject,
    startTime: event.startTime,
    endTime: event.endTime,
    organizer: event.organizer,
    attendees: event.attendees,
    location: event.location,
    onlineMeeting: event.onlineMeeting,
    webUrl: event.webUrl,
    isCancelled: event.isCancelled,
    lastModifiedAt: event.lastModifiedAt,
    meetingPlatform: event.meetingPlatform,
  })).digest("hex");
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
