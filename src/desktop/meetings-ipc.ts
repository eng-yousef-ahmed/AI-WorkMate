import { MEETINGS_IPC_CHANNELS } from "./storage-api";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import { MeetingHubError } from "../meetings/MeetingHubService";
import type { HubCaptureRequest } from "../domain/hub";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

export interface MeetingsIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
  /** Opens a validated external http(s) join/web URL in the user's browser. */
  openExternal: (url: string) => Promise<void>;
}

const MAX_MEETING_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 4096;

/**
 * Main-process Meeting Hub handlers. All payloads are produced by the hub
 * service from persisted local data; the renderer only ever supplies meeting
 * ids, transcript ids, capture capability toggles, and search text. External
 * join/web URLs are resolved from the persisted calendar association in this
 * process and never accepted from the renderer.
 */
export function registerMeetingsIpc({
  ipcMain,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
  openExternal,
}: MeetingsIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeMeetingsIpcError(error);
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  handle(MEETINGS_IPC_CHANNELS.getOverview, (): unknown => runtime.requireMeetingHub().getOverview());

  handle(MEETINGS_IPC_CHANNELS.getDetail, (_event: unknown, meetingId: unknown): unknown =>
    runtime.requireMeetingHub().getMeetingDetail(readMeetingId(meetingId)));

  handle(MEETINGS_IPC_CHANNELS.getTranscriptContent, async (_event: unknown, meetingId: unknown, transcriptId: unknown): Promise<unknown> => {
    const hub = runtime.requireMeetingHub();
    return hub.getTranscriptContent(readMeetingId(meetingId), readMeetingId(transcriptId, "transcript id"));
  });

  handle(MEETINGS_IPC_CHANNELS.searchTranscripts, async (_event: unknown, query: unknown, limit: unknown): Promise<unknown> => {
    if (typeof query !== "string" || query.length > MAX_STRING_LENGTH) {
      throw new StorageError("The transcript search text is invalid.");
    }
    const parsedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : undefined;
    return runtime.requireMeetingHub().searchTranscripts(query, parsedLimit === undefined ? {} : { limit: parsedLimit });
  });

  handle(MEETINGS_IPC_CHANNELS.getAnalysis, async (_event: unknown, meetingId: unknown): Promise<unknown> =>
    runtime.requireMeetingHub().getAnalysisDocument(readMeetingId(meetingId)));

  handle(MEETINGS_IPC_CHANNELS.getCaptureCapabilities, async (): Promise<unknown> =>
    runtime.requireMeetingHub().getCaptureCapabilities());

  handle(MEETINGS_IPC_CHANNELS.startCapture, async (_event: unknown, input: unknown): Promise<unknown> =>
    runtime.requireMeetingHub().startMeetingCapture(readCaptureRequest(input)));

  handle(MEETINGS_IPC_CHANNELS.stopCapture, async (_event: unknown, meetingId: unknown): Promise<unknown> =>
    runtime.requireMeetingHub().stopMeetingCapture(readMeetingId(meetingId)));

  handle(MEETINGS_IPC_CHANNELS.abortCapture, async (_event: unknown, meetingId: unknown, reason: unknown): Promise<unknown> => {
    const parsedReason = typeof reason === "string" && reason.length > 0 ? reason.slice(0, 500) : undefined;
    return runtime.requireMeetingHub().abortMeetingCapture(readMeetingId(meetingId), parsedReason);
  });

  handle(MEETINGS_IPC_CHANNELS.listActiveCaptures, async (): Promise<unknown> =>
    runtime.requireMeetingHub().listActiveCaptures());

  handle(MEETINGS_IPC_CHANNELS.processMeeting, async (_event: unknown, meetingId: unknown, approved: unknown): Promise<unknown> => {
    const hub = runtime.requireMeetingHub();
    const id = readMeetingId(meetingId);
    await runtime.processCompletedMeeting(id, {
      ...(approved === true ? { userApprovedForThisRequest: true } : {}),
    });
    return hub.getMeetingDetail(id);
  });

  handle(MEETINGS_IPC_CHANNELS.openLinkedUrl, async (_event: unknown, meetingId: unknown, kind: unknown): Promise<void> => {
    const parsedKind = kind === "JOIN" || kind === "WEB" ? kind : undefined;
    if (parsedKind === undefined) {
      throw new StorageError("The calendar link action is invalid.");
    }
    const url = runtime.requireMeetingHub().getLinkedUrl(readMeetingId(meetingId), parsedKind);
    if (url === undefined) {
      throw new StorageError("This meeting has no safe calendar link to open.");
    }
    await openExternal(url);
  });
}

function readMeetingId(value: unknown, label = "meeting id"): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_MEETING_ID_LENGTH) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return value.trim();
}

function readCaptureRequest(value: unknown): HubCaptureRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The capture request is invalid.");
  }
  const record = value as Record<string, unknown>;
  const meetingId = readMeetingId(record.meetingId);
  const microphone = record.microphone === true;
  const systemLoopback = record.systemLoopback === true;
  const screen = record.screen === true;
  const window = record.window;
  if (!microphone && !systemLoopback && !screen && window === undefined) {
    throw new StorageError("The capture request requires at least one enabled source.");
  }
  const request: HubCaptureRequest = { meetingId, microphone, systemLoopback, screen };
  if (typeof window === "string" && window.length > 0) {
    if (window.length > 1024) {
      throw new StorageError("The capture window source is invalid.");
    }
    request.window = window;
  } else if (window !== undefined) {
    throw new StorageError("The capture window source is invalid.");
  }
  return request;
}

function sanitizeMeetingsIpcError(error: unknown): Error {
  if (error instanceof MeetingHubError || error instanceof StorageError) {
    return error;
  }
  if (error instanceof Error) {
    console.error("Meeting Hub IPC error", error);
  }
  return new StorageError("The meeting action could not be completed. Please try again.");
}
