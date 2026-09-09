import { toRendererCalendarSyncResult, type RendererCalendarSyncResult } from "../calendar/CalendarModels";
import { CalendarConnectionError, type BeginCalendarSignInResult, type CalendarConnectionStatus } from "../calendar/CalendarConnection";
import { MicrosoftOAuthConfigurationError } from "../integrations/microsoft/MicrosoftOAuthConfig";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import { CALENDAR_IPC_CHANNELS } from "./storage-api";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

/**
 * Inputs the renderer may send for the Microsoft OAuth configuration. All
 * values are plain strings; the config file itself lives in the main-process
 * userData directory and never contains secrets.
 */
export interface MicrosoftOAuthConfigInput {
  clientId?: string;
  tenant?: string;
  redirectUri?: string;
}

export interface CalendarIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
  /** Opens the authorization URL in the user's default browser. */
  openExternal: (url: string) => Promise<void>;
  /** Validates and persists the OAuth config, then reconfigures the runtime. */
  saveOAuthApplicationConfig: (input: MicrosoftOAuthConfigInput) => Promise<void>;
}

/**
 * Main-process calendar connection handlers. Results are renderer-safe status
 * objects and sync counters; tokens, verifiers, state values, and cursor URLs
 * never leave the main process. Errors crossing the boundary are sanitized.
 */
export function registerCalendarIpc({
  ipcMain,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
  openExternal,
  saveOAuthApplicationConfig,
}: CalendarIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeCalendarIpcError(error);
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  handle(CALENDAR_IPC_CHANNELS.getMicrosoftStatus, async (): Promise<CalendarConnectionStatus | undefined> =>
    runtime.getMicrosoftCalendarStatus());

  handle(CALENDAR_IPC_CHANNELS.beginMicrosoftSignIn, async (): Promise<BeginCalendarSignInResult> => {
    const result = await runtime.beginMicrosoftCalendarSignIn();
    try {
      await openExternal(result.authorizationUrl);
    } catch {
      throw new CalendarConnectionError(
        "MICROSOFT_SIGNIN_BROWSER_UNAVAILABLE",
        `Your browser could not be opened automatically. Open this address in your browser to sign in, then return to AI WorkMate: ${result.authorizationUrl}`,
        false,
      );
    }
    return result;
  });

  handle(CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn, async (_event: unknown, input: unknown): Promise<CalendarConnectionStatus> => {
    const flowId = readOptionalString(input, "flowId");
    const redirectUrl = readOptionalString(input, "redirectUrl");
    if (flowId === undefined || redirectUrl === undefined || !isHttpUrl(redirectUrl)) {
      throw new StorageError("The sign-in completion request is invalid. Please start the sign-in again.");
    }
    return runtime.completeMicrosoftCalendarSignIn({ flowId, redirectUrl });
  });

  handle(CALENDAR_IPC_CHANNELS.cancelMicrosoftSignIn, async (): Promise<CalendarConnectionStatus | undefined> => {
    await runtime.cancelMicrosoftCalendarSignIn();
    return runtime.getMicrosoftCalendarStatus();
  });

  handle(CALENDAR_IPC_CHANNELS.disconnectMicrosoft, async (): Promise<CalendarConnectionStatus> =>
    runtime.disconnectMicrosoftCalendar());

  handle(CALENDAR_IPC_CHANNELS.syncMicrosoftCalendarAuto, async (): Promise<RendererCalendarSyncResult> => {
    try {
      const result = await runtime.syncMicrosoftCalendarAuto();
      return toRendererCalendarSyncResult(result);
    } catch {
      return {
        provider: "MICROSOFT_GRAPH",
        createdCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        cancelledCount: 0,
        errorCount: 1,
        errors: [{ code: "MICROSOFT_CALENDAR_SYNC_UNAVAILABLE", retryable: false }],
      };
    }
  });

  handle(CALENDAR_IPC_CHANNELS.saveMicrosoftOAuthConfig, async (_event: unknown, input: unknown): Promise<CalendarConnectionStatus> => {
    const config = parseOAuthConfigInput(input);
    await saveOAuthApplicationConfig(config);
    const status = await runtime.getMicrosoftCalendarStatus();
    if (status === undefined) {
      throw new StorageError("The Microsoft 365 calendar integration could not be reconfigured.");
    }
    return status;
  });
}

function parseOAuthConfigInput(value: unknown): MicrosoftOAuthConfigInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The Microsoft 365 integration settings are invalid.");
  }
  const record = value as Record<string, unknown>;
  const config: MicrosoftOAuthConfigInput = {};
  for (const key of ["clientId", "tenant", "redirectUri"] as const) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" || raw.length > 512) {
      throw new StorageError("The Microsoft 365 integration settings are invalid.");
    }
    config[key] = raw.trim();
  }
  return config;
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function isHttpUrl(value: string): boolean {
  if (value.length > 8192) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Known errors carry fixed, non-sensitive messages from the main-process
 * connection layer. Anything unexpected becomes a generic message so raw
 * filesystem or network details never reach the renderer.
 */
function sanitizeCalendarIpcError(error: unknown): Error {
  if (error instanceof CalendarConnectionError || error instanceof MicrosoftOAuthConfigurationError || error instanceof StorageError) {
    return error;
  }
  if (error instanceof Error) {
    console.error("Microsoft 365 calendar IPC error", error);
  }
  return new StorageError("The Microsoft 365 calendar action could not be completed. Please try again.");
}
