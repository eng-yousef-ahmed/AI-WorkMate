import type {
  AIProcessingPolicy,
  IntegrityReport,
  StorageSnapshot,
} from "../domain/models";
import type { RendererCalendarSyncResult } from "../calendar/CalendarModels";
export interface LocationChangeResult {
  migrated: boolean;
  verified?: boolean;
  sourcePreserved?: boolean;
  copiedFiles?: number;
}

export const STORAGE_IPC_CHANNELS = {
  getSnapshot: "storage:get-snapshot",
  chooseInitialLocation: "storage:choose-initial-location",
  prepareLocationChange: "storage:prepare-location-change",
  confirmLocationChange: "storage:confirm-location-change",
  openDataFolder: "storage:open-data-folder",
  verifyStorage: "storage:verify-storage",
  repairStorage: "storage:repair-storage",
  createBackup: "storage:create-backup",
  restoreBackup: "storage:restore-backup",
  exportMeeting: "storage:export-meeting",
  setAiProcessingPolicy: "storage:set-ai-processing-policy",
  syncMicrosoftCalendar: "calendar:sync-microsoft",
} as const;

export interface LocationChangePreview {
  canceled: boolean;
  requestId?: string;
  bytesToMove?: number;
  filesToMove?: number;
  meetingCount?: number;
  destinationAvailableBytes?: number | null;
  requiredBytes?: number;
  explanation?: string[];
}

export interface MicrosoftCalendarSyncRequest {
  startTime: string;
  endTime: string;
}

export interface StorageRendererAPI {
  getSnapshot(): Promise<StorageSnapshot>;
  chooseInitialLocation(): Promise<StorageSnapshot | null>;
  prepareLocationChange(): Promise<LocationChangePreview>;
  confirmLocationChange(requestId: string, migrateExistingData: boolean): Promise<LocationChangeResult>;
  openDataFolder(): Promise<void>;
  verifyStorage(): Promise<IntegrityReport>;
  repairStorage(): Promise<IntegrityReport>;
  createBackup(): Promise<{ size: number } | null>;
  restoreBackup(): Promise<{ verified: boolean; restoredFiles: number } | null>;
  exportMeeting(meetingId: string): Promise<{ size: number } | null>;
  setAiProcessingPolicy(policy: AIProcessingPolicy): Promise<void>;
  syncMicrosoftCalendar(request: MicrosoftCalendarSyncRequest): Promise<RendererCalendarSyncResult>;
}

export type { AIProcessingPolicy, IntegrityReport, RendererCalendarSyncResult, StorageSnapshot };
