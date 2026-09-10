import { randomUUID } from "node:crypto";

import { toRendererCalendarSyncResult, type RendererCalendarSyncResult } from "../calendar/CalendarModels";
import type { AIProcessingPolicy, StorageSnapshot } from "../domain/models";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import { assertOfficeExportKind } from "../office/OfficeExportService";
import { STORAGE_IPC_CHANNELS, type LocationChangePreview } from "./storage-api";
import { sanitizeRendererIpcError } from "./ipc-sanitize";

export interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

export interface DialogLike {
  showOpenDialog(options: {
    properties: string[];
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ShellLike {
  openPath(path: string): Promise<string>;
}

export interface StorageIpcDependencies {
  ipcMain: IpcMainLike;
  dialog: DialogLike;
  shell: ShellLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
}

/**
 * Main-process-only handlers. Renderer input is limited to IDs, booleans, and
 * an allow-listed policy; all filesystem paths come from native dialogs or the
 * runtime's already-authorized DATA_ROOT.
 */
export function registerStorageIpc({
  ipcMain,
  dialog,
  shell,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
}: StorageIpcDependencies): void {
  const pendingLocationChanges = new Map<string, string>();
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(
      channel,
      secureHandler(async (...args: unknown[]) => {
        try {
          return await listener(...args);
        } catch (error: unknown) {
          throw sanitizeRendererIpcError(error, "The storage action could not be completed. Please try again.");
        }
      }, getAuthorizedWebContentsId, getAuthorizedRendererUrl),
    );
  };

  handle(STORAGE_IPC_CHANNELS.getSnapshot, async (): Promise<StorageSnapshot> => runtime.getSnapshot());
  handle(STORAGE_IPC_CHANNELS.getLifecycle, async () => runtime.getLifecycleSnapshot());

  handle(STORAGE_IPC_CHANNELS.chooseInitialLocation, async (): Promise<StorageSnapshot | null> => {
    const selected = await chooseDirectory(dialog, "Choose where AI WorkMate should store your data.");
    if (selected === null) {
      return null;
    }
    await runtime.configureFirstRun(selected);
    return runtime.getSnapshot();
  });

  handle(STORAGE_IPC_CHANNELS.prepareLocationChange, async (): Promise<LocationChangePreview> => {
    const selected = await chooseDirectory(dialog, "Choose a new local AI WorkMate data location.");
    if (selected === null) {
      return { canceled: true };
    }
    const plan = await runtime.prepareDataRootChange(selected);
    const requestId = randomUUID();
    pendingLocationChanges.set(requestId, selected);
    return {
      canceled: false,
      requestId,
      bytesToMove: plan.bytesToMove,
      filesToMove: plan.filesToMove,
      meetingCount: plan.meetingCount,
      destinationAvailableBytes: plan.destinationAvailableBytes,
      requiredBytes: plan.requiredBytes,
      explanation: plan.explanation,
    };
  });

  handle(
    STORAGE_IPC_CHANNELS.confirmLocationChange,
    async (_event: unknown, requestId: unknown, migrateExistingData: unknown) => {
      if (typeof requestId !== "string" || typeof migrateExistingData !== "boolean") {
        throw new StorageError("Invalid storage migration request.");
      }
      const selected = pendingLocationChanges.get(requestId);
      if (selected === undefined) {
        throw new StorageError("The storage migration request has expired or was already used.");
      }
      pendingLocationChanges.delete(requestId);
      const result = await runtime.changeDataRoot(selected, migrateExistingData);
      return {
        migrated: result.migrated,
        verified: result.result?.verified,
        sourcePreserved: result.result?.sourcePreserved,
        copiedFiles: result.result?.copiedFiles,
      };
    },
  );

  handle(STORAGE_IPC_CHANNELS.openDataFolder, async (): Promise<void> => {
    await shell.openPath(runtime.getDataRoot());
  });
  handle(STORAGE_IPC_CHANNELS.verifyStorage, async () => runtime.verifyStorage());
  handle(STORAGE_IPC_CHANNELS.repairStorage, async () => runtime.repairStorage());

  handle(STORAGE_IPC_CHANNELS.syncMicrosoftCalendar, async (_event: unknown, request: unknown): Promise<RendererCalendarSyncResult> => {
    if (!isCalendarSyncRequest(request)) {
      throw new StorageError("Invalid Microsoft calendar synchronization request.");
    }
    try {
      const result = await runtime.syncMicrosoftCalendar({
        startTime: request.startTime,
        endTime: request.endTime,
      });
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

  handle(STORAGE_IPC_CHANNELS.createBackup, async () => {
    const selected = await chooseDirectory(dialog, "Choose a local backup folder.");
    if (selected === null) return null;
    const created = await requireStore(runtime).backups.createBackup(selected);
    return { size: created.size };
  });

  handle(STORAGE_IPC_CHANNELS.restoreBackup, async () => {
    const backupSelection = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "AI WorkMate backup", extensions: ["aiwm.zip", "zip"] }],
    });
    if (backupSelection.canceled || backupSelection.filePaths[0] === undefined) return null;
    const destination = await chooseDirectory(dialog, "Choose an empty folder to restore this backup into.");
    if (destination === null) return null;
    const restored = await requireStore(runtime).backups.restore(backupSelection.filePaths[0], destination);
    return { verified: restored.verified, restoredFiles: restored.restoredFiles };
  });

  handle(STORAGE_IPC_CHANNELS.exportMeeting, async (_event: unknown, meetingId: unknown) => {
    if (typeof meetingId !== "string" || meetingId.length === 0) {
      throw new StorageError("A meeting ID is required for export.");
    }
    const destination = await chooseDirectory(dialog, "Choose where to export this meeting.");
    if (destination === null) return null;
    const created = await requireStore(runtime).exports.exportMeeting(meetingId, destination);
    return { size: created.size };
  });

  handle(STORAGE_IPC_CHANNELS.exportOfficeDocument, async (_event: unknown, meetingId: unknown, kind: unknown) => {
    if (typeof meetingId !== "string" || meetingId.length === 0) {
      throw new StorageError("A meeting ID is required for export.");
    }
    const exportKind = assertOfficeExportKind(kind);
    const destination = await chooseDirectory(dialog, "Choose where to save this Office document.");
    if (destination === null) return null;
    const created = await runtime.exportOfficeDocument(meetingId, exportKind, destination);
    return {
      kind: created.kind,
      filename: created.filename,
      size: created.size,
      mimeType: created.mimeType,
    };
  });

  handle(STORAGE_IPC_CHANNELS.setAiProcessingPolicy, async (_event: unknown, policy: unknown) => {
    if (!isProcessingPolicy(policy)) {
      throw new StorageError("Unknown AI processing policy.");
    }
    await runtime.setAiProcessingPolicy(policy);
  });
}

export function secureHandler(
  listener: (...args: unknown[]) => unknown,
  getAuthorizedWebContentsId: () => number | undefined,
  getAuthorizedRendererUrl: () => string,
): (...args: unknown[]) => unknown {
  return (event: unknown, ...args: unknown[]) => {
    assertAuthorizedSender(event, getAuthorizedWebContentsId(), getAuthorizedRendererUrl());
    return listener(event, ...args);
  };
}

export function assertAuthorizedSender(event: unknown, authorizedWebContentsId: number | undefined, authorizedRendererUrl: string): void {
  if (
    authorizedWebContentsId === undefined ||
    typeof event !== "object" ||
    event === null ||
    !("sender" in event) ||
    typeof event.sender !== "object" ||
    event.sender === null ||
    !("id" in event.sender) ||
    typeof event.sender.id !== "number" ||
    event.sender.id !== authorizedWebContentsId ||
    !("senderFrame" in event) ||
    typeof event.senderFrame !== "object" ||
    event.senderFrame === null ||
    !("url" in event.senderFrame) ||
    typeof event.senderFrame.url !== "string" ||
    event.senderFrame.url !== authorizedRendererUrl
  ) {
    throw new StorageError("Storage IPC request rejected: unauthorized renderer.");
  }
}

async function chooseDirectory(dialog: DialogLike, title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title, properties: ["openDirectory", "createDirectory"] });
  return result.canceled || result.filePaths[0] === undefined ? null : result.filePaths[0];
}

function requireStore(runtime: StorageRuntime) {
  if (runtime.store === undefined) {
    throw new StorageError("Choose a local data location before using this action.");
  }
  return runtime.store;
}

function isCalendarSyncRequest(value: unknown): value is { startTime: string; endTime: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const request = value as { startTime?: unknown; endTime?: unknown };
  return typeof request.startTime === "string" &&
    typeof request.endTime === "string" &&
    isValidDateString(request.startTime) &&
    isValidDateString(request.endTime) &&
    new Date(request.endTime) > new Date(request.startTime);
}

function isValidDateString(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function isProcessingPolicy(value: unknown): value is AIProcessingPolicy {
  return value === "LOCAL_ONLY" || value === "CLOUD_ALLOWED" || value === "ASK_EACH_TIME";
}
