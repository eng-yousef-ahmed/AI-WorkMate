import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { StorageError } from "../storage/errors";
import type {
  HubAssistChecklistItem,
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubMeetingAssistPlan,
  HubMeetingPlatformKind,
} from "../domain/hub";

/**
 * Human-readable platform labels used only for display; never rendered as
 * URLs or paths.
 */
export const PLATFORM_KIND_LABELS: Record<HubMeetingPlatformKind, string> = {
  TEAMS: "Microsoft Teams",
  ZOOM: "Zoom",
  GOOGLE_MEET: "Google Meet",
  OTHER_ONLINE: "Online meeting",
  NONE: "In person / no online link",
};

/**
 * Classifies the online-meeting platform from the PERSISTED calendar join /
 * web URLs of a meeting. The renderer never supplies URLs; classification
 * happens here from stored provider data only.
 */
export function classifyOnlinePlatform(joinUrl?: string, webUrl?: string): HubMeetingPlatformKind {
  const candidates = [joinUrl, webUrl].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (candidates.length === 0) {
    return "NONE";
  }
  let sawRealUrl = false;
  for (const url of candidates) {
    if (isTeamsAddress(url)) return "TEAMS";
    if (isZoomAddress(url)) return "ZOOM";
    if (isGoogleMeetAddress(url)) return "GOOGLE_MEET";
    // Only genuine http(s) addresses count as an online meeting; stray text
    // that matches no known platform is not treated as a meeting link.
    if (safeHost(url) !== undefined) sawRealUrl = true;
  }
  return sawRealUrl ? "OTHER_ONLINE" : "NONE";
}

function isTeamsAddress(value: string): boolean {
  const host = safeHost(value);
  if (host !== undefined) {
    return (
      host === "teams.microsoft.com" ||
      host.endsWith(".teams.microsoft.com") ||
      host === "teams.live.com" ||
      host.endsWith(".teams.live.com") ||
      host === "teams.microsoft.us" ||
      host.endsWith(".teams.microsoft.us")
    );
  }
  const lowered = value.toLowerCase();
  return lowered.includes("teams.microsoft.com/") || lowered.includes("teams.live.com/");
}

function isZoomAddress(value: string): boolean {
  const host = safeHost(value);
  if (host !== undefined) {
    return host === "zoom.us" || host.endsWith(".zoom.us") ||
      host === "zoom.com" || host.endsWith(".zoom.com") ||
      host === "zoomgov.com" || host.endsWith(".zoomgov.com");
  }
  const lowered = value.toLowerCase();
  return lowered.includes("zoom.us/") || lowered.includes("zoom.com/") || lowered.includes("zoomgov.com/");
}

function isGoogleMeetAddress(value: string): boolean {
  const host = safeHost(value);
  if (host === "meet.google.com" || (host !== undefined && host.endsWith(".google.com"))) {
    const lowered = value.toLowerCase();
    if (host === "meet.google.com") return true;
    return lowered.includes("meet.google.com/") || lowered.includes("/meet/");
  }
  const lowered = value.toLowerCase();
  return lowered.includes("meet.google.com/");
}

function safeHost(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Assisted meeting flows: turns a calendar-linked meeting plus the locally
 * discovered capture capabilities into a platform-aware capture plan and a
 * user checklist. Everything is renderer-safe (no URLs, paths, window ids,
 * or capability internals cross the boundary — `window: ""` selects the
 * native deterministic window default).
 */
export class MeetingAssistService {
  private readonly store: LocalFirstStore;

  public constructor(dependencies: { store: LocalFirstStore }) {
    this.store = dependencies.store;
  }

  public plan(meetingId: string, capabilities: HubCaptureCapabilities): HubMeetingAssistPlan {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new StorageError(`Meeting not found: ${meetingId}`);
    }
    const association = this.store.database.listCalendarEventAssociations(meetingId)[0];
    const kind = classifyOnlinePlatform(association?.onlineMeeting?.joinUrl, association?.webUrl);
    const label = PLATFORM_KIND_LABELS[kind];
    const isVirtual = kind !== "NONE";
    const captureSupported = capabilities.supported === true && (
      capabilities.microphone || capabilities.systemLoopback || capabilities.screen || capabilities.window
    );

    const recommended: HubCaptureRequest = {
      meetingId,
      microphone: false,
      systemLoopback: false,
      screen: false,
    };
    const rationale: string[] = [];
    if (kind !== "NONE") {
      rationale.push(`This meeting links to ${label}.`);
    } else {
      rationale.push("No online meeting link is stored for this meeting.");
    }

    if (!captureSupported) {
      rationale.push("Meeting capture is not available on this computer right now.");
    } else if (isVirtual) {
      // Remote meeting: the meeting's own audio is the primary signal; the
      // microphone stays OFF by default so speakers are not double-recorded.
      if (capabilities.systemLoopback) {
        recommended.systemLoopback = true;
        rationale.push("Meeting audio is captured from your computer (system audio), so your voice reaches the meeting cleanly.");
      } else if (capabilities.microphone) {
        recommended.microphone = true;
        rationale.push("System audio capture is not available — the microphone will capture near-speaker audio instead.");
      }
      if (capabilities.window) {
        recommended.window = "";
        rationale.push("A dedicated meeting window is captured on its own (no full-screen recording); keep the meeting window focused during the call.");
      } else if (capabilities.screen) {
        recommended.screen = true;
        rationale.push("Your screen is captured so shared content is recorded.");
      } else {
        rationale.push("No window or screen capture is available — shared slides will not be recorded.");
      }
      if (capabilities.microphone) {
        rationale.push("Add your microphone only if you speak and want your own voice recorded separately.");
      }
    } else if (capabilities.microphone) {
      // No online link (in-person/phone meeting): room audio via microphone.
      recommended.microphone = true;
      rationale.push("Capturing room audio through the microphone.");
    } else {
      rationale.push("No usable capture source is available for an in-person meeting.");
    }

    const checklist: HubAssistChecklistItem[] = [
      {
        id: "join",
        title: "Join the meeting",
        ...(kind === "NONE"
          ? { note: "Join the meeting in person or by phone — recording starts when you are ready." }
          : association?.onlineMeeting?.joinUrl === undefined
            ? { note: "Open your meeting app or dial in, then come back here." }
            : { note: "Use “Join meeting” above — the stored link opens in your browser." }),
      },
      {
        id: "sources",
        title: "Capture sources",
        note: sourceLabels(recommended, label),
      },
      {
        id: "start",
        title: "Start the assisted capture",
        note: captureSupported
          ? "Recording starts only when you click the button; everything stays on this device."
          : "Capture is unavailable right now — you can still join and take notes.",
      },
      {
        id: "stop",
        title: "Stop when the meeting ends",
        note: "Stop recording from the meeting header, then transcribe and analyze locally.",
      },
    ];
    if (!captureSupported && isVirtual) {
      checklist[0]!.note = "Capture is unavailable, so join as usual and note anything you need manually.";
    }

    return {
      meetingId: meeting.meetingId,
      meetingTitle: meeting.title,
      meetingDate: meeting.meetingDate,
      platform: kind,
      platformLabel: label,
      captureSupported,
      joinLinkAvailable: association?.onlineMeeting?.joinUrl !== undefined,
      recommended,
      rationale,
      checklist,
    };
  }
}

function sourceLabels(request: HubCaptureRequest, platformLabel: string): string {
  if (!request.microphone && !request.systemLoopback && !request.screen && request.window === undefined) {
    return "No capture source is enabled for this plan.";
  }
  const parts: string[] = [];
  if (request.systemLoopback) parts.push("system audio");
  if (request.microphone) parts.push("microphone");
  if (request.window !== undefined) parts.push("meeting window (auto-selected)");
  if (request.screen) parts.push("screen");
  const scope = parts.length === 1 ? parts[0]! : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]!;
  return `${scope} will be recorded locally during ${platformLabel}.`;
}
