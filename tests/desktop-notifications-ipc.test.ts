import assert from "node:assert/strict";
import { test } from "node:test";

import type { StorageRuntime } from "../src/storage/StorageRuntime";
import { StorageError } from "../src/storage/errors";
import { NOTIFICATIONS_IPC_CHANNELS } from "../src/desktop/storage-api";
import { registerNotificationsIpc } from "../src/desktop/notifications-ipc";
import type { HubNotification, HubNotificationPage, HubNotificationSettings } from "../src/domain/hub";

type IpcHandler = (...args: unknown[]) => unknown;

const AUTHORIZED_EVENT = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
const UNAUTHORIZED_EVENT = { sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

async function invoke(handlers: Map<string, IpcHandler>, channel: string, event: unknown = AUTHORIZED_EVENT, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(event, ...args);
}

function notificationStub(overrides: Partial<HubNotification> = {}): HubNotification {
  return {
    notificationId: "notification-1",
    kind: "MEETING_READY",
    severity: "INFO",
    title: "Transcript and analysis ready",
    body: "Planning sync · 2026-09-08",
    createdAt: "2026-09-08T10:00:00.000Z",
    readAt: null,
    meetingId: "meeting-1",
    action: "open-meeting",
    ...overrides,
  };
}

function settingsStub(): HubNotificationSettings {
  return { notificationsEnabled: true, digestEnabled: false, digestTime: "09:00", updatedAt: "2026-09-08T10:00:00.000Z" };
}

interface StubOptions {
  listError?: unknown;
  settingsError?: unknown;
}

function createStubs(options: StubOptions = {}): {
  calls: string[];
  runtime: StorageRuntime;
} {
  const calls: string[] = [];
  const item = notificationStub();
  const page: HubNotificationPage = { notifications: [item], unread: 1 };
  let currentSettings = settingsStub();
  const center = {
    listPage: () => {
      calls.push("list");
      if (options.listError !== undefined) throw options.listError;
      return page;
    },
    markRead: (id: string) => {
      calls.push(`markRead:${id}`);
      return { ...item, readAt: "2026-09-09T08:00:00.000Z" };
    },
    markAllRead: () => {
      calls.push("markAllRead");
      return 1;
    },
    getSettings: () => {
      calls.push("getSettings");
      if (options.settingsError !== undefined) throw options.settingsError;
      return currentSettings;
    },
    updateSettings: (input: unknown) => {
      const record = input as { digestTime?: string };
      calls.push(`updateSettings:${record.digestTime ?? "unchanged"}`);
      currentSettings = { ...currentSettings, ...(input as object) };
      return currentSettings;
    },
    runAutomation: async () => {
      calls.push("runAutomation");
      return { inserted: 1, taskAlerts: 1, digestFired: false, pruned: 0 };
    },
  } as unknown as StorageRuntime["notifications"];

  const runtime = {
    requireNotificationCenter: () => center,
  } as unknown as StorageRuntime;
  return { calls, runtime };
}

function register(runtime: StorageRuntime): { handlers: Map<string, IpcHandler>; broadcasts: () => number } {
  const handlers = new Map<string, IpcHandler>();
  let broadcasts = 0;
  registerNotificationsIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
    broadcastChanged: () => { broadcasts += 1; },
  });
  return { handlers, broadcasts: () => broadcasts };
}

test("notifications IPC: all handlers reject an unauthorized renderer", async () => {
  const { runtime } = createStubs();
  const { handlers } = register(runtime);
  for (const channel of Object.values(NOTIFICATIONS_IPC_CHANNELS)) {
    await assert.rejects(invoke(handlers, channel, UNAUTHORIZED_EVENT), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unauthorized renderer/i);
      return true;
    });
  }
});

test("notifications IPC: list returns the renderer-safe page and sanitizes service errors", async () => {
  const badRuntime = {
    requireNotificationCenter: () => {
      throw new StorageError("Choose a local data location before using notifications.");
    },
  } as unknown as StorageRuntime;
  const { handlers } = register(badRuntime);
  await assert.rejects(invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.list), (error: unknown) => {
    assert.ok(error instanceof StorageError);
    assert.match(error.message, /Choose a local data location/);
    return true;
  });

  const failing = createStubs({ listError: new Error("boom: C:\\Users\\data\\local.db") });
  const failingHandlers = register(failing.runtime).handlers;
  await assert.rejects(invoke(failingHandlers, NOTIFICATIONS_IPC_CHANNELS.list), (error: unknown) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.message.includes("C:\\"), false);
    return true;
  });
});

test("notifications IPC: mark-read and mark-all-read validate ids and broadcast", async () => {
  const { runtime } = createStubs();
  const { handlers, broadcasts } = register(runtime);

  await assert.rejects(invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, ""), StorageError);
  await assert.rejects(invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, "   "), StorageError);
  await assert.rejects(invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, 42), StorageError);

  const item = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, "notification-1") as HubNotification;
  assert.equal(item.notificationId, "notification-1");
  assert.ok(item.readAt !== null);
  assert.equal(broadcasts(), 1);

  const marked = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.markAllRead) as number;
  assert.equal(marked, 1);
  assert.equal(broadcasts(), 2);
});

test("notifications IPC: settings round-trip with strict validation and broadcast", async () => {
  const { runtime } = createStubs();
  const { handlers, broadcasts } = register(runtime);

  const bad = [
    { notificationsEnabled: "on" },
    { digestEnabled: 1 },
    { digestTime: 900 },
    { digestTime: "9 am" },
    { digestTime: "25:00" },
    { unknownKey: true },
  ];
  for (const input of bad) {
    await assert.rejects(invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.updateSettings, AUTHORIZED_EVENT, input), StorageError);
  }

  const settings = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.updateSettings, AUTHORIZED_EVENT, { digestTime: "17:45", digestEnabled: true }) as HubNotificationSettings;
  assert.equal(settings.digestTime, "17:45");
  assert.equal(settings.digestEnabled, true);
  assert.equal(broadcasts(), 1);

  const current = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.getSettings) as HubNotificationSettings;
  assert.equal(current.digestEnabled, true);
  assert.equal(current.notificationsEnabled, true);
});

test("notifications IPC: run-automation-now delegates and broadcasts on inserts", async () => {
  const { runtime } = createStubs();
  const { handlers, broadcasts } = register(runtime);
  const summary = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.runAutomationNow) as { inserted: number };
  assert.equal(summary.inserted, 1);
  assert.equal(broadcasts(), 1);

  const quietRuntime = {
    requireNotificationCenter: () => ({
      runAutomation: async () => ({ inserted: 0, taskAlerts: 0, digestFired: false, pruned: 0 }),
    }),
  } as unknown as StorageRuntime;
  const quiet = register(quietRuntime);
  const quietSummary = await invoke(quiet.handlers, NOTIFICATIONS_IPC_CHANNELS.runAutomationNow) as { inserted: number };
  assert.equal(quietSummary.inserted, 0);
  assert.equal(quiet.broadcasts(), 0);
});

test("notifications IPC: unknown payloads for list/settings never reach the service", async () => {
  const { runtime } = createStubs();
  const { handlers } = register(runtime);
  // list ignores extra arguments and still works from the authorized frame.
  const page = await invoke(handlers, NOTIFICATIONS_IPC_CHANNELS.list, AUTHORIZED_EVENT, { evil: true }) as HubNotificationPage;
  assert.equal(page.unread, 1);
  assert.equal(page.notifications.length, 1);
});
