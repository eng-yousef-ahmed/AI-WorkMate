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
  /** FULL = windowed fetch; DELTA = incremental from the stored cursor. */
  mode?: "FULL" | "DELTA";
  /** Meetings cancelled because their calendar event was deleted. */
  deletedCount?: number;
  /** Events reported as moved outside the sync window (informational). */
  movedOutCount?: number;
  /** True when the incremental cursor was persisted for the next run. */
  deltaCursorAdvanced?: boolean;
  /** True when the stored delta cursor expired and a full sync is required. */
  staleCursorDetected?: boolean;
}

/**
 * Opaque provider-issued incremental-sync cursor plus the sync window it was
 * created for. Persisted locally in SQLite (it is a capability token, never a
 * credential). Deterministic upserts make re-delivery after a crash safe.
 */
export interface CalendarSyncStateRecord {
  provider: CalendarProvider;
  deltaCursor?: string;
  syncWindowStart?: string;
  syncWindowEnd?: string;
  lastFullSyncAt?: string;
  lastDeltaSyncAt?: string;
  updatedAt: string;
}

export type CalendarEventDeletionReason = "deleted" | "changed";

export interface CalendarEventDeletion {
  provider: CalendarProvider;
  externalEventId: string;
  reason: CalendarEventDeletionReason;
}

export interface CalendarDeltaRequest {
  /** Opaque cursor from the previous sync; absent for the first full fetch. */
  deltaLink?: string;
  /** Window required when no cursor is present yet. */
  startTime?: string;
  endTime?: string;
  signal?: AbortSignal;
}

export interface CalendarDeltaResult {
  /** Added/updated events (cancelled events arrive here with isCancelled). */
  events: NormalizedCalendarEvent[];
  /** Events hard-deleted or moved out of the window by the provider. */
  deletions: CalendarEventDeletion[];
  /** Opaque cursor for the next incremental sync ("" when not available). */
  nextDeltaLink: string;
}

/** Optional capability: providers that support incremental (delta) sync. */
export interface CalendarDeltaProvider {
  getDelta(request: CalendarDeltaRequest): Promise<CalendarDeltaResult>;
}

export function isCalendarDeltaProvider(provider: CalendarEventProvider): provider is CalendarEventProvider & CalendarDeltaProvider {
  return "getDelta" in provider && typeof provider.getDelta === "function";
}

export interface RendererCalendarSyncResult {
  provider: CalendarProvider;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  cancelledCount: number;
  errorCount: number;
  errors: Array<{ code: string; retryable: boolean; status?: number }>;
  mode?: "FULL" | "DELTA";
  deletedCount?: number;
  movedOutCount?: number;
  deltaCursorAdvanced?: boolean;
  staleCursorDetected?: boolean;
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
  const safe: RendererCalendarSyncResult = {
    provider: result.provider,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    unchangedCount: result.unchangedCount,
    cancelledCount: result.cancelledCount,
    errorCount: result.errorCount,
    errors: result.errors.map((error) => {
      const safeError: { code: string; retryable: boolean; status?: number } = {
        code: error.code,
        retryable: error.retryable,
      };
      if (error.status !== undefined) {
        safeError.status = error.status;
      }
      return safeError;
    }),
  };
  // Renderer-safe scalars only: never cursors, tokens, or URLs.
  if (result.mode !== undefined) safe.mode = result.mode;
  if (result.deletedCount !== undefined) safe.deletedCount = result.deletedCount;
  if (result.movedOutCount !== undefined) safe.movedOutCount = result.movedOutCount;
  if (result.deltaCursorAdvanced !== undefined) safe.deltaCursorAdvanced = result.deltaCursorAdvanced;
  if (result.staleCursorDetected !== undefined) safe.staleCursorDetected = result.staleCursorDetected;
  return safe;
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
