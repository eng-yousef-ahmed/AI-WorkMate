import type {
  ArtifactStatus,
  ArtifactType,
  CalendarProvider,
  MeetingPlatform,
  MeetingStatus,
  RecordingVariant,
} from "./models";

/**
 * Renderer-safe meeting hub data transfer types. These are the only shapes
 * that cross the main-process boundary for the meetings workspace: they carry
 * meeting/calendar metadata, artifact records, transcript metadata, and
 * analysis text — never absolute filesystem paths, DATA_ROOT locations,
 * credentials, OAuth tokens, or raw provider errors.
 */

export interface HubCalendarInfo {
  provider: CalendarProvider;
  externalEventId: string;
  subject: string;
  startTime: string;
  endTime: string;
  location?: string;
  webUrl?: string;
  joinUrl?: string;
  onlineMeetingProvider?: string;
  meetingPlatform: MeetingPlatform;
  isCancelled: boolean;
}

export interface HubMeetingSummary {
  meetingId: string;
  title: string;
  meetingDate: string;
  status: MeetingStatus;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
  providerMeetingId?: string;
  calendarEventId?: string;
  /** Calendar association when this meeting came from (or is linked to) a synced calendar event. */
  calendar?: HubCalendarInfo;
  isActive: boolean;
  artifactCount: number;
  hasRecording: boolean;
  hasTranscript: boolean;
  hasAnalysis: boolean;
}

export interface MeetingHubOverview {
  serverTime: string;
  /** Day label of the "today" section (the local day on the machine). */
  todayLabel: string;
  today: HubMeetingSummary[];
  upcoming: HubMeetingSummary[];
  recent: HubMeetingSummary[];
  historyTotal: number;
}

export interface HubArtifactInfo {
  fileId: string;
  artifactType: ArtifactType;
  mimeType: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  status: ArtifactStatus;
  recordingVariant?: RecordingVariant;
  /** Renderer-safe display label derived from the artifact type. */
  label: string;
}

export interface HubTranscriptInfo {
  transcriptId: string;
  language: string;
  createdAt: string;
  engineId?: string;
  recordingId?: string;
  /** File ids for each available transcript artifact. */
  textArtifactId?: string;
  jsonArtifactId?: string;
  vttArtifactId?: string;
  srtArtifactId?: string;
}

export interface HubTaskInfo {
  taskId: string;
  text: string;
  assignee?: string;
  dueDate?: string;
  status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  createdAt: string;
}

export interface HubDecisionInfo {
  decisionId: string;
  text: string;
  owner?: string;
  decidedAt?: string;
}

/** Latest grounded analysis summary for a meeting (already quality-gated when stored). */
export interface HubAnalysisDocument {
  meetingId: string;
  createdAt: string;
  summary: string;
  decisions: HubDecisionInfo[];
  tasks: HubTaskInfo[];
  risks: string[];
  questions: string[];
  followups: string[];
}

export interface MeetingDetail {
  meeting: HubMeetingSummary;
  /** Renderer-safe folder identity (name only, never an absolute path). */
  folderLabel: string;
  artifacts: HubArtifactInfo[];
  transcripts: HubTranscriptInfo[];
  analysis?: HubAnalysisDocument;
  processingJobs: HubProcessingJobInfo[];
}

export interface HubProcessingJobInfo {
  jobId: string;
  jobType: string;
  state: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "INCOMPLETE";
  createdAt: string;
  error?: string;
}

export interface TranscriptSearchHit {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  meetingStatus: MeetingStatus;
  transcriptId: string;
  language: string;
  /** Snippet centered on the first matching span, trimmed to ~280 chars. */
  snippet: string;
  /** The rendered transcript artifact this hit came from. */
  artifactFileId: string;
}

export interface TranscriptSearchResults {
  query: string;
  hitCount: number;
  matches: TranscriptSearchHit[];
  truncated: boolean;
}

/** Sanitized live capture snapshot for a meeting (no paths, no tokens). */
export interface HubCaptureSnapshot {
  flowId: string;
  meetingId: string;
  phase: "STARTING" | "RECORDING" | "STOPPING" | "COMPLETED" | "INCOMPLETE" | "FAILED" | "CANCELLED";
  meetingStatus: MeetingStatus;
  startedAt: string;
  requestedCapabilities: string[];
  startedCapabilities: string[];
  activeSources: string[];
  error?: { code?: string; message: string; failed: boolean };
}

/**
 * Renderer-sendable capture request (booleans + optional window source id).
 * Omit `meetingId` to start a standalone local meeting: the capture flow
 * creates the meeting itself and `title` (when provided) names it. An
 * explicit `meetingId` must reference an existing meeting (calendar-linked
 * behavior is unchanged).
 */
export interface HubCaptureRequest {
  meetingId?: string;
  title?: string;
  microphone: boolean;
  systemLoopback: boolean;
  screen: boolean;
  window?: string;
}

/**
 * Online-meeting platform classification for assisted flows. Classified in
 * the main process from persisted calendar URLs; the renderer only ever
 * receives the label and the recommended capture booleans.
 */
export type HubMeetingPlatformKind = "TEAMS" | "ZOOM" | "GOOGLE_MEET" | "OTHER_ONLINE" | "NONE";

export interface HubAssistChecklistItem {
  id: string;
  title: string;
  note?: string;
}

/**
 * Renderer-safe assisted capture plan for one calendar-linked meeting. No
 * URLs, absolute paths, window source ids, or capability internals cross
 * the boundary; `window` uses "" to request the native deterministic window
 * default.
 */
export interface HubMeetingAssistPlan {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  platform: HubMeetingPlatformKind;
  platformLabel: string;
  captureSupported: boolean;
  joinLinkAvailable: boolean;
  recommended: HubCaptureRequest;
  rationale: string[];
  checklist: HubAssistChecklistItem[];
}

export interface HubSearchRequest {
  query: string;
  limit?: number;
}

export interface HubTranscriptContent {
  transcriptId: string;
  meetingId: string;
  language: string;
  createdAt: string;
  /** UTF-8 text of the rendered transcript (capped at HUB_MAX_TRANSCRIPT_READ_BYTES). */
  text?: string;
  truncated: boolean;
  available: boolean;
  reason?: string;
  artifactFileId: string;
}

export interface HubCaptureCapabilities {
  supported: boolean;
  platform?: string;
  adapterId?: string;
  microphone: boolean;
  systemLoopback: boolean;
  screen: boolean;
  window: boolean;
}

/** One verbatim evidence window used to ground a chat answer. */
export interface HubChatEvidenceSource {
  sourceId: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  transcriptId: string;
  artifactFileId: string;
  language: string;
  /** Verbatim transcript excerpt (bounded window, exact file text). */
  snippet: string;
}

export interface HubChatRequest {
  question: string;
  /** Optional scope: only meetings whose ids are listed. */
  meetingIds?: string[];
}

export type HubChatRefusalReason = "NO_EVIDENCE" | "GROUNDING_FAILED";

export interface HubChatAnswer {
  question: string;
  /** Verbatim model text when grounded; the standard refusal line otherwise. */
  answer: string;
  refusal: boolean;
  refusalReason?: HubChatRefusalReason;
  /** Sources actually used as evidence (empty on refusal). */
  evidence: HubChatEvidenceSource[];
  providerId?: string;
  createdAt: string;
}

/** Task status values shared with the renderer. */
export type HubTaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export type HubTaskSourceKind = "MANUAL" | "ANALYSIS_TASKS" | "ANALYSIS_FOLLOWUPS";

/** A task with full provenance, ready for the renderer (never contains paths). */
export interface HubTaskItem {
  taskId: string;
  text: string;
  assignee?: string;
  dueDate?: string;
  status: HubTaskStatus;
  createdAt: string;
  updatedAt: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  /** MANUAL, or ANALYSIS_* when created from a persisted analysis artifact. */
  sourceKind: HubTaskSourceKind;
  /** ISO date of the analysis the task came from (undefined for MANUAL). */
  analysisDate?: string;
}

/** Create input: manual tasks must declare their originating meeting. */
export interface HubTaskCreateInput {
  meetingId: string;
  text: string;
  assignee?: string;
  dueDate?: string;
  /** Reserved for converting analysis follow-ups; set by the service. */
  sourceArtifactId?: string;
}

export interface HubTaskUpdateInput {
  text?: string;
  /** Provide null to clear the assignee. */
  assignee?: string | null;
  /** Provide null to clear the due date. */
  dueDate?: string | null;
}

/** Analysis follow-ups offered for conversion into managed tasks. */
export interface HubFollowupSuggestion {
  followupId: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  analysisDate: string;
  /** The persisted ANALYSIS_FOLLOWUPS artifact this came from. */
  sourceArtifactFileId: string;
  text: string;
  /** True when an identical task already exists from the same follow-up artifact. */
  alreadyTask: boolean;
}

export type HubNotificationKind =
  | "MEETING_READY"
  | "MEETING_ISSUE"
  | "TASK_DUE"
  | "FOLLOWUP_DIGEST"
  | "MEETING_DETECTED"
  | "MEETING_PREPARATION"
  | "MEETING_SUMMARY_READY"
  | "TASK_ASSIGNED"
  | "TASK_OVERDUE"
  | "DAILY_MEETING_REPORT"
  | "UNRESOLVED_FOLLOWUPS";
export type HubNotificationAction = "open-meeting" | "open-tasks";

/**
 * Notification-center entry. Renderer-safe: carries meeting/task references
 * and display text only — never absolute paths, DATA_ROOT, or artifact
 * content beyond the composed title/body.
 */
export interface HubNotification {
  notificationId: string;
  kind: HubNotificationKind;
  severity: "INFO" | "WARNING";
  title: string;
  body: string;
  createdAt: string;
  /** Set once the user opened/dismissed the notification. */
  readAt: string | null;
  meetingId?: string;
  taskId?: string;
  /** Renderer navigation hint when the notification points at a meeting/task. */
  action?: HubNotificationAction;
}

/** Automation and popup preferences (persisted locally, no secrets). */
export interface HubNotificationSettings {
  /** Master switch: OS popups and automated alerts (due tasks/digest). */
  notificationsEnabled: boolean;
  /** Opt-in daily local digest of open tasks and follow-ups. Default OFF. */
  digestEnabled: boolean;
  /** Local 24h "HH:MM" time after which the daily digest may fire. */
  digestTime: string;
  updatedAt: string;
}

export interface HubNotificationSettingsInput {
  notificationsEnabled?: boolean;
  digestEnabled?: boolean;
  digestTime?: string;
}

/** Notification-center page payload: newest-first items plus total unread. */
export interface HubNotificationPage {
  notifications: HubNotification[];
  unread: number;
}

export const HUB_MAX_TRANSCRIPT_READ_BYTES = 24 * 1024 * 1024;
export const HUB_MAX_ANALYSIS_READ_BYTES = 8 * 1024 * 1024;

/** User-controlled automations. All notification kinds default OFF except meeting detection lifecycle. */
export interface HubAutomationPreferences {
  /** Advance SCHEDULED calendar meetings to DETECTED near start time (local lifecycle, no external side effects). */
  meetingDetection: boolean;
  meetingPreparation: boolean;
  meetingPreparationMinutes: number;
  meetingSummaries: boolean;
  assignedTaskNotifications: boolean;
  overdueReminders: boolean;
  dailyMeetingReports: boolean;
  unresolvedFollowupReminders: boolean;
  captureMicrophone: boolean;
  captureSystemLoopback: boolean;
  captureScreen: boolean;
}

/** Renderer-safe local notification (never contains paths, tokens, or credentials). */
export interface HubNotificationItem {
  notificationId: string;
  kind: HubNotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  meetingId?: string;
  taskId?: string;
}

export interface HubAutomationTickResult {
  detectedMeetings: number;
  createdNotifications: number;
  skippedDuplicates: number;
}

export type HubJoinPlatform = "TEAMS" | "ZOOM" | "GOOGLE_MEET" | "OTHER_ONLINE" | "NONE";

export type HubAssistedJoinNextAction = "OPEN_JOIN_URL" | "RECORD_ONLY" | "UNAVAILABLE";

/**
 * Assisted meeting-join plan. The join URL itself is never accepted from the
 * renderer; this DTO describes what the user should do. Opening still uses
 * the persisted calendar association in the main process.
 */
export interface HubAssistedJoinPlan {
  meetingId: string;
  meetingTitle: string;
  platform: HubJoinPlatform;
  platformLabel: string;
  hasJoinUrl: boolean;
  nextAction: HubAssistedJoinNextAction;
  steps: string[];
  warnings: string[];
}

export type HubOfficeExportKind = "WORD_SUMMARY" | "EXCEL_TASKS" | "POWERPOINT_BRIEFING";

export interface HubOfficeExportResult {
  kind: HubOfficeExportKind;
  filename: string;
  size: number;
  mimeType: string;
}

export interface HubHistoryFilter {
  status?: MeetingStatus;
  provider?: CalendarProvider;
  query?: string;
  limit?: number;
}
