import type { MeetingPlatform } from "../domain/models";
import type { NormalizedCalendarEvent } from "./CalendarModels";

const TEAM_PROVIDER_VALUES = new Set(["teamsforbusiness", "microsoftteams", "teams"]);
const NON_TEAMS_ONLINE_PROVIDER_VALUES = new Set(["skypeforbusiness", "skypeforconsumer"]);

export function detectMeetingPlatform(event: NormalizedCalendarEvent): MeetingPlatform {
  const provider = normalize(event.onlineMeeting?.provider);
  const joinUrl = event.onlineMeeting?.joinUrl ?? "";
  const webUrl = event.webUrl ?? "";
  const location = event.location ?? "";

  if (provider !== undefined && TEAM_PROVIDER_VALUES.has(provider)) {
    return "TEAMS";
  }
  if (isTeamsUrl(joinUrl) || isTeamsUrl(webUrl) || hasTeamsLocationSignal(location)) {
    return "TEAMS";
  }
  if (
    event.onlineMeeting !== undefined ||
    (provider !== undefined && (provider !== "unknown" || NON_TEAMS_ONLINE_PROVIDER_VALUES.has(provider))) ||
    hasNonTeamsOnlineUrl(joinUrl) ||
    hasNonTeamsOnlineUrl(webUrl)
  ) {
    return "OTHER_ONLINE";
  }
  return "NONE";
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return normalized === "" ? undefined : normalized;
}

function isTeamsUrl(value: string): boolean {
  const parsed = safeUrl(value);
  if (parsed === undefined) {
    return value.toLowerCase().includes("teams.microsoft.com/") || value.toLowerCase().includes("teams.live.com/");
  }
  const host = parsed.hostname.toLowerCase();
  return (
    host === "teams.microsoft.com" ||
    host.endsWith(".teams.microsoft.com") ||
    host === "teams.live.com" ||
    host.endsWith(".teams.live.com") ||
    host === "teams.microsoft.us" ||
    host.endsWith(".teams.microsoft.us")
  );
}

function hasTeamsLocationSignal(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("microsoft teams meeting") || normalized.trim() === "microsoft teams";
}

function hasNonTeamsOnlineUrl(value: string): boolean {
  const parsed = safeUrl(value);
  if (parsed === undefined) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host.includes("zoom.us") || host.includes("webex.com") || host.includes("meet.google.com") || host.includes("gotomeeting.com");
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
