import assert from "node:assert/strict";
import { test } from "node:test";

import type { StorageRuntime } from "../src/storage/StorageRuntime";
import { StorageError } from "../src/storage/errors";
import { AUTOMATION_IPC_CHANNELS } from "../src/desktop/storage-api";
import { registerAutomationIpc } from "../src/desktop/automation-ipc";
import { DEFAULT_AUTOMATION_PREFERENCES } from "../src/automation/AutomationPreferences";

type IpcHandler = (...args: unknown[]) => unknown;

const AUTHORIZED_EVENT = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
const UNAUTHORIZED_EVENT = { sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

async function invoke(handlers: Map<string, IpcHandler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(...args);
}

test("automation IPC authorizes the renderer and never returns paths", async () => {
  const calls: string[] = [];
  const runtime = {
    getAutomationPreferences: async () => ({ ...DEFAULT_AUTOMATION_PREFERENCES }),
    setAutomationPreferences: async (patch: unknown) => {
      calls.push(`set:${JSON.stringify(patch)}`);
      return { ...DEFAULT_AUTOMATION_PREFERENCES, ...(patch as object) };
    },
    requireAutomation: () => ({
      listNotifications: () => {
        calls.push("list");
        return [{ notificationId: "n1", kind: "DAILY_MEETING_REPORT", title: "Daily report", body: "Local only.", createdAt: "2026-09-09T00:00:00.000Z", read: false }];
      },
      markNotificationRead: (id: string) => {
        calls.push(`read:${id}`);
        return { notificationId: id, kind: "DAILY_MEETING_REPORT", title: "Daily report", body: "Local only.", createdAt: "2026-09-09T00:00:00.000Z", read: true };
      },
      runTick: async () => ({ detectedMeetings: 0, createdNotifications: 0, skippedDuplicates: 0 }),
    }),
  } as unknown as StorageRuntime;

  const handlers = new Map<string, IpcHandler>();
  registerAutomationIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });

  const prefs = await invoke(handlers, AUTOMATION_IPC_CHANNELS.getPreferences, AUTHORIZED_EVENT);
  assert.equal((prefs as { meetingDetection: boolean }).meetingDetection, true);

  await assert.rejects(
    invoke(handlers, AUTOMATION_IPC_CHANNELS.getPreferences, UNAUTHORIZED_EVENT),
    /unauthorized renderer/,
  );

  const listed = await invoke(handlers, AUTOMATION_IPC_CHANNELS.listNotifications, AUTHORIZED_EVENT) as Array<{ body: string }>;
  assert.equal(listed[0]?.body.includes("/"), false);

  await invoke(handlers, AUTOMATION_IPC_CHANNELS.setPreferences, AUTHORIZED_EVENT, { overdueReminders: true });
  await invoke(handlers, AUTOMATION_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, "n1");
  assert.equal(calls.includes("read:n1"), true);

  await assert.rejects(
    invoke(handlers, AUTOMATION_IPC_CHANNELS.setPreferences, AUTHORIZED_EVENT, {}),
    /empty/i,
  );
  await assert.rejects(
    invoke(handlers, AUTOMATION_IPC_CHANNELS.markRead, AUTHORIZED_EVENT, ""),
    /invalid/i,
  );
});

test("automation IPC sanitizes unexpected errors", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerAutomationIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime: {
      getAutomationPreferences: async () => {
        throw new Error("C:\\\\Users\\\\ada\\\\secret");
      },
      requireAutomation: () => {
        throw new StorageError("Choose a local data location before using notifications.");
      },
    } as unknown as StorageRuntime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  await assert.rejects(
    invoke(handlers, AUTOMATION_IPC_CHANNELS.getPreferences, AUTHORIZED_EVENT),
    /could not be completed/,
  );
});
