import { contextBridge, ipcRenderer } from "electron";

import type { AIProcessingPolicy } from "../domain/models";
import { STORAGE_IPC_CHANNELS, type StorageRendererAPI } from "./storage-api";

const storageApi: StorageRendererAPI = {
  getSnapshot: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.getSnapshot),
  chooseInitialLocation: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.chooseInitialLocation),
  prepareLocationChange: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.prepareLocationChange),
  confirmLocationChange: (requestId, migrateExistingData) =>
    ipcRenderer.invoke(STORAGE_IPC_CHANNELS.confirmLocationChange, requestId, migrateExistingData),
  openDataFolder: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.openDataFolder),
  verifyStorage: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.verifyStorage),
  repairStorage: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.repairStorage),
  createBackup: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.createBackup),
  restoreBackup: () => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.restoreBackup),
  exportMeeting: (meetingId) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.exportMeeting, meetingId),
  setAiProcessingPolicy: (policy: AIProcessingPolicy) =>
    ipcRenderer.invoke(STORAGE_IPC_CHANNELS.setAiProcessingPolicy, policy),
  syncMicrosoftCalendar: (request) => ipcRenderer.invoke(STORAGE_IPC_CHANNELS.syncMicrosoftCalendar, request),
};

contextBridge.exposeInMainWorld("aiWorkMate", { storage: storageApi });
