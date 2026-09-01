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
import type { MicrosoftGraphClient } from "./MicrosoftGraphClient";

export interface GraphDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphAttendee extends GraphRecipient {
  type?: string;
  status?: {
    response?: string;
    time?: string;
  };
}

export interface GraphLocation {
  displayName?: string;
}

export interface GraphOnlineMeeting {
  joinUrl?: string;
  conferenceId?: string;
  tollNumber?: string;
}

export interface GraphCalendarEvent {
  id?: string;
  iCalUId?: string;
  subject?: string;
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  organizer?: GraphRecipient;
  attendees?: GraphAttendee[];
  location?: GraphLocation;
  locations?: GraphLocation[];
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeeting?: GraphOnlineMeeting | null;
  webLink?: string;
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
}

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

/** Calendar provider boundary for Microsoft Graph. It returns normalized events only. */
export class MicrosoftGraphCalendarProvider implements CalendarEventProvider {
  public constructor(private readonly client: MicrosoftGraphClient) {}

  public async listEvents(request: CalendarEventListRequest): Promise<NormalizedCalendarEvent[]> {
    assertValidRange(request.startTime, request.endTime);
    assertNotAborted(request.signal);
    const pageSize = request.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 999) {
      throw new Error("Microsoft Graph calendar pageSize must be between 1 and 999.");
    }
    const params = new URLSearchParams({
      startDateTime: request.startTime,
      endDateTime: request.endTime,
      $top: String(pageSize),
      $select: EVENT_SELECT_FIELDS,
    });
    const events = await this.client.getAllPages<GraphCalendarEvent>(`/me/calendarView?${params.toString()}`, request.signal);
    return events.map((event) => normalizeGraphCalendarEvent(event));
  }

  public async getEventById(request: CalendarEventLookupRequest): Promise<NormalizedCalendarEvent> {
    if (request.externalEventId.trim().length === 0) {
      throw new Error("A Microsoft Graph event ID is required.");
    }
    assertNotAborted(request.signal);
    const params = new URLSearchParams({ $select: EVENT_SELECT_FIELDS });
    const event = await this.client.getJson<GraphCalendarEvent>(
      `/me/events/${encodeURIComponent(request.externalEventId)}?${params.toString()}`,
      request.signal,
    );
    return normalizeGraphCalendarEvent(event);
  }
}

export function normalizeGraphCalendarEvent(event: GraphCalendarEvent): NormalizedCalendarEvent {
  const externalEventId = requiredString(event.id, "Microsoft Graph event is missing id.");
  const startTime = normalizeGraphDateTime(event.start, "start");
  const endTime = normalizeGraphDateTime(event.end, "end");
  const location = normalizeLocation(event.location, event.locations);
  const onlineMeeting = normalizeOnlineMeeting(event);
  const normalized: NormalizedCalendarEvent = {
    provider: "MICROSOFT_GRAPH",
    externalEventId,
    subject: normalizedSubject(event.subject),
    startTime,
    endTime,
    attendees: normalizeAttendees(event.attendees),
    isCancelled: event.isCancelled === true,
  };
  addOptional(normalized, "organizer", normalizePerson(event.organizer));
  addOptional(normalized, "location", location);
  addOptional(normalized, "onlineMeeting", onlineMeeting);
  addOptional(normalized, "webUrl", cleanString(event.webLink));
  addOptional(normalized, "lastModifiedAt", normalizeOptionalIsoDate(event.lastModifiedDateTime));
  return normalized;
}

function normalizeGraphDateTime(value: GraphDateTimeTimeZone | undefined, field: string): string {
  const dateTime = cleanString(value?.dateTime);
  if (dateTime === undefined) {
    throw new Error(`Microsoft Graph event is missing ${field} dateTime.`);
  }
  const timeZone = cleanString(value?.timeZone);
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(dateTime);
  const candidate = hasOffset ? dateTime : timeZone === undefined || timeZone.toUpperCase() === "UTC" ? `${dateTime}Z` : dateTime;
  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime()) && (hasOffset || timeZone === undefined || timeZone.toUpperCase() === "UTC")) {
    return parsed.toISOString();
  }
  return timeZone === undefined ? dateTime : `${dateTime} [${timeZone}]`;
}

function normalizeOptionalIsoDate(value: string | undefined): string | undefined {
  const clean = cleanString(value);
  if (clean === undefined) {
    return undefined;
  }
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? clean : parsed.toISOString();
}

function normalizedSubject(subject: string | undefined): string {
  const clean = cleanString(subject);
  return clean === undefined ? "Untitled meeting" : clean;
}

function normalizeAttendees(attendees: GraphAttendee[] | undefined): CalendarEventAttendee[] {
  if (attendees === undefined) {
    return [];
  }
  return attendees.map((attendee) => {
    const normalized: CalendarEventAttendee = {};
    const person = normalizePerson(attendee);
    addOptional(normalized, "displayName", person?.displayName);
    addOptional(normalized, "email", person?.email);
    addOptional(normalized, "type", cleanString(attendee.type));
    addOptional(normalized, "responseStatus", cleanString(attendee.status?.response));
    return normalized;
  });
}

function normalizePerson(recipient: GraphRecipient | undefined): CalendarEventPerson | undefined {
  const displayName = cleanString(recipient?.emailAddress?.name);
  const email = cleanString(recipient?.emailAddress?.address)?.toLowerCase();
  if (displayName === undefined && email === undefined) {
    return undefined;
  }
  const person: CalendarEventPerson = {};
  addOptional(person, "displayName", displayName);
  addOptional(person, "email", email);
  return person;
}

function normalizeLocation(location: GraphLocation | undefined, locations: GraphLocation[] | undefined): string | undefined {
  const primary = cleanString(location?.displayName);
  if (primary !== undefined) {
    return primary;
  }
  const first = locations?.map((entry) => cleanString(entry.displayName)).find((entry) => entry !== undefined);
  return first;
}

function normalizeOnlineMeeting(event: GraphCalendarEvent): CalendarOnlineMeetingInfo | undefined {
  const info = event.onlineMeeting ?? undefined;
  const provider = cleanString(event.onlineMeetingProvider);
  const joinUrl = cleanString(info?.joinUrl);
  const conferenceId = cleanString(info?.conferenceId);
  const tollNumber = cleanString(info?.tollNumber);
  if (event.isOnlineMeeting !== true && provider === undefined && joinUrl === undefined && conferenceId === undefined && tollNumber === undefined) {
    return undefined;
  }
  const onlineMeeting: CalendarOnlineMeetingInfo = {};
  addOptional(onlineMeeting, "provider", provider);
  addOptional(onlineMeeting, "joinUrl", joinUrl);
  addOptional(onlineMeeting, "conferenceId", conferenceId);
  addOptional(onlineMeeting, "tollNumber", tollNumber);
  return onlineMeeting;
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
