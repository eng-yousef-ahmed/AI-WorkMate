import { randomUUID } from "node:crypto";

import type { AIProcessingPolicy, StorageSnapshot } from "../domain/models";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import { STORAGE_IPC_CHANNELS, type LocationChangePreview } from "./storage-api";

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
}

/**
 * Main-process-only handlers. Renderer input is limited to IDs, booleans, and
 * an allow-listed policy; all filesystem paths come from native dialogs or the
 * runtime's already-authorized DATA_ROOT.
 */
export function registerStorageIpc({ ipcMain, dialog, shell, runtime }: StorageIpcDependencies): void {
  const pendingLocationChanges = new Map<string, string>();
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(listener));
  };

  handle(STORAGE_IPC_CHANNELS.getSnapshot, async (): Promise<StorageSnapshot> => runtime.getSnapshot());

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
      return runtime.changeDataRoot(selected, migrateExistingData);
    },
  );

  handle(STORAGE_IPC_CHANNELS.openDataFolder, async (): Promise<void> => {
    await shell.openPath(runtime.getDataRoot());
  });
  handle(STORAGE_IPC_CHANNELS.verifyStorage, async () => runtime.verifyStorage());
  handle(STORAGE_IPC_CHANNELS.repairStorage, async () => runtime.repairStorage());

  handle(STORAGE_IPC_CHANNELS.createBackup, async () => {
    const selected = await chooseDirectory(dialog, "Choose a local backup folder.");
    if (selected === null) return null;
    const created = await requireStore(runtime).backups.createBackup(selected);
    return { path: created.path, size: created.size };
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
    return { destination: restored.destination, verified: restored.verified, restoredFiles: restored.restoredFiles };
  });

  handle(STORAGE_IPC_CHANNELS.exportMeeting, async (_event: unknown, meetingId: unknown) => {
    if (typeof meetingId !== "string" || meetingId.length === 0) {
      throw new StorageError("A meeting ID is required for export.");
    }
    const destination = await chooseDirectory(dialog, "Choose where to export this meeting.");
    if (destination === null) return null;
    const created = await requireStore(runtime).exports.exportMeeting(meetingId, destination);
    return { path: created.path, size: created.size };
  });

  handle(STORAGE_IPC_CHANNELS.setAiProcessingPolicy, async (_event: unknown, policy: unknown) => {
    if (!isProcessingPolicy(policy)) {
      throw new StorageError("Unknown AI processing policy.");
    }
    await runtime.setAiProcessingPolicy(policy);
  });
}

function secureHandler(listener: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return (event: unknown, ...args: unknown[]) => {
    assertAuthorizedSender(event);
    return listener(event, ...args);
  };
}

function assertAuthorizedSender(event: unknown): void {
  if (
    typeof event !== "object" ||
    event === null ||
    !("senderFrame" in event) ||
    typeof event.senderFrame !== "object" ||
    event.senderFrame === null ||
    !("url" in event.senderFrame) ||
    typeof event.senderFrame.url !== "string" ||
    !event.senderFrame.url.startsWith("file://")
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

function isProcessingPolicy(value: unknown): value is AIProcessingPolicy {
  return value === "LOCAL_ONLY" || value === "CLOUD_ALLOWED" || value === "ASK_EACH_TIME";
}
