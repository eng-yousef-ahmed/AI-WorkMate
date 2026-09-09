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

/** Renderer-sendable capture request (booleans + optional window source id). */
export interface HubCaptureRequest {
  meetingId: string;
  microphone: boolean;
  systemLoopback: boolean;
  screen: boolean;
  window?: string;
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

export const HUB_MAX_TRANSCRIPT_READ_BYTES = 24 * 1024 * 1024;
export const HUB_MAX_ANALYSIS_READ_BYTES = 8 * 1024 * 1024;
