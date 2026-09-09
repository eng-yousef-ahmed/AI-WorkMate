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
import type {
  HubAnalysisDocument,
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubCaptureSnapshot,
  HubChatAnswer,
  HubTranscriptContent,
  MeetingDetail,
  MeetingHubOverview,
  TranscriptSearchResults,
} from "../domain/hub";

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

export const MEETINGS_IPC_CHANNELS = {
  getOverview: "meetings:overview",
  getDetail: "meetings:detail",
  getTranscriptContent: "meetings:transcript-content",
  searchTranscripts: "meetings:search-transcripts",
  getAnalysis: "meetings:analysis",
  getCaptureCapabilities: "meetings:capture-capabilities",
  startCapture: "meetings:capture-start",
  stopCapture: "meetings:capture-stop",
  abortCapture: "meetings:capture-abort",
  listActiveCaptures: "meetings:capture-active",
  processMeeting: "meetings:process",
  openLinkedUrl: "meetings:open-linked-url",
  askMeetingHistory: "meetings:chat-ask",
} as const;

export const CALENDAR_IPC_CHANNELS = {
  getMicrosoftStatus: "calendar:microsoft-status",
  beginMicrosoftSignIn: "calendar:microsoft-begin-sign-in",
  completeMicrosoftSignIn: "calendar:microsoft-complete-sign-in",
  cancelMicrosoftSignIn: "calendar:microsoft-cancel-sign-in",
  disconnectMicrosoft: "calendar:microsoft-disconnect",
  syncMicrosoftCalendarAuto: "calendar:sync-microsoft-auto",
  saveMicrosoftOAuthConfig: "calendar:microsoft-save-oauth-config",
  getGoogleStatus: "calendar:google-status",
  beginGoogleSignIn: "calendar:google-begin-sign-in",
  completeGoogleSignIn: "calendar:google-complete-sign-in",
  cancelGoogleSignIn: "calendar:google-cancel-sign-in",
  disconnectGoogle: "calendar:google-disconnect",
  syncGoogleCalendarAuto: "calendar:sync-google-auto",
  saveGoogleOAuthConfig: "calendar:google-save-oauth-config",
} as const;

/** Renderer-sendable Microsoft OAuth application settings (no secrets). */
export interface MicrosoftOAuthSettingsInput {
  clientId?: string;
  tenant?: string;
  redirectUri?: string;
}

/** Renderer-sendable Google OAuth application settings (no secrets). */
export interface GoogleOAuthSettingsInput {
  clientId?: string;
  clientSecret?: string;
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
 * Meeting Hub surface. Every payload is renderer-safe DTO materialized in the
 * main process: meeting/artifact/transcript metadata and transcript text.
 * Absolute filesystem paths, DATA_ROOT, credentials, and provider cursors
 * never cross this boundary.
 */
export interface MeetingsRendererAPI {
  getOverview(): Promise<MeetingHubOverview>;
  getDetail(meetingId: string): Promise<MeetingDetail>;
  getTranscriptContent(meetingId: string, transcriptId: string): Promise<HubTranscriptContent>;
  searchTranscripts(query: string, limit?: number): Promise<TranscriptSearchResults>;
  getAnalysis(meetingId: string): Promise<HubAnalysisDocument | undefined>;
  getCaptureCapabilities(): Promise<HubCaptureCapabilities>;
  startCapture(request: HubCaptureRequest): Promise<HubCaptureSnapshot>;
  stopCapture(meetingId: string): Promise<HubCaptureSnapshot>;
  abortCapture(meetingId: string, reason?: string): Promise<HubCaptureSnapshot>;
  listActiveCaptures(): Promise<HubCaptureSnapshot[]>;
  processMeeting(meetingId: string, userApprovedForThisRequest?: boolean): Promise<void>;
  /** Opens the persisted join/web URL of a linked calendar event in the browser. */
  openLinkedUrl(meetingId: string, kind: "JOIN" | "WEB"): Promise<void>;
  /**
   * Asks a question grounded ONLY in the persisted local meeting transcripts.
   * Answers always carry `[meeting · …]` verbatim citations or a refusal;
   * meeting content is processed only by the local model in this process.
   */
  askMeetingHistory(question: string, meetingIds?: string[]): Promise<HubChatAnswer>;
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
  getGoogleStatus(): Promise<CalendarConnectionStatus | undefined>;
  beginGoogleSignIn(): Promise<BeginCalendarSignInResult>;
  completeGoogleSignIn(input: CompleteCalendarSignInInput): Promise<CalendarConnectionStatus>;
  cancelGoogleSignIn(): Promise<void>;
  disconnectGoogle(): Promise<CalendarConnectionStatus>;
  syncGoogleCalendarAuto(): Promise<RendererCalendarSyncResult>;
  saveGoogleOAuthConfig(input: GoogleOAuthSettingsInput): Promise<CalendarConnectionStatus>;
}

export type {
  AIProcessingPolicy,
  BeginCalendarSignInResult,
  CalendarConnectionStatus,
  CompleteCalendarSignInInput,
  HubAnalysisDocument,
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubCaptureSnapshot,
  HubChatAnswer,
  HubTranscriptContent,
  IntegrityReport,
  MeetingDetail,
  MeetingHubOverview,
  RendererCalendarSyncResult,
  StorageSnapshot,
  TranscriptSearchResults,
};
