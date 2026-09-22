import { NOTIFICATIONS_IPC_CHANNELS } from "./storage-api";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import type { HubNotificationSettingsInput } from "../domain/hub";
import { sanitizeRendererIpcError } from "./ipc-sanitize";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

export interface NotificationsIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
  /** Broadcasts a notification-history change event to the renderer. */
  broadcastChanged: () => void;
}

const MAX_ID_LENGTH = 200;

/**
 * Main-process notification-center handlers. The renderer only ever sends
 * notification ids, read-state commands, and automation preferences; every
 * history item it receives is a renderer-safe HubNotification DTO. The
 * broadcast keeps the bell badge in sync when automation ticks create rows
 * outside of a renderer request.
 */
export function registerNotificationsIpc({
  ipcMain,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
  broadcastChanged,
}: NotificationsIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeRendererIpcError(error, "The notification action could not be completed. Please try again.");
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  handle(NOTIFICATIONS_IPC_CHANNELS.list, (): unknown => {
    return runtime.requireNotificationCenter().listPage();
  });

  handle(NOTIFICATIONS_IPC_CHANNELS.markRead, (_event: unknown, notificationId: unknown): unknown => {
    const id = readId(notificationId, "notification id");
    const center = runtime.requireNotificationCenter();
    const item = center.markRead(id);
    if (item !== undefined) {
      broadcastChanged();
    }
    return item;
  });

  handle(NOTIFICATIONS_IPC_CHANNELS.markAllRead, (): unknown => {
    const center = runtime.requireNotificationCenter();
    const changed = center.markAllRead();
    if (changed > 0) {
      broadcastChanged();
    }
    return changed;
  });

  handle(NOTIFICATIONS_IPC_CHANNELS.getSettings, (): unknown => {
    return runtime.requireNotificationCenter().getSettings();
  });

  handle(NOTIFICATIONS_IPC_CHANNELS.updateSettings, (_event: unknown, input: unknown): unknown => {
    const center = runtime.requireNotificationCenter();
    const settings = center.updateSettings(readSettingsInput(input));
    broadcastChanged();
    return settings;
  });

  handle(NOTIFICATIONS_IPC_CHANNELS.runAutomationNow, async (): Promise<unknown> => {
    const center = runtime.requireNotificationCenter();
    const summary = await center.runAutomation();
    if (summary.inserted > 0) {
      broadcastChanged();
    }
    return summary;
  });
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return value.trim();
}

function readSettingsInput(value: unknown): HubNotificationSettingsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The notification settings are invalid.");
  }
  const record = value as Record<string, unknown>;
  const input: HubNotificationSettingsInput = {};
  if (record.notificationsEnabled !== undefined) {
    if (typeof record.notificationsEnabled !== "boolean") {
      throw new StorageError("The notifications toggle is invalid.");
    }
    input.notificationsEnabled = record.notificationsEnabled;
  }
  if (record.digestEnabled !== undefined) {
    if (typeof record.digestEnabled !== "boolean") {
      throw new StorageError("The digest toggle is invalid.");
    }
    input.digestEnabled = record.digestEnabled;
  }
  if (record.digestTime !== undefined) {
    if (typeof record.digestTime !== "string") {
      throw new StorageError("The digest time is invalid.");
    }
    const digestTime = record.digestTime.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(digestTime)) {
      throw new StorageError("The digest time must be a 24-hour HH:MM local time.");
    }
    input.digestTime = digestTime;
  }
  if (Object.keys(input).length === 0) {
    throw new StorageError("The notification settings update is empty.");
  }
  return input;
}


