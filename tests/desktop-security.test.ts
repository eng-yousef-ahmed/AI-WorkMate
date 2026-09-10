import assert from "node:assert/strict";
import { test } from "node:test";

import type { StorageSnapshot } from "../src/domain/models";
import type { StorageRuntime } from "../src/storage/StorageRuntime";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import { registerStorageIpc } from "../src/desktop/storage-ipc";
import { UnsafePathError } from "../src/storage/errors";
import { createSecureRendererPreferences, denyWindowOpen, isAuthorizedRendererNavigation } from "../src/desktop/window-security";

type IpcHandler = (...args: unknown[]) => unknown;

test("keeps the renderer sandboxed and rejects remote navigation or new windows", () => {
  assert.deepEqual(createSecureRendererPreferences("/app/preload.js"), {
    preload: "/app/preload.js",
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  });
  assert.equal(isAuthorizedRendererNavigation("file:///app/storage-settings.html", "file:///app/storage-settings.html"), true);
  assert.equal(isAuthorizedRendererNavigation("https://example.com", "file:///app/storage-settings.html"), false);
  assert.deepEqual(denyWindowOpen(), { action: "deny" });
});

test("keeps migration, backup, and export IPC results free of filesystem paths", async () => {
  const handlers = new Map<string, IpcHandler>();
  const selections = [
    { canceled: false, filePaths: ["/secret/new-data"] },
    { canceled: false, filePaths: ["/secret/backups"] },
    { canceled: false, filePaths: ["/secret/exports"] },
  ];
  const runtime = {
    prepareDataRootChange: async () => ({
      source: "/secret/source",
      destination: "/secret/new-data",
      bytesToMove: 1,
      filesToMove: 1,
      meetingCount: 1,
      destinationAvailableBytes: 100,
      requiredBytes: 1,
      explanation: ["Copy and verify before activation."],
    }),
    changeDataRoot: async () => ({
      migrated: true,
      plan: { source: "/secret/source", destination: "/secret/new-data" },
      result: { verified: true, sourcePreserved: true, copiedFiles: 1 },
    }),
    store: {
      backups: { createBackup: async () => ({ path: "/secret/backups/backup.zip", size: 10 }) },
      exports: { exportMeeting: async () => ({ path: "/secret/exports/meeting.zip", size: 20 }) },
    },
  } as unknown as StorageRuntime;
  registerStorageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: async () => selections.shift() ?? { canceled: true, filePaths: [] } },
    shell: { openPath: async () => "" },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  const event = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

  const preview = (await handlers.get(STORAGE_IPC_CHANNELS.prepareLocationChange)?.(event)) as { requestId?: string };
  assert.equal(typeof preview.requestId, "string");
  const requestId = preview.requestId as string;
  const migrationResult = await handlers.get(STORAGE_IPC_CHANNELS.confirmLocationChange)?.(event, requestId, true);
  assert.deepEqual(migrationResult, { migrated: true, verified: true, sourcePreserved: true, copiedFiles: 1 });
  assert.equal("source" in (migrationResult as object), false);
  assert.deepEqual(await handlers.get(STORAGE_IPC_CHANNELS.createBackup)?.(event), { size: 10 });
  assert.deepEqual(await handlers.get(STORAGE_IPC_CHANNELS.exportMeeting)?.(event, "meeting-1"), { size: 20 });
});


test("returns renderer-safe Microsoft calendar sync results without credential material", async () => {
  const handlers = new Map<string, IpcHandler>();
  const runtime = {
    syncMicrosoftCalendar: async () => ({
      provider: "MICROSOFT_GRAPH",
      startTime: "2026-09-01T00:00:00.000Z",
      endTime: "2026-09-02T00:00:00.000Z",
      createdCount: 1,
      updatedCount: 2,
      unchangedCount: 3,
      cancelledCount: 4,
      errorCount: 1,
      errors: [{
        provider: "MICROSOFT_GRAPH",
        code: "InvalidAuthenticationToken",
        message: "secret access_token=abc123 client_secret=do-not-render",
        retryable: false,
        status: 401,
      }],
    }),
  } as unknown as StorageRuntime;
  registerStorageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => "" },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  const event = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

  const result = await handlers.get(STORAGE_IPC_CHANNELS.syncMicrosoftCalendar)?.(event, {
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z",
  });

  assert.deepEqual(result, {
    provider: "MICROSOFT_GRAPH",
    createdCount: 1,
    updatedCount: 2,
    unchangedCount: 3,
    cancelledCount: 4,
    errorCount: 1,
    errors: [{ code: "InvalidAuthenticationToken", retryable: false, status: 401 }],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("client_secret"), false);
  assert.equal(serialized.includes("do-not-render"), false);
});

test("authorizes storage IPC only for the active application webContents and exact renderer URL", async () => {
  const handlers = new Map<string, IpcHandler>();
  const snapshot: StorageSnapshot = {
    dataLocation: { type: "LOCAL", label: "Local workspace (path hidden)", pathExposed: false },
    stats: {
      totalBytes: 0,
      recordingsBytes: 0,
      audioBytes: 0,
      transcriptsBytes: 0,
      documentsBytes: 0,
      databaseBytes: 0,
      availableBytes: 100,
      fileCount: 0,
      meetingCount: 0,
    },
    storageVersion: 1,
    aiProcessingPolicy: "ASK_EACH_TIME",
  };
  const runtime = { getSnapshot: async () => snapshot } as unknown as StorageRuntime;
  registerStorageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => "" },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });

  const handler = handlers.get(STORAGE_IPC_CHANNELS.getSnapshot);
  assert.ok(handler);
  await assert.rejects(
    async () => handler({ sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } }),
    /unauthorized renderer/,
  );
  await assert.rejects(
    async () => handler({ sender: { id: 77 }, senderFrame: { url: "file:///untrusted.html" } }),
    /unauthorized renderer/,
  );
  assert.deepEqual(
    await handler({ sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } }),
    snapshot,
  );
});

test("storage backup IPC sanitizes unsafe-path errors so DATA_ROOT never reaches the renderer", async () => {
  const handlers = new Map<string, IpcHandler>();
  const runtime = {
    store: {
      backups: {
        createBackup: async () => {
          throw new UnsafePathError("C:\\\\Users\\\\ada\\\\AI-WorkMate");
        },
      },
    },
  } as unknown as StorageRuntime;
  registerStorageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["C:\\\\Users\\\\ada\\\\Backups"] }) },
    shell: { openPath: async () => "" },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  const event = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
  await assert.rejects(
    async () => handlers.get(STORAGE_IPC_CHANNELS.createBackup)?.(event),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = (error as Error).message;
      assert.equal(message.includes("C:"), false);
      assert.equal(message.includes("Users"), false);
      assert.match(message, /not allowed/);
      return true;
    },
  );
});

test("lifecycle IPC returns workspace flags without filesystem paths", async () => {
  const handlers = new Map<string, IpcHandler>();
  const runtime = {
    getLifecycleSnapshot: async () => ({
      workspaceReady: true,
      firstRunRequired: false,
      firstRunRecoveryRequired: false,
      appVersion: "0.1.0",
      storageVersion: 11,
      schemaVersion: 11,
      upgradeBlocked: false,
      migrationRecoveryRequired: false,
      dataLocation: { type: "LOCAL", label: "Local workspace (path hidden)", pathExposed: false },
    }),
  } as unknown as StorageRuntime;
  registerStorageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => "" },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  const event = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
  const snapshot = await handlers.get(STORAGE_IPC_CHANNELS.getLifecycle)?.(event);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("C:"), false);
  assert.equal(serialized.includes("/home/"), false);
  assert.equal(serialized.includes("pathExposed\":false"), true);
});

test("does not expose local recording capture controls or output paths through renderer IPC", () => {
  const channelNames = Object.keys(STORAGE_IPC_CHANNELS);
  const channelValues = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(channelNames.some((name) => /capture|recording/i.test(name)), false);
  assert.equal(channelValues.some((channel) => /capture|recording|output-path|source-path/i.test(channel)), false);
});
