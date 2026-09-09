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
  HubAssistedJoinPlan,
  HubAutomationPreferences,
  HubAutomationTickResult,
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubCaptureSnapshot,
  HubChatAnswer,
  HubFollowupSuggestion,
  HubHistoryFilter,
  HubMeetingSummary,
  HubNotificationItem,
  HubOfficeExportKind,
  HubOfficeExportResult,
  HubTaskCreateInput,
  HubTaskItem,
  HubTaskStatus,
  HubTaskUpdateInput,
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
  exportOfficeDocument: "storage:export-office",
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
  listHistory: "meetings:history",
  getAssistedJoinPlan: "meetings:assisted-join-plan",
  beginAssistedJoin: "meetings:assisted-join-begin",
} as const;

export const AUTOMATION_IPC_CHANNELS = {
  getPreferences: "automation:get-preferences",
  setPreferences: "automation:set-preferences",
  listNotifications: "automation:list-notifications",
  markRead: "automation:mark-read",
  runTick: "automation:run-tick",
} as const;

export const TASKS_IPC_CHANNELS = {
  listTasks: "tasks:list",
  getTask: "tasks:get",
  createTask: "tasks:create",
  updateTask: "tasks:update",
  setTaskStatus: "tasks:status",
  listFollowupSuggestions: "tasks:followups-list",
  convertFollowup: "tasks:followups-convert",
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
  exportOfficeDocument(meetingId: string, kind: HubOfficeExportKind): Promise<HubOfficeExportResult | null>;
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
  listHistory(filter?: HubHistoryFilter): Promise<HubMeetingSummary[]>;
  getAssistedJoinPlan(meetingId: string): Promise<HubAssistedJoinPlan>;
  beginAssistedJoin(meetingId: string): Promise<HubAssistedJoinPlan>;
}

export interface AutomationRendererAPI {
  getPreferences(): Promise<HubAutomationPreferences>;
  setPreferences(patch: Partial<HubAutomationPreferences>): Promise<HubAutomationPreferences>;
  listNotifications(query?: { unreadOnly?: boolean; limit?: number }): Promise<HubNotificationItem[]>;
  markRead(notificationId: string): Promise<HubNotificationItem | undefined>;
  runTick(): Promise<HubAutomationTickResult>;
}

export interface TaskListQuery {
  meetingId?: string;
  status?: HubTaskStatus;
  limit?: number;
}

/**
 * Task surface. The renderer sends only task fields and status names; every
 * item it receives carries meeting provenance (title/date) and, for tasks
 * born from an analysis, the analysis date — never artifact paths or content.
 */
export interface TasksRendererAPI {
  listTasks(query?: TaskListQuery): Promise<HubTaskItem[]>;
  getTask(taskId: string): Promise<HubTaskItem | undefined>;
  createTask(input: HubTaskCreateInput): Promise<HubTaskItem>;
  updateTask(taskId: string, patch: HubTaskUpdateInput): Promise<HubTaskItem>;
  setTaskStatus(taskId: string, status: HubTaskStatus): Promise<HubTaskItem>;
  listFollowupSuggestions(meetingId?: string): Promise<HubFollowupSuggestion[]>;
  convertFollowup(followupId: string): Promise<HubTaskItem>;
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
  HubFollowupSuggestion,
  HubTaskCreateInput,
  HubTaskItem,
  HubTaskStatus,
  HubTaskUpdateInput,
  HubTranscriptContent,
  IntegrityReport,
  MeetingDetail,
  MeetingHubOverview,
  RendererCalendarSyncResult,
  StorageSnapshot,
  TranscriptSearchResults,
};
