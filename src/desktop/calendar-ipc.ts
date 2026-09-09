import { toRendererCalendarSyncResult, type RendererCalendarSyncResult } from "../calendar/CalendarModels";
import { CalendarConnectionError, type BeginCalendarSignInResult, type CalendarConnectionStatus } from "../calendar/CalendarConnection";
import { MicrosoftOAuthConfigurationError } from "../integrations/microsoft/MicrosoftOAuthConfig";
import { GoogleOAuthConfigurationError } from "../integrations/google/GoogleOAuthConfig";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import { CALENDAR_IPC_CHANNELS } from "./storage-api";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

/**
 * Inputs the renderer may send for the OAuth application configuration. All
 * values are plain strings; the config files themselves live in the
 * main-process userData directory and never contain secrets.
 */
export interface MicrosoftOAuthConfigInput {
  clientId?: string;
  tenant?: string;
  redirectUri?: string;
}

export interface GoogleOAuthConfigInput {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface CalendarProviderBinding {
  status: string;
  beginSignIn: string;
  completeSignIn: string;
  cancelSignIn: string;
  disconnect: string;
  syncAuto: string;
  saveConfigChannel: string;
  runtime: {
    status(): Promise<CalendarConnectionStatus | undefined>;
    beginSignIn(): Promise<BeginCalendarSignInResult>;
    completeSignIn(input: { flowId: string; redirectUrl: string }): Promise<CalendarConnectionStatus>;
    cancelSignIn(): Promise<void>;
    disconnect(): Promise<CalendarConnectionStatus>;
    syncAuto(): Promise<RendererCalendarSyncResult>;
  };
  parseConfig(value: unknown): MicrosoftOAuthConfigInput | GoogleOAuthConfigInput;
  persistConfig(input: MicrosoftOAuthConfigInput | GoogleOAuthConfigInput): Promise<void>;
}

export interface CalendarIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
  /** Opens the authorization URL in the user's default browser. */
  openExternal: (url: string) => Promise<void>;
  /** Validates and persists the Microsoft OAuth config, then reconfigures the runtime. */
  saveMicrosoftOAuthApplicationConfig: (input: MicrosoftOAuthConfigInput) => Promise<void>;
  /** Validates and persists the Google OAuth config, then reconfigures the runtime. */
  saveGoogleOAuthApplicationConfig: (input: GoogleOAuthConfigInput) => Promise<void>;
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
  saveMicrosoftOAuthApplicationConfig,
  saveGoogleOAuthApplicationConfig,
}: CalendarIpcDependencies): void {
  const bindings: CalendarProviderBinding[] = [
    {
      status: CALENDAR_IPC_CHANNELS.getMicrosoftStatus,
      beginSignIn: CALENDAR_IPC_CHANNELS.beginMicrosoftSignIn,
      completeSignIn: CALENDAR_IPC_CHANNELS.completeMicrosoftSignIn,
      cancelSignIn: CALENDAR_IPC_CHANNELS.cancelMicrosoftSignIn,
      disconnect: CALENDAR_IPC_CHANNELS.disconnectMicrosoft,
      syncAuto: CALENDAR_IPC_CHANNELS.syncMicrosoftCalendarAuto,
      saveConfigChannel: CALENDAR_IPC_CHANNELS.saveMicrosoftOAuthConfig,
      runtime: {
        status: () => runtime.getMicrosoftCalendarStatus(),
        beginSignIn: () => runtime.beginMicrosoftCalendarSignIn(),
        completeSignIn: (input) => runtime.completeMicrosoftCalendarSignIn(input),
        cancelSignIn: () => runtime.cancelMicrosoftCalendarSignIn(),
        disconnect: () => runtime.disconnectMicrosoftCalendar(),
        syncAuto: async () => {
          try {
            return toRendererCalendarSyncResult(await runtime.syncMicrosoftCalendarAuto());
          } catch {
            return unavailableSyncResult("MICROSOFT_GRAPH");
          }
        },
      },
      parseConfig: parseMicrosoftOAuthConfigInput,
      persistConfig: saveMicrosoftOAuthApplicationConfig,
    },
    {
      status: CALENDAR_IPC_CHANNELS.getGoogleStatus,
      beginSignIn: CALENDAR_IPC_CHANNELS.beginGoogleSignIn,
      completeSignIn: CALENDAR_IPC_CHANNELS.completeGoogleSignIn,
      cancelSignIn: CALENDAR_IPC_CHANNELS.cancelGoogleSignIn,
      disconnect: CALENDAR_IPC_CHANNELS.disconnectGoogle,
      syncAuto: CALENDAR_IPC_CHANNELS.syncGoogleCalendarAuto,
      saveConfigChannel: CALENDAR_IPC_CHANNELS.saveGoogleOAuthConfig,
      runtime: {
        status: () => runtime.getGoogleCalendarStatus(),
        beginSignIn: () => runtime.beginGoogleCalendarSignIn(),
        completeSignIn: (input) => runtime.completeGoogleCalendarSignIn(input),
        cancelSignIn: () => runtime.cancelGoogleCalendarSignIn(),
        disconnect: () => runtime.disconnectGoogleCalendar(),
        syncAuto: async () => {
          try {
            return toRendererCalendarSyncResult(await runtime.syncGoogleCalendarAuto());
          } catch {
            return unavailableSyncResult("GOOGLE_CALENDAR");
          }
        },
      },
      parseConfig: parseGoogleOAuthConfigInput,
      persistConfig: saveGoogleOAuthApplicationConfig,
    },
  ];

  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeCalendarIpcError(error);
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  for (const binding of bindings) {
    handle(binding.status, async () => binding.runtime.status());
    handle(binding.beginSignIn, async (): Promise<BeginCalendarSignInResult> => {
      const result = await binding.runtime.beginSignIn();
      try {
        await openExternal(result.authorizationUrl);
      } catch {
        throw new CalendarConnectionError(
          "CALENDAR_SIGNIN_BROWSER_UNAVAILABLE",
          `Your browser could not be opened automatically. Open this address in your browser to sign in, then return to AI WorkMate: ${result.authorizationUrl}`,
          false,
        );
      }
      return result;
    });
    handle(binding.completeSignIn, async (_event: unknown, input: unknown): Promise<CalendarConnectionStatus> => {
      const flowId = readOptionalString(input, "flowId");
      const redirectUrl = readOptionalString(input, "redirectUrl");
      if (flowId === undefined || redirectUrl === undefined || !isHttpUrl(redirectUrl)) {
        throw new StorageError("The sign-in completion request is invalid. Please start the sign-in again.");
      }
      return binding.runtime.completeSignIn({ flowId, redirectUrl });
    });
    handle(binding.cancelSignIn, async (): Promise<CalendarConnectionStatus | undefined> => {
      await binding.runtime.cancelSignIn();
      return binding.runtime.status();
    });
    handle(binding.disconnect, async (): Promise<CalendarConnectionStatus> => binding.runtime.disconnect());
    handle(binding.syncAuto, async (): Promise<RendererCalendarSyncResult> => binding.runtime.syncAuto());
    handle(binding.saveConfigChannel, async (_event: unknown, input: unknown): Promise<CalendarConnectionStatus> => {
      await binding.persistConfig(binding.parseConfig(input));
      const status = await binding.runtime.status();
      if (status === undefined) {
        throw new StorageError("The calendar integration could not be reconfigured.");
      }
      return status;
    });
  }
}

function unavailableSyncResult(provider: "MICROSOFT_GRAPH" | "GOOGLE_CALENDAR"): RendererCalendarSyncResult {
  return {
    provider,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    cancelledCount: 0,
    errorCount: 1,
    errors: [{ code: "CALENDAR_SYNC_UNAVAILABLE", retryable: false }],
  };
}

function parseMicrosoftOAuthConfigInput(value: unknown): MicrosoftOAuthConfigInput {
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

function parseGoogleOAuthConfigInput(value: unknown): GoogleOAuthConfigInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The Google Calendar integration settings are invalid.");
  }
  const record = value as Record<string, unknown>;
  const config: GoogleOAuthConfigInput = {};
  for (const key of ["clientId", "clientSecret", "redirectUri"] as const) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" || raw.length > 512) {
      throw new StorageError("The Google Calendar integration settings are invalid.");
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
  if (
    error instanceof CalendarConnectionError ||
    error instanceof MicrosoftOAuthConfigurationError ||
    error instanceof GoogleOAuthConfigurationError ||
    error instanceof StorageError
  ) {
    return error;
  }
  if (error instanceof Error) {
    console.error("Calendar IPC error", error);
  }
  return new StorageError("The calendar action could not be completed. Please try again.");
}
