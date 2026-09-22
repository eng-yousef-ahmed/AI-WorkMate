import type { CalendarEventAssociation } from "../domain/models";
import type { HubAssistedJoinPlan, HubJoinPlatform } from "../domain/hub";

const MAX_URL_LENGTH = 8192;

/**
 * Builds an assisted join workflow for Teams / Zoom / Google Meet.
 *
 * Unattended joining is not attempted: AI WorkMate never fills credentials,
 * never solves CAPTCHA, and never bypasses platform security. The official
 * join URL is opened in the user's browser; recording stays a separate,
 * explicit local action.
 */
export function classifyJoinPlatform(url: string | undefined): HubJoinPlatform {
  if (url === undefined || url.trim().length === 0) {
    return "NONE";
  }
  const parsed = safeHttpUrl(url);
  if (parsed === undefined) {
    return "NONE";
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "teams.microsoft.com" ||
    host.endsWith(".teams.microsoft.com") ||
    host === "teams.live.com" ||
    host.endsWith(".teams.live.com") ||
    host === "teams.microsoft.us" ||
    host.endsWith(".teams.microsoft.us")
  ) {
    return "TEAMS";
  }
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    return "ZOOM";
  }
  if (host === "meet.google.com" || host.endsWith(".meet.google.com")) {
    return "GOOGLE_MEET";
  }
  return "OTHER_ONLINE";
}

export function buildAssistedJoinPlan(input: {
  meetingId: string;
  meetingTitle: string;
  association?: CalendarEventAssociation;
}): HubAssistedJoinPlan {
  const joinUrl = input.association?.onlineMeeting?.joinUrl;
  const platform = classifyJoinPlatform(joinUrl);
  const hasJoinUrl = joinUrl !== undefined && safeHttpUrl(joinUrl) !== undefined;
  const platformLabel = platformLabelFor(platform);
  const warnings = [
    "AI WorkMate never signs in for you, never solves CAPTCHA, and never bypasses meeting lobby or security controls.",
    "Recording is local (microphone and system audio). Start it only after you have joined.",
  ];
  if (input.association?.isCancelled === true) {
    return {
      meetingId: input.meetingId,
      meetingTitle: input.meetingTitle,
      platform,
      platformLabel,
      hasJoinUrl: false,
      nextAction: "UNAVAILABLE",
      steps: ["This calendar event is cancelled. There is nothing to join."],
      warnings,
    };
  }
  if (!hasJoinUrl) {
    return {
      meetingId: input.meetingId,
      meetingTitle: input.meetingTitle,
      platform: "NONE",
      platformLabel: platformLabelFor("NONE"),
      hasJoinUrl: false,
      nextAction: "RECORD_ONLY",
      steps: [
        "This meeting has no online join link.",
        "If it is an in-person or already-open call, start a local recording from AI WorkMate when you are ready.",
      ],
      warnings,
    };
  }
  return {
    meetingId: input.meetingId,
    meetingTitle: input.meetingTitle,
    platform,
    platformLabel,
    hasJoinUrl: true,
    nextAction: "OPEN_JOIN_URL",
    steps: stepsFor(platform, platformLabel),
    warnings,
  };
}

function stepsFor(platform: HubJoinPlatform, platformLabel: string): string[] {
  const opener = platform === "OTHER_ONLINE"
    ? "AI WorkMate will open the official meeting link in your browser."
    : `AI WorkMate will open the official ${platformLabel} join link in your browser.`;
  return [
    opener,
    `Sign in to ${platformLabel} yourself if the platform asks. AI WorkMate does not enter passwords or complete MFA.`,
    "Admit yourself from the lobby if the host requires it.",
    "After you can hear the meeting, return to AI WorkMate and start a local recording (microphone + system audio).",
  ];
}

function platformLabelFor(platform: HubJoinPlatform): string {
  switch (platform) {
    case "TEAMS": return "Microsoft Teams";
    case "ZOOM": return "Zoom";
    case "GOOGLE_MEET": return "Google Meet";
    case "OTHER_ONLINE": return "online meeting";
    case "NONE": return "no online meeting";
  }
}

function safeHttpUrl(value: string): URL | undefined {
  if (value.length > MAX_URL_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return undefined;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return undefined;
  }
  return url;
}
