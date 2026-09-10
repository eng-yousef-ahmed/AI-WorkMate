import { AUTOMATION_IPC_CHANNELS } from "./storage-api";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import type { HubAutomationPreferences } from "../domain/hub";
import { normalizeAutomationPreferences } from "../automation/AutomationPreferences";
import { sanitizeRendererIpcError } from "./ipc-sanitize";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

export interface AutomationIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
}

const MAX_NOTIFICATION_ID_LENGTH = 128;

/**
 * Main-process automation handlers. Preferences never include credentials.
 * Notification DTOs never include fingerprints, paths, or tokens.
 */
export function registerAutomationIpc({
  ipcMain,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
}: AutomationIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeRendererIpcError(error, "The notification action could not be completed. Please try again.");
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  handle(AUTOMATION_IPC_CHANNELS.getPreferences, async (): Promise<unknown> => runtime.getAutomationPreferences());

  handle(AUTOMATION_IPC_CHANNELS.setPreferences, async (_event: unknown, patch: unknown): Promise<unknown> => {
    return runtime.setAutomationPreferences(readPreferencesPatch(patch));
  });

  handle(AUTOMATION_IPC_CHANNELS.listNotifications, (_event: unknown, query: unknown): unknown => {
    return runtime.requireAutomation().listNotifications(readNotificationQuery(query));
  });

  handle(AUTOMATION_IPC_CHANNELS.markRead, (_event: unknown, notificationId: unknown): unknown => {
    if (typeof notificationId !== "string" || notificationId.trim().length === 0 || notificationId.length > MAX_NOTIFICATION_ID_LENGTH) {
      throw new StorageError("The notification id is invalid.");
    }
    return runtime.requireAutomation().markNotificationRead(notificationId.trim());
  });

  handle(AUTOMATION_IPC_CHANNELS.runTick, async (): Promise<unknown> => runtime.requireAutomation().runTick());
}

function readPreferencesPatch(value: unknown): Partial<HubAutomationPreferences> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The automation preferences are invalid.");
  }
  const normalized = normalizeAutomationPreferences(value);
  const record = value as Record<string, unknown>;
  const patch: Partial<HubAutomationPreferences> = {};
  for (const key of Object.keys(normalized) as Array<keyof HubAutomationPreferences>) {
    if (record[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = normalized[key];
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new StorageError("The automation preferences update is empty.");
  }
  return patch;
}

function readNotificationQuery(value: unknown): { unreadOnly?: boolean; limit?: number } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("The notification query is invalid.");
  }
  const record = value as Record<string, unknown>;
  const query: { unreadOnly?: boolean; limit?: number } = {};
  if (record.unreadOnly === true) query.unreadOnly = true;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isFinite(record.limit)) {
      throw new StorageError("The notification limit is invalid.");
    }
    query.limit = Math.min(Math.max(1, Math.trunc(record.limit)), 200);
  }
  return query;
}

