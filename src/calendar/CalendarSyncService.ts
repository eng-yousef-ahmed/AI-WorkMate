import type { CalendarProvider } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { MicrosoftGraphError } from "../integrations/microsoft/MicrosoftGraphClient";
import {
  assertNotAborted,
  type CalendarEventProvider,
  type CalendarMeetingUpsertResult,
  type CalendarSyncErrorInfo,
  type CalendarSyncRange,
  type CalendarSyncResult,
  type NormalizedCalendarEvent,
  withCalendarFingerprint,
} from "./CalendarModels";
import { detectMeetingPlatform } from "./MeetingPlatformDetector";

export class CalendarSyncService {
  public constructor(
    private readonly provider: CalendarEventProvider,
    private readonly store: LocalFirstStore,
    private readonly providerId: CalendarProvider = "MICROSOFT_GRAPH",
  ) {}

  public async syncRange(range: CalendarSyncRange): Promise<CalendarSyncResult> {
    assertValidRange(range.startTime, range.endTime);
    const result = emptyResult(this.providerId, range.startTime, range.endTime);
    let events: NormalizedCalendarEvent[];
    try {
      assertNotAborted(range.signal);
      events = await this.provider.listEvents({
        startTime: range.startTime,
        endTime: range.endTime,
        signal: range.signal,
      });
      assertNotAborted(range.signal);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      result.errors.push(calendarErrorFromUnknown(error, this.providerId));
      result.errorCount = result.errors.length;
      return result;
    }

    for (const event of events) {
      assertNotAborted(range.signal);
      const meetingPlatform = detectMeetingPlatform(event);
      const normalized = withCalendarFingerprint(event, meetingPlatform);
      if (normalized.isCancelled) {
        result.cancelledCount += 1;
      }
      try {
        const upsert = await this.store.upsertCalendarMeeting(normalized);
        applyUpsertResult(result, upsert);
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        result.errors.push(calendarErrorFromUnknown(error, this.providerId, normalized.externalEventId));
      }
    }
    result.errorCount = result.errors.length;
    return result;
  }
}

function applyUpsertResult(result: CalendarSyncResult, upsert: CalendarMeetingUpsertResult): void {
  switch (upsert.action) {
    case "CREATED":
      result.createdCount += 1;
      break;
    case "UPDATED":
      result.updatedCount += 1;
      break;
    case "UNCHANGED":
      result.unchangedCount += 1;
      break;
    case "CANCELLED_SKIPPED":
      break;
  }
}

function emptyResult(provider: CalendarProvider, startTime: string, endTime: string): CalendarSyncResult {
  return {
    provider,
    startTime,
    endTime,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    cancelledCount: 0,
    errorCount: 0,
    errors: [],
  };
}

function calendarErrorFromUnknown(error: unknown, provider: CalendarProvider, externalEventId?: string): CalendarSyncErrorInfo {
  if (error instanceof MicrosoftGraphError) {
    const info: CalendarSyncErrorInfo = {
      provider,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
    if (error.status !== undefined) {
      info.status = error.status;
    }
    if (externalEventId !== undefined) {
      info.externalEventId = externalEventId;
    }
    return info;
  }
  const info: CalendarSyncErrorInfo = {
    provider,
    code: "CALENDAR_SYNC_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
  if (externalEventId !== undefined) {
    info.externalEventId = externalEventId;
  }
  return info;
}

function assertValidRange(startTime: string, endTime: string): void {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Calendar synchronization requires a valid start/end time range.");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
