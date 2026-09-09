import type {
  AIProcessingPolicy,
  IntegrityReport,
  StorageSnapshot,
} from "../domain/models";
import type { RendererCalendarSyncResult } from "../calendar/CalendarModels";
import type {
  BeginCalendarSignInResult,
  CalendarConnectionStatus,
  CompleteCalendarSignInInput,
} from "../calendar/CalendarConnection";

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

export const CALENDAR_IPC_CHANNELS = {
  getMicrosoftStatus: "calendar:microsoft-status",
  beginMicrosoftSignIn: "calendar:microsoft-begin-sign-in",
  completeMicrosoftSignIn: "calendar:microsoft-complete-sign-in",
  cancelMicrosoftSignIn: "calendar:microsoft-cancel-sign-in",
  disconnectMicrosoft: "calendar:microsoft-disconnect",
  syncMicrosoftCalendarAuto: "calendar:sync-microsoft-auto",
  saveMicrosoftOAuthConfig: "calendar:microsoft-save-oauth-config",
} as const;

/** Renderer-sendable Microsoft OAuth application settings (no secrets). */
export interface MicrosoftOAuthSettingsInput {
  clientId?: string;
  tenant?: string;
  redirectUri?: string;
}

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

/**
 * Calendar connection surface. Every payload is sanitized in the main
 * process: no tokens, verifiers, state values, cursor URLs, or provider
 * error bodies cross this boundary.
 */
export interface CalendarRendererAPI {
  getMicrosoftStatus(): Promise<CalendarConnectionStatus | undefined>;
  beginMicrosoftSignIn(): Promise<BeginCalendarSignInResult>;
  completeMicrosoftSignIn(input: CompleteCalendarSignInInput): Promise<CalendarConnectionStatus>;
  cancelMicrosoftSignIn(): Promise<void>;
  disconnectMicrosoft(): Promise<CalendarConnectionStatus>;
  syncMicrosoftCalendarAuto(): Promise<RendererCalendarSyncResult>;
  syncMicrosoftCalendar(request: MicrosoftCalendarSyncRequest): Promise<RendererCalendarSyncResult>;
  saveMicrosoftOAuthConfig(input: MicrosoftOAuthSettingsInput): Promise<CalendarConnectionStatus>;
}

export type {
  AIProcessingPolicy,
  BeginCalendarSignInResult,
  CalendarConnectionStatus,
  CompleteCalendarSignInInput,
  IntegrityReport,
  RendererCalendarSyncResult,
  StorageSnapshot,
};
