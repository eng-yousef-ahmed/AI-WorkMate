import type { CalendarProvider } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { MicrosoftGraphError } from "../integrations/microsoft/MicrosoftGraphClient";
import { GoogleApiError } from "../integrations/google/GoogleApiClient";
import {
  assertNotAborted,
  isCalendarDeltaProvider,
  type CalendarDeltaProvider,
  type CalendarDeltaResult,
  type CalendarEventProvider,
  type CalendarMeetingUpsertResult,
  type CalendarSyncErrorInfo,
  type CalendarSyncRange,
  type CalendarSyncResult,
  type CalendarSyncStateRecord,
  type NormalizedCalendarEvent,
  withCalendarFingerprint,
} from "./CalendarModels";
import { detectMeetingPlatform } from "./MeetingPlatformDetector";

/**
 * Calendar synchronization coordinator. Providers that support delta sync
 * (Microsoft Graph calendarView delta, Google Calendar syncToken) run a full
 * windowed fetch the first time and store the opaque provider cursor; later
 * syncs reuse the cursor while the requested range stays inside the stored
 * window. Deterministic local upserts make a repeated delta after a crash
 * safe: cursor persistence always happens after events are applied.
 *
 * A cursor rejected by the provider (expired/stale) triggers a self-healing
 * full re-sync of the requested window.
 */
export class CalendarSyncService {
  public constructor(
    private readonly provider: CalendarEventProvider,
    private readonly store: LocalFirstStore,
    private readonly providerId: CalendarProvider = "MICROSOFT_GRAPH",
  ) {}

  /**
   * Synchronizes a window, choosing the incremental delta path when a valid
   * cursor is stored and the window is covered, otherwise a full sync (which
   * renews the cursor).
   */
  public async syncCalendar(range: CalendarSyncRange): Promise<CalendarSyncResult> {
    assertValidRange(range.startTime, range.endTime);
    const provider = this.provider;
    if (!isCalendarDeltaProvider(provider)) {
      return this.syncRange(range);
    }
    const state = this.store.getCalendarSyncState(this.providerId);
    if (state?.deltaCursor !== undefined && state.syncWindowStart !== undefined && state.syncWindowEnd !== undefined &&
        coversRange(state, range)) {
      const result = emptyResult(this.providerId, range.startTime, range.endTime, "DELTA");
      try {
        assertNotAborted(range.signal);
        const delta = await provider.getDelta({ deltaLink: state.deltaCursor, signal: range.signal });
        await this.applyDeltaResult(delta, result, range.signal);
        // Advance the cursor only after every event/deletion was applied, so
        // an interrupted run re-delivers the same delta (idempotent upserts).
        const nextCursor = delta.nextDeltaLink.trim();
        this.store.saveCalendarSyncState(this.providerId, {
          deltaCursor: nextCursor.length > 0 ? nextCursor : null,
          lastDeltaSyncAt: this.store.nowIso(),
        });
        result.deltaCursorAdvanced = nextCursor.length > 0;
        return result;
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        if (isStaleCursorError(error)) {
          // Self-heal: drop the dead cursor and fall through to a full sync.
          result.staleCursorDetected = true;
          this.store.clearCalendarSyncState(this.providerId);
          return this.fullWindowSync(provider, range, result);
        }
        result.errors.push(calendarErrorFromUnknown(error, this.providerId));
        result.errorCount = result.errors.length;
        return result;
      }
    }
    return this.fullWindowSync(provider, range, emptyResult(this.providerId, range.startTime, range.endTime, "FULL"));
  }

  /** Legacy explicit full sync over a range (no delta cursor handling). */
  public async syncRange(range: CalendarSyncRange): Promise<CalendarSyncResult> {
    assertValidRange(range.startTime, range.endTime);
    const result = emptyResult(this.providerId, range.startTime, range.endTime, "FULL");
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
    await this.applyEvents(events, result, range.signal);
    result.errorCount = result.errors.length;
    return result;
  }

  private async fullWindowSync(
    provider: CalendarEventProvider & CalendarDeltaProvider,
    range: CalendarSyncRange,
    result: CalendarSyncResult,
  ): Promise<CalendarSyncResult> {
    let delta: CalendarDeltaResult;
    try {
      assertNotAborted(range.signal);
      // The provider fetches the full window AND returns the next cursor.
      delta = await provider.getDelta({
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
    await this.applyDeltaResult(delta, result, range.signal);
    // Replace the window + cursor after a complete full sync; the window the
    // cursor covers is exactly the range just fetched.
    const nextCursor = delta.nextDeltaLink.trim();
    const now = this.store.nowIso();
    this.store.saveCalendarSyncState(this.providerId, {
      deltaCursor: nextCursor.length > 0 ? nextCursor : null,
      syncWindowStart: range.startTime,
      syncWindowEnd: range.endTime,
      lastFullSyncAt: now,
    lastDeltaSyncAt: now,
    });
    result.deltaCursorAdvanced = nextCursor.length > 0;
    result.errorCount = result.errors.length;
    return result;
  }

  private async applyDeltaResult(
    delta: CalendarDeltaResult,
    result: CalendarSyncResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.applyEvents(delta.events, result, signal);
    for (const deletion of delta.deletions) {
      assertNotAborted(signal);
      try {
        const outcome = await this.store.applyCalendarEventDeletion(deletion);
        if (deletion.reason === "deleted" && outcome.cancelled) {
          result.deletedCount = (result.deletedCount ?? 0) + 1;
        } else if (deletion.reason === "changed" && outcome.existed) {
          result.movedOutCount = (result.movedOutCount ?? 0) + 1;
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        result.errors.push(calendarErrorFromUnknown(error, this.providerId, deletion.externalEventId));
      }
    }
  }

  private async applyEvents(
    events: NormalizedCalendarEvent[],
    result: CalendarSyncResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const event of events) {
      assertNotAborted(signal);
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
  }
}

export class CalendarDeltaCursorExpiredError extends Error {
  public constructor(public readonly provider: CalendarProvider, message: string) {
    super(message);
    this.name = "CalendarDeltaCursorExpiredError";
  }
}

export function isStaleCursorError(error: unknown): boolean {
  if (error instanceof CalendarDeltaCursorExpiredError) {
    return true;
  }
  if (typeof error === "object" && error !== null) {
    const typed = error as { code?: unknown; status?: unknown };
    const code = typeof typed.code === "string" ? typed.code : undefined;
    if ((code === "syncStateNotFound" || code === "SyncStateNotFound" || code === "deltaLinkNotFound" || code === "syncTokenInvalid") || typed.status === 410) {
      return true;
    }
  }
  return false;
}

function coversRange(state: CalendarSyncStateRecord, range: CalendarSyncRange): boolean {
  return new Date(state.syncWindowStart as string).getTime() <= new Date(range.startTime).getTime() &&
    new Date(state.syncWindowEnd as string).getTime() >= new Date(range.endTime).getTime();
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

function emptyResult(provider: CalendarProvider, startTime: string, endTime: string, mode: "FULL" | "DELTA"): CalendarSyncResult {
  return {
    provider,
    startTime,
    endTime,
    mode,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    cancelledCount: 0,
    errorCount: 0,
    errors: [],
  };
}

function calendarErrorFromUnknown(error: unknown, provider: CalendarProvider, externalEventId?: string): CalendarSyncErrorInfo {
  const apiError =
    error instanceof MicrosoftGraphError ? { code: error.code, message: error.message, retryable: error.retryable, status: error.status } :
    error instanceof GoogleApiError ? { code: error.code, message: error.message, retryable: error.retryable, status: error.status } :
    undefined;
  if (apiError !== undefined) {
    const info: CalendarSyncErrorInfo = {
      provider,
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
    };
    if (apiError.status !== undefined) {
      info.status = apiError.status;
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
