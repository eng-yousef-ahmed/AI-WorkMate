export const STORAGE_VERSION = 1;
export const DATABASE_SCHEMA_VERSION = 4;

export type CalendarProvider = "MICROSOFT_GRAPH";

export type MeetingPlatform = "TEAMS" | "OTHER_ONLINE" | "NONE";

export interface CalendarEventPerson {
  displayName?: string;
  email?: string;
}

export interface CalendarEventAttendee extends CalendarEventPerson {
  responseStatus?: string;
  type?: string;
}

export interface CalendarOnlineMeetingInfo {
  provider?: string;
  joinUrl?: string;
  conferenceId?: string;
  tollNumber?: string;
}

export interface CalendarEventAssociation {
  provider: CalendarProvider;
  externalEventId: string;
  meetingId: string;
  subject: string;
  startTime: string;
  endTime: string;
  organizer?: CalendarEventPerson;
  attendees: CalendarEventAttendee[];
  location?: string;
  onlineMeeting?: CalendarOnlineMeetingInfo;
  webUrl?: string;
  isCancelled: boolean;
  lastModifiedAt?: string;
  meetingPlatform: MeetingPlatform;
  normalizedFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export type MeetingStatus =
  | "SCHEDULED"
  | "DETECTED"
  | "PREPARING"
  | "RECORDING"
  | "FINALIZING"
  | "PROCESSING"
  | "COMPLETED"
  | "INCOMPLETE"
  | "FAILED"
  | "CANCELLED";

/** Explicit lifecycle transitions. No implicit status changes are allowed. */
export const MEETING_STATUS_TRANSITIONS: Readonly<Record<MeetingStatus, readonly MeetingStatus[]>> = {
  SCHEDULED: ["DETECTED", "PREPARING", "PROCESSING", "INCOMPLETE", "CANCELLED", "FAILED"],
  DETECTED: ["PREPARING", "CANCELLED", "FAILED"],
  PREPARING: ["RECORDING", "CANCELLED", "FAILED", "INCOMPLETE"],
  RECORDING: ["FINALIZING", "INCOMPLETE", "FAILED", "CANCELLED"],
  FINALIZING: ["PROCESSING", "COMPLETED", "INCOMPLETE", "FAILED"],
  PROCESSING: ["COMPLETED", "INCOMPLETE", "FAILED"],
  COMPLETED: ["PROCESSING", "INCOMPLETE"],
  INCOMPLETE: ["PREPARING", "FINALIZING", "PROCESSING", "FAILED", "CANCELLED"],
  FAILED: ["PREPARING", "INCOMPLETE", "CANCELLED"],
  CANCELLED: [],
};

export type ArtifactStatus =
  | "AVAILABLE"
  | "MISSING"
  | "CORRUPTED"
  | "PROCESSING"
  | "DELETED";

export type ArtifactType =
  | "MEETING_MANIFEST"
  | "RECORDING_ORIGINAL"
  | "RECORDING_NORMALIZED"
  | "AUDIO"
  | "TRANSCRIPT_JSON"
  | "TRANSCRIPT_TEXT"
  | "TRANSCRIPT_VTT"
  | "TRANSCRIPT_SRT"
  | "ANALYSIS_SUMMARY_JSON"
  | "ANALYSIS_SUMMARY_MARKDOWN"
  | "ANALYSIS_DECISIONS"
  | "ANALYSIS_TASKS"
  | "ANALYSIS_RISKS"
  | "ANALYSIS_QUESTIONS"
  | "ANALYSIS_FOLLOWUPS"
  | "ATTACHMENT"
  | "DOCUMENT"
  | "EXPORT";

export type RecordingVariant = "ORIGINAL" | "NORMALIZED";

export interface Meeting {
  meetingId: string;
  title: string;
  slug: string;
  folderName: string;
  folderRelativePath: string;
  meetingDate: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
  providerMeetingId?: string;
  calendarEventId?: string;
  status: MeetingStatus;
  storageVersion: number;
  metadata?: Record<string, unknown>;
}

export interface MeetingFolder {
  meeting: Meeting;
  absolutePath: string;
  relativePath: string;
}

export interface Artifact {
  fileId: string;
  meetingId: string;
  relativePath: string;
  artifactType: ArtifactType;
  mimeType: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  sha256: string;
  status: ArtifactStatus;
  recordingVariant?: RecordingVariant;
}

export interface StoredArtifact extends Artifact {
  absolutePath: string;
}

export interface RecordingArtifactInput {
  meetingId: string;
  variant?: RecordingVariant;
  extension: string;
  mimeType: string;
  sourcePath?: string;
  contents?: Uint8Array;
  expectedSha256?: string;
  originalFilename?: string;
  capturedAt?: string;
  sourceMetadata?: Record<string, string | number | boolean | null>;
}

export interface TranscriptSpeaker {
  speakerId: string;
  displayName?: string;
}

export interface TranscriptSegment {
  segmentId: string;
  speakerId?: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

export interface TranscriptDocument {
  meetingId: string;
  speakers: TranscriptSpeaker[];
  timestamps: boolean;
  segments: TranscriptSegment[];
  confidence?: number;
  language: string;
  createdAt: string;
}

export interface TranscriptArtifacts {
  json: Artifact;
  text: Artifact;
  vtt?: Artifact;
  srt?: Artifact;
}

export interface Decision {
  decisionId: string;
  text: string;
  owner?: string;
  decidedAt?: string;
}

export interface ActionItem {
  taskId: string;
  text: string;
  assignee?: string;
  dueDate?: string;
  status?: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
}

export interface AnalysisDocument {
  meetingId: string;
  createdAt: string;
  summary: string;
  decisions: Decision[];
  tasks: ActionItem[];
  risks: string[];
  questions: string[];
  followups: string[];
}

export interface AnalysisArtifacts {
  summaryJson: Artifact;
  summaryMarkdown: Artifact;
  decisions: Artifact;
  tasks: Artifact;
  risks: Artifact;
  questions: Artifact;
  followups: Artifact;
}

export interface StorageStats {
  totalBytes: number;
  recordingsBytes: number;
  audioBytes: number;
  transcriptsBytes: number;
  documentsBytes: number;
  databaseBytes: number;
  availableBytes: number | null;
  fileCount: number;
  meetingCount: number;
}

export interface DataRootValidation {
  path: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
  availableBytes: number | null;
  requiredBytes: number;
  errors: string[];
}

export interface MigrationPlan {
  source: string;
  destination: string;
  bytesToMove: number;
  filesToMove: number;
  meetingCount: number;
  destinationAvailableBytes: number | null;
  requiredBytes: number;
  explanation: string[];
}

export interface MigrationResult {
  plan: MigrationPlan;
  verified: boolean;
  sourcePreserved: boolean;
  destination: string;
  copiedFiles: number;
}

export type MigrationJournalState =
  | "STARTED"
  | "COPYING"
  | "VERIFIED"
  | "ACTIVATING"
  | "ACTIVATED"
  | "RUNTIME_SWITCHED"
  | "CONFIGURATION_UPDATED"
  | "FAILED"
  | "INCOMPLETE";

export interface MigrationJournal {
  operationId: string;
  source: string;
  destination: string;
  state: MigrationJournalState;
  updatedAt: string;
  error?: string;
}

export type ArtifactOperationState =
  | "STARTED"
  | "WRITING"
  | "FINALIZING"
  | "COMMITTED"
  | "FAILED"
  | "INCOMPLETE";

export interface ArtifactOperation {
  operationId: string;
  meetingId: string;
  relativePath: string;
  artifactType: ArtifactType;
  state: ArtifactOperationState;
  fileId?: string;
  expectedSha256?: string;
  actualSha256?: string;
  size?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrityIssue {
  kind:
    | "MISSING_ARTIFACT"
    | "CORRUPTED_ARTIFACT"
    | "ORPHANED_FILE"
    | "UNKNOWN_MEETING_FOLDER"
    | "INCOMPLETE_RECORDING"
    | "MISSING_DATABASE"
    | "INVALID_MANIFEST"
    | "INCOMPLETE_ARTIFACT_OPERATION";
  path: string;
  meetingId?: string;
  fileId?: string;
  details: string;
}

export interface IntegrityReport {
  checkedAt: string;
  issues: IntegrityIssue[];
  checkedArtifacts: number;
  availableArtifacts: number;
  repairedArtifacts: number;
}

export interface StorageManifest {
  storageVersion: number;
  createdAt: string;
  updatedAt: string;
  dataRootLabel: string;
}

export interface StorageLocationMetadata {
  type: "LOCAL";
  label: string;
  pathExposed: false;
}

export interface StorageSnapshot {
  dataLocation: StorageLocationMetadata;
  stats: StorageStats;
  storageVersion: number;
  aiProcessingPolicy: AIProcessingPolicy;
  lastIntegrityCheckAt?: string;
  migrationRecoveryRequired?: boolean;
}

export type AIProcessingPolicy = "LOCAL_ONLY" | "CLOUD_ALLOWED" | "ASK_EACH_TIME";

export interface BackupManifest {
  format: "AI_WORKMATE_BACKUP";
  formatVersion: 1;
  storageVersion: number;
  createdAt: string;
  sourceDataRoot: string;
  includes: string[];
  fileCount: number;
  sha256ByPath: Record<string, string>;
}

export interface ExportManifest {
  format: "AI_WORKMATE_MEETING_EXPORT";
  formatVersion: 1;
  exportedAt: string;
  meetingId: string;
  relationship: string;
  files: string[];
}

export interface StorageFileCandidate {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
}
