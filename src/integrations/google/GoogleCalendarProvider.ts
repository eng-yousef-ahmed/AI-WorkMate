import type {
  CalendarEventAttendee,
  CalendarEventPerson,
  CalendarOnlineMeetingInfo,
} from "../../domain/models";
import type {
  CalendarEventListRequest,
  CalendarEventLookupRequest,
  CalendarEventProvider,
  NormalizedCalendarEvent,
} from "../../calendar/CalendarModels";
import { assertNotAborted } from "../../calendar/CalendarModels";
import type { GoogleApiClient } from "./GoogleApiClient";
import { GOOGLE_CALENDAR_ID_PRIMARY } from "./GoogleAuth";

/**
 * Google Calendar API v3 provider boundary. It returns normalized events only
 * and never touches the network itself — the injected GoogleApiClient handles
 * auth, retries, and rate limiting. The primary calendar of the signed-in
 * account is synchronized; `timeZone=UTC` keeps event times unambiguous so
 * local persistence is deterministic regardless of the calendar's time zone.
 */

export interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEventAttendee {
  email?: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: string;
  comment?: string;
}

export interface GoogleEventCreatorOrganizer {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface GoogleConferenceEntryPoint {
  entryPointType?: string;
  uri?: string;
  label?: string;
  pin?: string;
  meetingCode?: string;
}

export interface GoogleConferenceData {
  conferenceId?: string;
  conferenceSolution?: { name?: string; key?: { type?: string } };
  entryPoints?: GoogleConferenceEntryPoint[];
  notes?: string;
}

export interface GoogleCalendarEvent {
  id?: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  creator?: GoogleEventCreatorOrganizer;
  organizer?: GoogleEventCreatorOrganizer;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleEventDateTime;
  transparency?: string;
  visibility?: string;
  iCalUID?: string;
  sequence?: number;
  attendees?: GoogleEventAttendee[];
  attendeesOmitted?: boolean;
  conferenceData?: GoogleConferenceData | null;
  privateCopy?: boolean;
  locked?: boolean;
  guestsCanModify?: boolean;
}

export interface GoogleEventsListResponse {
  kind?: string;
  etag?: string;
  summary?: string;
  description?: string;
  updated?: string;
  timeZone?: string;
  accessRole?: string;
  defaultReminders?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
  items?: GoogleCalendarEvent[];
}

export const GOOGLE_EVENT_FIELDS =
  "id,status,htmlLink,updated,summary,location,creator,organizer,start,end," +
  "recurrence,recurringEventId,originalStartTime,attendees,attendeesOmitted," +
  "conferenceData,conferenceData.conferenceId,conferenceData.conferenceSolution," +
  "conferenceData.entryPoints,transparency,visibility,iCalUID";

export const GOOGLE_EVENT_LIST_FIELDS = `items(${GOOGLE_EVENT_FIELDS}),nextPageToken,nextSyncToken,timeZone`;

/** Calendar provider boundary for Google Calendar API v3. */
export class GoogleCalendarProvider implements CalendarEventProvider {
  public constructor(
    private readonly client: GoogleApiClient,
    private readonly calendarId: string = GOOGLE_CALENDAR_ID_PRIMARY,
  ) {}

  public async listEvents(request: CalendarEventListRequest): Promise<NormalizedCalendarEvent[]> {
    assertValidRange(request.startTime, request.endTime);
    assertNotAborted(request.signal);
    const query = windowListQuery(request.startTime, request.endTime);
    const page = await this.fetchEventsPage(`/calendars/${encodeURIComponent(this.calendarId)}/events?${query}`, request.signal);
    return page.events;
  }

  public async getEventById(request: CalendarEventLookupRequest): Promise<NormalizedCalendarEvent> {
    const eventId = request.externalEventId.trim();
    if (eventId.length === 0) {
      throw new Error("A Google Calendar event ID is required.");
    }
    assertNotAborted(request.signal);
    const params = new URLSearchParams({ fields: GOOGLE_EVENT_FIELDS, timeZone: "UTC" });
    const event = await this.client.getJson<GoogleCalendarEvent>(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}?${params.toString()}`,
      request.signal,
    );
    return normalizeGoogleCalendarEvent(event);
  }

  /** Fetches every page of a windowed list query and normalizes each event. */
  public async fetchEventsPage(path: string, signal?: AbortSignal): Promise<{ events: NormalizedCalendarEvent[]; nextSyncToken?: string }> {
    const events: NormalizedCalendarEvent[] = [];
    let url: string | undefined = path;
    let syncToken: string | undefined;
    while (url !== undefined) {
      assertNotAborted(signal);
      const response = await this.client.getJson<GoogleEventsListResponse>(url, signal);
      const items = response.items;
      if (items !== undefined && !Array.isArray(items)) {
        throw new Error("The Google Calendar API returned a page with an invalid items collection.");
      }
      for (const raw of items ?? []) {
        events.push(normalizeGoogleCalendarEvent(raw));
      }
      const nextPageToken = response.nextPageToken;
      if (typeof nextPageToken === "string" && nextPageToken.length > 0) {
        url = addPageToken(path, nextPageToken);
      } else {
        url = undefined;
        if (typeof response.nextSyncToken === "string" && response.nextSyncToken.length > 0) {
          syncToken = response.nextSyncToken;
        }
      }
    }
    return { events, nextSyncToken: syncToken };
  }
}

export function normalizeGoogleCalendarEvent(event: GoogleCalendarEvent): NormalizedCalendarEvent {
  const externalEventId = requiredString(event.id, "A Google Calendar event is missing its id.");
  const status = normalizeStatus(event.status);
  const startTime = normalizeGoogleDateTime(event.start, "start");
  const endTime = normalizeGoogleDateTime(event.end, "end");
  const organizer = normalizePerson(event.organizer ?? event.creator);
  const onlineMeeting = normalizeConference(event.conferenceData);
  const normalized: NormalizedCalendarEvent = {
    provider: "GOOGLE_CALENDAR",
    externalEventId,
    subject: normalizedSummary(event.summary),
    startTime,
    endTime,
    organizer,
    attendees: normalizeAttendees(event.attendees),
    isCancelled: status === "cancelled",
  };
  addOptional(normalized, "location", cleanString(event.location));
  addOptional(normalized, "onlineMeeting", onlineMeeting);
  addOptional(normalized, "webUrl", cleanString(event.htmlLink));
  addOptional(normalized, "lastModifiedAt", normalizeOptionalIsoDate(event.updated));
  return normalized;
}

function windowListQuery(startTime: string, endTime: string): string {
  const params = new URLSearchParams({
    timeMin: new Date(startTime).toISOString(),
    timeMax: new Date(endTime).toISOString(),
    singleEvents: "true",
    showDeleted: "true",
    timeZone: "UTC",
    maxResults: "2500",
    fields: GOOGLE_EVENT_LIST_FIELDS,
    orderBy: "startTime",
  });
  return params.toString();
}

function addPageToken(path: string, pageToken: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}pageToken=${encodeURIComponent(pageToken)}`;
}

function normalizeGoogleDateTime(value: GoogleEventDateTime | undefined, field: string): string {
  const dateTime = cleanString(value?.dateTime);
  if (dateTime !== undefined) {
    const parsed = new Date(dateTime);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    // Some clients emit zone-less wall-clock times; the timeZone field of the
    // item or the response disambiguates them. Fall back to treating them as
    // UTC (the request pins timeZone=UTC) rather than storing an ambiguous
    // local time.
    if (value?.timeZone === undefined) {
      const utcCandidate = new Date(`${dateTime}Z`);
      if (!Number.isNaN(utcCandidate.getTime())) {
        return utcCandidate.toISOString();
      }
    }
    throw new Error(`A Google Calendar event is missing a parseable ${field} dateTime.`);
  }
  const date = cleanString(value?.date);
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // All-day events have no time component; pin them to UTC midnight so
    // ordering and windowing are deterministic.
    return `${date}T00:00:00.000Z`;
  }
  throw new Error(`A Google Calendar event is missing its ${field} dateTime.`);
}

function normalizeOptionalIsoDate(value: string | undefined): string | undefined {
  const clean = cleanString(value);
  if (clean === undefined) {
    return undefined;
  }
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? clean : parsed.toISOString();
}

function normalizeStatus(status: string | undefined): "confirmed" | "tentative" | "cancelled" {
  const clean = cleanString(status)?.toLowerCase();
  if (clean === "cancelled") {
    return "cancelled";
  }
  if (clean === "tentative") {
    return "tentative";
  }
  return "confirmed";
}

function normalizedSummary(summary: string | undefined): string {
  const clean = cleanString(summary);
  return clean === undefined ? "Untitled meeting" : clean;
}

function normalizeAttendees(attendees: GoogleEventAttendee[] | undefined): CalendarEventAttendee[] {
  if (attendees === undefined) {
    return [];
  }
  return attendees.map((attendee) => {
    const normalized: CalendarEventAttendee = {};
    addOptional(normalized, "displayName", cleanString(attendee.displayName));
    addOptional(normalized, "email", cleanString(attendee.email)?.toLowerCase());
    addOptional(normalized, "type", attendee.resource === true ? "resource" : attendee.optional === true ? "optional" : undefined);
    addOptional(normalized, "responseStatus", cleanString(attendee.responseStatus));
    return normalized;
  });
}

function normalizePerson(person: GoogleEventCreatorOrganizer | undefined): CalendarEventPerson | undefined {
  const displayName = cleanString(person?.displayName);
  const email = cleanString(person?.email)?.toLowerCase();
  if (displayName === undefined && email === undefined) {
    return undefined;
  }
  const normalized: CalendarEventPerson = {};
  addOptional(normalized, "displayName", displayName);
  addOptional(normalized, "email", email);
  return normalized;
}

function normalizeConference(data: GoogleConferenceData | null | undefined): CalendarOnlineMeetingInfo | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }
  const entryPoints = Array.isArray(data.entryPoints) ? data.entryPoints : [];
  const videoEntry = entryPoints.find((entry) => normalizeEntryPointType(entry.entryPointType) === "video");
  const phoneEntry = entryPoints.find((entry) => normalizeEntryPointType(entry.entryPointType) === "phone");
  const solutionName = cleanString(data.conferenceSolution?.name);
  if (videoEntry === undefined && phoneEntry === undefined && solutionName === undefined) {
    return undefined;
  }
  const meeting: CalendarOnlineMeetingInfo = {};
  addOptional(meeting, "provider", solutionName ?? (videoEntry !== undefined ? "Google Meet" : undefined));
  addOptional(meeting, "joinUrl", cleanString(videoEntry?.uri));
  addOptional(meeting, "conferenceId", cleanString(data.conferenceId) ?? cleanString(videoEntry?.meetingCode));
  if (phoneEntry !== undefined) {
    const tollNumber = cleanString(phoneEntry.uri ?? phoneEntry.label) ?? cleanString(phoneEntry.pin);
    addOptional(meeting, "tollNumber", tollNumber);
  }
  return meeting;
}

function normalizeEntryPointType(value: string | undefined): string | undefined {
  return cleanString(value)?.toLowerCase();
}

function cleanString(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean === undefined || clean.length === 0 ? undefined : clean;
}

function requiredString(value: string | undefined, message: string): string {
  const clean = cleanString(value);
  if (clean === undefined) {
    throw new Error(message);
  }
  return clean;
}

function assertValidRange(startTime: string, endTime: string): void {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Calendar synchronization requires a valid start/end time range.");
  }
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}
