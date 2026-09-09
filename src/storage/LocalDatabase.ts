import { backup, DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DATABASE_SCHEMA_VERSION,
  type ActionItem,
  type Artifact,
  type CalendarEventAssociation,
  type CalendarProvider,
  type ArtifactOperation,
  type ArtifactOperationState,
  type ArtifactStatus,
  type Decision,
  type Meeting,
  type MeetingStatus,
  MEETING_STATUS_TRANSITIONS,
  type MeetingPlatform,
  type RecordingFinalStatus,
  type RecordingMetadata,
  type RecordingVariant,
} from "../domain/models";
import type { CalendarSyncStateRecord } from "../calendar/CalendarModels";
import { DuplicateMeetingError, StorageError, InvalidMeetingTransitionError } from "./errors";

export interface DuplicateMeetingKeys {
  providerMeetingId?: string;
  calendarEventId?: string;
  recordingSha256?: string;
}

export interface TranscriptRecord {
  transcriptId: string;
  meetingId: string;
  jsonArtifactId: string;
  textArtifactId: string;
  vttArtifactId?: string;
  srtArtifactId?: string;
  language: string;
  createdAt: string;
  recordingId?: string;
  engineId?: string;
  sourceCapability?: string;
  sourceSha256?: string;
}

export interface AnalysisRecord {
  analysisId: string;
  meetingId: string;
  kind: string;
  artifactId: string;
  createdAt: string;
  sourceTranscriptIds?: string;
  sourceTranscriptShas?: string;
}

export interface ProcessingJobRecord {
  jobId: string;
  meetingId: string;
  jobType: string;
  state: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "INCOMPLETE";
  engineId?: string;
  modelId?: string;
  sourceRecordingId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantRecord {
  participantId: string;
  displayName: string;
  email?: string;
  createdAt: string;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord extends ActionItem {
  meetingId: string;
  projectId?: string;
  /**
   * Provenance: the persisted artifact (analysis task/follow-up JSON) this
   * task was created from, when it came out of a meeting analysis. Manual
   * tasks have none.
   */
  sourceArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatusValue = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export interface TaskUpdateFields {
  text?: string;
  assignee?: string | null;
  dueDate?: string | null;
  status?: TaskStatusValue;
  sourceArtifactId?: string | null;
  updatedAt?: string;
}

export interface DecisionRecord extends Decision {
  meetingId: string;
  createdAt: string;
}

export interface AuditRecord {
  auditId: string;
  action: string;
  meetingId?: string;
  artifactId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export type NotificationKind = "MEETING_READY" | "MEETING_ISSUE" | "TASK_DUE" | "FOLLOWUP_DIGEST";
export type NotificationSeverity = "INFO" | "WARNING";
export type NotificationAction = "open-meeting" | "open-tasks";

export interface NotificationRecord {
  notificationId: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
  meetingId?: string;
  taskId?: string;
  action?: NotificationAction;
  /** Unique event identity used to make every notification idempotent. */
  dedupeKey: string;
}

export interface ArtifactOperationUpdate {
  state: ArtifactOperationState;
  fileId?: string;
  actualSha256?: string;
  size?: number;
  error?: string;
}

export type RecordingRecord = RecordingMetadata;

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  folder_name TEXT NOT NULL UNIQUE,
  folder_relative_path TEXT NOT NULL UNIQUE,
  meeting_date TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider_meeting_id TEXT,
  calendar_event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'DETECTED', 'PREPARING', 'RECORDING', 'FINALIZING', 'PROCESSING', 'COMPLETED', 'INCOMPLETE', 'FAILED', 'CANCELLED')),
  storage_version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS meetings_provider_id_unique
  ON meetings(provider_meeting_id) WHERE provider_meeting_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meetings_calendar_event_id_unique
  ON meetings(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meetings_date_index ON meetings(meeting_date);
CREATE INDEX IF NOT EXISTS meetings_status_index ON meetings(status);

CREATE TABLE IF NOT EXISTS calendar_event_associations (
  provider TEXT NOT NULL CHECK (provider IN ('MICROSOFT_GRAPH', 'GOOGLE_CALENDAR')),
  external_event_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  online_meeting_json TEXT,
  web_url TEXT,
  is_cancelled INTEGER NOT NULL CHECK (is_cancelled IN (0, 1)),
  last_modified_at TEXT,
  meeting_platform TEXT NOT NULL CHECK (meeting_platform IN ('TEAMS', 'OTHER_ONLINE', 'NONE')),
  normalized_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS calendar_event_associations_meeting_index
  ON calendar_event_associations(meeting_id);
CREATE INDEX IF NOT EXISTS calendar_event_associations_start_index
  ON calendar_event_associations(start_time);
CREATE INDEX IF NOT EXISTS calendar_event_associations_platform_index
  ON calendar_event_associations(meeting_platform);

CREATE TABLE IF NOT EXISTS calendar_sync_state (
  provider TEXT PRIMARY KEY CHECK (provider IN ('MICROSOFT_GRAPH', 'GOOGLE_CALENDAR')),
  delta_cursor TEXT,
  window_start TEXT,
  window_end TEXT,
  last_full_sync_at TEXT,
  last_delta_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS participants_email_index ON participants(email);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(participant_id) ON DELETE CASCADE,
  role TEXT,
  PRIMARY KEY (meeting_id, participant_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  file_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL UNIQUE,
  artifact_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'MISSING', 'CORRUPTED', 'PROCESSING', 'DELETED')),
  recording_variant TEXT CHECK (recording_variant IS NULL OR recording_variant IN ('ORIGINAL', 'NORMALIZED'))
);
CREATE INDEX IF NOT EXISTS artifacts_meeting_index ON artifacts(meeting_id);
CREATE INDEX IF NOT EXISTS artifacts_type_index ON artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS artifacts_status_index ON artifacts(status);
CREATE INDEX IF NOT EXISTS artifacts_hash_index ON artifacts(sha256);

CREATE TABLE IF NOT EXISTS artifact_operations (
  operation_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STARTED', 'WRITING', 'FINALIZING', 'COMMITTED', 'FAILED', 'INCOMPLETE')),
  file_id TEXT,
  expected_sha256 TEXT,
  actual_sha256 TEXT,
  size INTEGER CHECK (size IS NULL OR size >= 0),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_operations_state_index ON artifact_operations(state);
CREATE INDEX IF NOT EXISTS artifact_operations_meeting_index ON artifact_operations(meeting_id);

CREATE TABLE IF NOT EXISTS recordings (
  recording_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  recording_variant TEXT NOT NULL CHECK (recording_variant IN ('ORIGINAL', 'NORMALIZED')),
  created_at TEXT NOT NULL,
  format TEXT,
  capture_started_at TEXT,
  capture_ended_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 TEXT,
  relative_path TEXT,
  capture_source TEXT,
  final_status TEXT CHECK (final_status IS NULL OR final_status IN ('COMMITTED', 'INCOMPLETE', 'FAILED'))
);
CREATE INDEX IF NOT EXISTS recordings_meeting_index ON recordings(meeting_id);

CREATE TABLE IF NOT EXISTS transcripts (
  transcript_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  json_artifact_id TEXT NOT NULL REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  text_artifact_id TEXT NOT NULL REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  vtt_artifact_id TEXT REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  srt_artifact_id TEXT REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  language TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recording_id TEXT REFERENCES recordings(recording_id) ON DELETE SET NULL,
  engine_id TEXT,
  source_capability TEXT,
  source_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS transcripts_meeting_index ON transcripts(meeting_id);
CREATE INDEX IF NOT EXISTS transcripts_recording_index ON transcripts(recording_id);

CREATE TABLE IF NOT EXISTS analysis_records (
  analysis_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  source_transcript_ids TEXT,
  source_transcript_shas TEXT,
  UNIQUE(meeting_id, kind)
);
CREATE INDEX IF NOT EXISTS analysis_meeting_index ON analysis_records(meeting_id);

CREATE TABLE IF NOT EXISTS processing_jobs (
  job_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'INCOMPLETE')),
  engine_id TEXT,
  model_id TEXT,
  source_recording_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS processing_jobs_meeting_index ON processing_jobs(meeting_id);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  owner TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_meeting_index ON decisions(meeting_id);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  assignee TEXT,
  due_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  source_artifact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_meeting_index ON tasks(meeting_id);
CREATE INDEX IF NOT EXISTS tasks_project_index ON tasks(project_id);
CREATE INDEX IF NOT EXISTS tasks_status_index ON tasks(status);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  meeting_id TEXT REFERENCES meetings(meeting_id) ON DELETE SET NULL,
  artifact_id TEXT REFERENCES artifacts(file_id) ON DELETE SET NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_action_index ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_meeting_index ON audit_log(meeting_id);
CREATE INDEX IF NOT EXISTS audit_created_index ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('MEETING_READY', 'MEETING_ISSUE', 'TASK_DUE', 'FOLLOWUP_DIGEST')),
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  meeting_id TEXT REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  task_id TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('open-meeting', 'open-tasks')),
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS notifications_created_index ON notifications(created_at);
CREATE INDEX IF NOT EXISTS notifications_read_index ON notifications(read_at);
`;

export class LocalDatabase {
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;
  private closed = false;

  public constructor(databasePath: string, clock: () => Date = () => new Date()) {
    this.clock = clock;
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.applyMigrations();
  }

  public get path(): string {
    const location = this.database.location();
    if (location === null) {
      throw new StorageError("The local database does not have a file location.");
    }
    return location;
  }

  public close(): void {
    if (!this.closed) {
      try {
        this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Best-effort: Windows cannot unlink sqlite/WAL while a connection holds them.
      }
      this.database.close();
      this.closed = true;
    }
  }

  public async createConsistentCopy(destinationPath: string): Promise<void> {
    this.ensureOpen();
    await mkdir(dirname(destinationPath), { recursive: true });
    await backup(this.database, destinationPath, { rate: 100 });
  }

  public checkpoint(): void {
    this.ensureOpen();
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  /** Column names of a table (tests and migration guards). */
  public describeTable(table: string): string[] {
    this.ensureOpen();
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    return rows.map((row) => stringValue(row.name));
  }

  public transaction<T>(callback: () => T): T {
    this.ensureOpen();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = callback();
      this.database.exec("COMMIT;");
      return result;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public createMeeting(meeting: Meeting): void {
    this.ensureOpen();
    const duplicate = this.findDuplicateMeeting({
      providerMeetingId: meeting.providerMeetingId,
      calendarEventId: meeting.calendarEventId,
    });
    if (duplicate !== undefined) {
      throw new DuplicateMeetingError(
        `This meeting duplicates existing meeting ${duplicate.meetingId} by provider or calendar identity.`,
        duplicate.meetingId,
      );
    }
    try {
      this.database
        .prepare(
          `INSERT INTO meetings (
            meeting_id, title, slug, folder_name, folder_relative_path, meeting_date,
            started_at, ended_at, created_at, updated_at, provider_meeting_id,
            calendar_event_id, status, storage_version, metadata_json
          ) VALUES (
            $meetingId, $title, $slug, $folderName, $folderRelativePath, $meetingDate,
            $startedAt, $endedAt, $createdAt, $updatedAt, $providerMeetingId,
            $calendarEventId, $status, $storageVersion, $metadataJson
          )`,
        )
        .run({
          $meetingId: meeting.meetingId,
          $title: meeting.title,
          $slug: meeting.slug,
          $folderName: meeting.folderName,
          $folderRelativePath: meeting.folderRelativePath,
          $meetingDate: meeting.meetingDate,
          $startedAt: meeting.startedAt ?? null,
          $endedAt: meeting.endedAt ?? null,
          $createdAt: meeting.createdAt,
          $updatedAt: meeting.updatedAt,
          $providerMeetingId: meeting.providerMeetingId ?? null,
          $calendarEventId: meeting.calendarEventId ?? null,
          $status: meeting.status,
          $storageVersion: meeting.storageVersion,
          $metadataJson: JSON.stringify(meeting.metadata ?? {}),
        });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateMeetingError("A meeting with the same ID, folder, provider ID, or calendar event already exists.", meeting.meetingId);
      }
      throw error;
    }
  }

  public getMeeting(meetingId: string): Meeting | undefined {
    const row = this.database
      .prepare("SELECT * FROM meetings WHERE meeting_id = $meetingId")
      .get({ $meetingId: meetingId });
    return row === undefined ? undefined : mapMeeting(row as SqlRow);
  }

  public listMeetings(): Meeting[] {
    const rows = this.database.prepare("SELECT * FROM meetings ORDER BY meeting_date DESC, created_at DESC").all();
    return rows.map((row) => mapMeeting(row as SqlRow));
  }

  public findDuplicateMeeting(keys: DuplicateMeetingKeys): Meeting | undefined {
    let row: Record<string, SqlValue> | undefined;
    if (keys.providerMeetingId !== undefined) {
      row = this.database
        .prepare("SELECT * FROM meetings WHERE provider_meeting_id = $value LIMIT 1")
        .get({ $value: keys.providerMeetingId }) as SqlRow | undefined;
    }
    if (row === undefined && keys.calendarEventId !== undefined) {
      row = this.database
        .prepare("SELECT * FROM meetings WHERE calendar_event_id = $value LIMIT 1")
        .get({ $value: keys.calendarEventId }) as SqlRow | undefined;
    }
    if (row === undefined && keys.recordingSha256 !== undefined) {
      row = this.database
        .prepare(
          `SELECT meetings.* FROM meetings
           INNER JOIN artifacts ON artifacts.meeting_id = meetings.meeting_id
           WHERE artifacts.sha256 = $value AND artifacts.artifact_type IN ('RECORDING_ORIGINAL', 'RECORDING_NORMALIZED')
           LIMIT 1`,
        )
        .get({ $value: keys.recordingSha256 }) as SqlRow | undefined;
    }
    return row === undefined ? undefined : mapMeeting(row);
  }

  public getCalendarEventAssociation(
    provider: CalendarProvider,
    externalEventId: string,
  ): CalendarEventAssociation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM calendar_event_associations
         WHERE provider = $provider AND external_event_id = $externalEventId`,
      )
      .get({ $provider: provider, $externalEventId: externalEventId });
    return row === undefined ? undefined : mapCalendarEventAssociation(row as SqlRow);
  }

  public listCalendarEventAssociations(meetingId?: string): CalendarEventAssociation[] {
    const rows = meetingId === undefined
      ? this.database.prepare("SELECT * FROM calendar_event_associations ORDER BY start_time, external_event_id").all()
      : this.database
          .prepare(
            `SELECT * FROM calendar_event_associations
             WHERE meeting_id = $meetingId ORDER BY start_time, external_event_id`,
          )
          .all({ $meetingId: meetingId });
    return rows.map((row) => mapCalendarEventAssociation(row as SqlRow));
  }

  public upsertCalendarEventAssociation(association: CalendarEventAssociation): "CREATED" | "UPDATED" | "UNCHANGED" {
    this.ensureOpen();
    const existing = this.getCalendarEventAssociation(association.provider, association.externalEventId);
    if (existing !== undefined && existing.meetingId !== association.meetingId) {
      throw new DuplicateMeetingError(
        `Calendar event ${association.externalEventId} is already associated with meeting ${existing.meetingId}.`,
        existing.meetingId,
      );
    }
    if (existing !== undefined && calendarEventAssociationEquals(existing, association)) {
      return "UNCHANGED";
    }
    this.database
      .prepare(
        `INSERT INTO calendar_event_associations (
          provider, external_event_id, meeting_id, subject, start_time, end_time,
          organizer_json, attendees_json, location, online_meeting_json, web_url,
          is_cancelled, last_modified_at, meeting_platform, normalized_fingerprint,
          created_at, updated_at
        ) VALUES (
          $provider, $externalEventId, $meetingId, $subject, $startTime, $endTime,
          $organizerJson, $attendeesJson, $location, $onlineMeetingJson, $webUrl,
          $isCancelled, $lastModifiedAt, $meetingPlatform, $normalizedFingerprint,
          $createdAt, $updatedAt
        )
        ON CONFLICT(provider, external_event_id) DO UPDATE SET
          meeting_id = excluded.meeting_id,
          subject = excluded.subject,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          organizer_json = excluded.organizer_json,
          attendees_json = excluded.attendees_json,
          location = excluded.location,
          online_meeting_json = excluded.online_meeting_json,
          web_url = excluded.web_url,
          is_cancelled = excluded.is_cancelled,
          last_modified_at = excluded.last_modified_at,
          meeting_platform = excluded.meeting_platform,
          normalized_fingerprint = excluded.normalized_fingerprint,
          updated_at = excluded.updated_at`,
      )
      .run({
        $provider: association.provider,
        $externalEventId: association.externalEventId,
        $meetingId: association.meetingId,
        $subject: association.subject,
        $startTime: association.startTime,
        $endTime: association.endTime,
        $organizerJson: association.organizer === undefined ? null : JSON.stringify(association.organizer),
        $attendeesJson: JSON.stringify(association.attendees),
        $location: association.location ?? null,
        $onlineMeetingJson: association.onlineMeeting === undefined ? null : JSON.stringify(association.onlineMeeting),
        $webUrl: association.webUrl ?? null,
        $isCancelled: association.isCancelled ? 1 : 0,
        $lastModifiedAt: association.lastModifiedAt ?? null,
        $meetingPlatform: association.meetingPlatform,
        $normalizedFingerprint: association.normalizedFingerprint,
        $createdAt: association.createdAt,
        $updatedAt: association.updatedAt,
      });
    return existing === undefined ? "CREATED" : "UPDATED";
  }

  /** Marks a stored association as cancelled (used by delta deletions). */
  public markCalendarEventAssociationCancelled(provider: CalendarProvider, externalEventId: string): boolean {
    this.ensureOpen();
    const result = this.database
      .prepare(
        `UPDATE calendar_event_associations SET is_cancelled = 1, updated_at = $updatedAt
         WHERE provider = $provider AND external_event_id = $externalEventId`,
      )
      .run({ $provider: provider, $externalEventId: externalEventId, $updatedAt: this.clock().toISOString() });
    return result.changes > 0;
  }

  public getCalendarSyncState(provider: CalendarProvider): CalendarSyncStateRecord | undefined {
    this.ensureOpen();
    const row = this.database
      .prepare("SELECT * FROM calendar_sync_state WHERE provider = $provider")
      .get({ $provider: provider }) as SqlRow | undefined;
    return row === undefined ? undefined : mapCalendarSyncState(row);
  }

  public saveCalendarSyncState(state: CalendarSyncStateRecord): "CREATED" | "UPDATED" {
    this.ensureOpen();
    const existing = this.getCalendarSyncState(state.provider);
    const now = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO calendar_sync_state (
          provider, delta_cursor, window_start, window_end, last_full_sync_at,
          last_delta_sync_at, created_at, updated_at
        ) VALUES (
          $provider, $deltaCursor, $windowStart, $windowEnd, $lastFullSyncAt,
          $lastDeltaSyncAt, $createdAt, $updatedAt
        )
        ON CONFLICT(provider) DO UPDATE SET
          delta_cursor = excluded.delta_cursor,
          window_start = excluded.window_start,
          window_end = excluded.window_end,
          last_full_sync_at = excluded.last_full_sync_at,
          last_delta_sync_at = excluded.last_delta_sync_at,
          updated_at = excluded.updated_at`,
      )
      .run({
        $provider: state.provider,
        $deltaCursor: state.deltaCursor ?? null,
        $windowStart: state.syncWindowStart ?? null,
        $windowEnd: state.syncWindowEnd ?? null,
        $lastFullSyncAt: state.lastFullSyncAt ?? null,
        $lastDeltaSyncAt: state.lastDeltaSyncAt ?? null,
        $createdAt: existing?.updatedAt ?? now,
        $updatedAt: now,
      });
    return existing === undefined ? "CREATED" : "UPDATED";
  }

  public clearCalendarSyncState(provider: CalendarProvider): void {
    this.ensureOpen();
    this.database.prepare("DELETE FROM calendar_sync_state WHERE provider = $provider").run({ $provider: provider });
  }

  public updateMeetingStatus(meetingId: string, status: MeetingStatus, endedAt?: string): void {
    const meeting = this.getMeeting(meetingId);
    if (meeting === undefined) throw new StorageError(`Meeting not found: ${meetingId}`);
    if (meeting.status !== status && !isValidMeetingTransition(meeting.status, status)) {
      throw new InvalidMeetingTransitionError(`Invalid meeting transition: ${meeting.status} -> ${status}`);
    }
    this.database
      .prepare(
        "UPDATE meetings SET status = $status, ended_at = COALESCE($endedAt, ended_at), updated_at = $updatedAt WHERE meeting_id = $meetingId",
      )
      .run({
        $meetingId: meetingId,
        $status: status,
        $endedAt: endedAt ?? null,
        $updatedAt: this.clock().toISOString(),
      });
  }

  public upsertParticipant(participant: ParticipantRecord): void {
    this.database
      .prepare(
        `INSERT INTO participants (participant_id, display_name, email, created_at)
         VALUES ($participantId, $displayName, $email, $createdAt)
         ON CONFLICT(participant_id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email`,
      )
      .run({
        $participantId: participant.participantId,
        $displayName: participant.displayName,
        $email: participant.email ?? null,
        $createdAt: participant.createdAt,
      });
  }

  public addParticipantToMeeting(meetingId: string, participantId: string, role?: string): void {
    this.database
      .prepare(
        `INSERT INTO meeting_participants (meeting_id, participant_id, role)
         VALUES ($meetingId, $participantId, $role)
         ON CONFLICT(meeting_id, participant_id) DO UPDATE SET role = excluded.role`,
      )
      .run({ $meetingId: meetingId, $participantId: participantId, $role: role ?? null });
  }

  public listParticipants(meetingId?: string): ParticipantRecord[] {
    const rows = meetingId === undefined
      ? this.database.prepare("SELECT * FROM participants ORDER BY display_name").all()
      : this.database
          .prepare(
            `SELECT participants.* FROM participants
             INNER JOIN meeting_participants ON meeting_participants.participant_id = participants.participant_id
             WHERE meeting_participants.meeting_id = $meetingId ORDER BY participants.display_name`,
          )
          .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
      const participant: ParticipantRecord = {
        participantId: stringValue(value.participant_id),
        displayName: stringValue(value.display_name),
        createdAt: stringValue(value.created_at),
      };
      addOptional(participant, "email", optionalString(value.email));
      return participant;
    });
  }

  public registerArtifact(artifact: Artifact): void {
    this.database
      .prepare(
        `INSERT INTO artifacts (
          file_id, meeting_id, relative_path, artifact_type, mime_type, size,
          created_at, modified_at, sha256, status, recording_variant
        ) VALUES (
          $fileId, $meetingId, $relativePath, $artifactType, $mimeType, $size,
          $createdAt, $modifiedAt, $sha256, $status, $recordingVariant
        )`,
      )
      .run({
        $fileId: artifact.fileId,
        $meetingId: artifact.meetingId,
        $relativePath: artifact.relativePath,
        $artifactType: artifact.artifactType,
        $mimeType: artifact.mimeType,
        $size: artifact.size,
        $createdAt: artifact.createdAt,
        $modifiedAt: artifact.modifiedAt,
        $sha256: artifact.sha256,
        $status: artifact.status,
        $recordingVariant: artifact.recordingVariant ?? null,
      });
  }

  public getArtifact(fileId: string): Artifact | undefined {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE file_id = $fileId").get({ $fileId: fileId });
    return row === undefined ? undefined : mapArtifact(row as SqlRow);
  }

  public getArtifactByPath(relativePath: string): Artifact | undefined {
    const row = this.database
      .prepare("SELECT * FROM artifacts WHERE relative_path = $relativePath")
      .get({ $relativePath: relativePath });
    return row === undefined ? undefined : mapArtifact(row as SqlRow);
  }

  public listArtifacts(meetingId?: string): Artifact[] {
    const rows = meetingId === undefined
      ? this.database.prepare("SELECT * FROM artifacts ORDER BY created_at").all()
      : this.database
          .prepare("SELECT * FROM artifacts WHERE meeting_id = $meetingId ORDER BY created_at")
          .all({ $meetingId: meetingId });
    return rows.map((row) => mapArtifact(row as SqlRow));
  }

  public startArtifactOperation(operation: ArtifactOperation): void {
    this.database
      .prepare(
        `INSERT INTO artifact_operations (
          operation_id, meeting_id, relative_path, artifact_type, state,
          file_id, expected_sha256, actual_sha256, size, error, created_at, updated_at
        ) VALUES (
          $operationId, $meetingId, $relativePath, $artifactType, $state,
          $fileId, $expectedSha256, $actualSha256, $size, $error, $createdAt, $updatedAt
        )`,
      )
      .run({
        $operationId: operation.operationId,
        $meetingId: operation.meetingId,
        $relativePath: operation.relativePath,
        $artifactType: operation.artifactType,
        $state: operation.state,
        $fileId: operation.fileId ?? null,
        $expectedSha256: operation.expectedSha256 ?? null,
        $actualSha256: operation.actualSha256 ?? null,
        $size: operation.size ?? null,
        $error: operation.error ?? null,
        $createdAt: operation.createdAt,
        $updatedAt: operation.updatedAt,
      });
  }

  public updateArtifactOperation(operationId: string, update: ArtifactOperationUpdate): void {
    this.database
      .prepare(
        `UPDATE artifact_operations SET
          state = $state,
          file_id = COALESCE($fileId, file_id),
          actual_sha256 = COALESCE($actualSha256, actual_sha256),
          size = COALESCE($size, size),
          error = COALESCE($error, error),
          updated_at = $updatedAt
         WHERE operation_id = $operationId`,
      )
      .run({
        $operationId: operationId,
        $state: update.state,
        $fileId: update.fileId ?? null,
        $actualSha256: update.actualSha256 ?? null,
        $size: update.size ?? null,
        $error: update.error ?? null,
        $updatedAt: this.clock().toISOString(),
      });
  }

  public getArtifactOperation(operationId: string): ArtifactOperation | undefined {
    const row = this.database
      .prepare("SELECT * FROM artifact_operations WHERE operation_id = $operationId")
      .get({ $operationId: operationId }) as SqlRow | undefined;
    return row === undefined ? undefined : mapArtifactOperation(row);
  }

  public listArtifactOperations(): ArtifactOperation[] {
    const rows = this.database.prepare("SELECT * FROM artifact_operations ORDER BY created_at").all();
    return rows.map((row) => mapArtifactOperation(row as SqlRow));
  }

  public listPendingArtifactOperations(): ArtifactOperation[] {
    const rows = this.database
      .prepare("SELECT * FROM artifact_operations WHERE state IN ('STARTED', 'WRITING', 'FINALIZING') ORDER BY created_at")
      .all();
    return rows.map((row) => mapArtifactOperation(row as SqlRow));
  }

  public listIncompleteArtifactOperations(): ArtifactOperation[] {
    const rows = this.database
      .prepare("SELECT * FROM artifact_operations WHERE state = 'INCOMPLETE' ORDER BY created_at")
      .all();
    return rows.map((row) => mapArtifactOperation(row as SqlRow));
  }

  public updateArtifactVerification(
    fileId: string,
    status: ArtifactStatus,
    size?: number,
    modifiedAt?: string,
    sha256?: string,
  ): void {
    this.database
      .prepare(
        `UPDATE artifacts SET
          status = $status,
          size = COALESCE($size, size),
          modified_at = COALESCE($modifiedAt, modified_at),
          sha256 = COALESCE($sha256, sha256)
         WHERE file_id = $fileId`,
      )
      .run({
        $fileId: fileId,
        $status: status,
        $size: size ?? null,
        $modifiedAt: modifiedAt ?? null,
        $sha256: sha256 ?? null,
      });
  }

  public registerRecording(record: RecordingRecord): void {
    this.database
      .prepare(
        `INSERT INTO recordings (
          recording_id, meeting_id, artifact_id, recording_variant, created_at,
          format, capture_started_at, capture_ended_at, duration_ms, byte_size,
          sha256, relative_path, capture_source, final_status
        ) VALUES (
          $recordingId, $meetingId, $artifactId, $recordingVariant, $createdAt,
          $format, $captureStartedAt, $captureEndedAt, $durationMs, $byteSize,
          $sha256, $relativePath, $captureSource, $finalStatus
        )`,
      )
      .run({
        $recordingId: record.recordingId,
        $meetingId: record.meetingId,
        $artifactId: record.artifactId,
        $recordingVariant: record.recordingVariant,
        $createdAt: record.createdAt,
        $format: record.format ?? null,
        $captureStartedAt: record.captureStartedAt ?? null,
        $captureEndedAt: record.captureEndedAt ?? null,
        $durationMs: record.durationMs ?? null,
        $byteSize: record.byteSize ?? null,
        $sha256: record.sha256 ?? null,
        $relativePath: record.relativePath ?? null,
        $captureSource: record.captureSource ?? null,
        $finalStatus: record.finalStatus ?? null,
      });
  }

  public getRecording(recordingId: string): RecordingRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM recordings WHERE recording_id = $recordingId")
      .get({ $recordingId: recordingId });
    return row === undefined ? undefined : mapRecording(row as SqlRow);
  }

  public listRecordings(meetingId?: string): RecordingRecord[] {
    const rows = meetingId === undefined
      ? this.database.prepare("SELECT * FROM recordings ORDER BY created_at").all()
      : this.database
          .prepare("SELECT * FROM recordings WHERE meeting_id = $meetingId ORDER BY created_at")
          .all({ $meetingId: meetingId });
    return rows.map((row) => mapRecording(row as SqlRow));
  }

  public registerTranscript(record: TranscriptRecord): void {
    this.database
      .prepare(
        `INSERT INTO transcripts (
          transcript_id, meeting_id, json_artifact_id, text_artifact_id,
          vtt_artifact_id, srt_artifact_id, language, created_at, recording_id, engine_id,
          source_capability, source_sha256
        ) VALUES (
          $transcriptId, $meetingId, $jsonArtifactId, $textArtifactId,
          $vttArtifactId, $srtArtifactId, $language, $createdAt, $recordingId, $engineId,
          $sourceCapability, $sourceSha256
        )`,
      )
      .run({
        $transcriptId: record.transcriptId,
        $meetingId: record.meetingId,
        $jsonArtifactId: record.jsonArtifactId,
        $textArtifactId: record.textArtifactId,
        $vttArtifactId: record.vttArtifactId ?? null,
        $srtArtifactId: record.srtArtifactId ?? null,
        $language: record.language,
        $createdAt: record.createdAt,
        $recordingId: record.recordingId ?? null,
        $engineId: record.engineId ?? null,
        $sourceCapability: record.sourceCapability ?? null,
        $sourceSha256: record.sourceSha256 ?? null,
      });
  }

  public listTranscripts(meetingId: string): TranscriptRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM transcripts WHERE meeting_id = $meetingId ORDER BY created_at")
      .all({ $meetingId: meetingId });
    return rows.map((row) => mapTranscriptRecord(row as SqlRow));
  }

  /** Every transcript across all meetings (ordered by creation time). */
  public listAllTranscripts(): TranscriptRecord[] {
    const rows = this.database.prepare("SELECT * FROM transcripts ORDER BY created_at").all();
    return rows.map((row) => mapTranscriptRecord(row as SqlRow));
  }

  public registerAnalysis(record: AnalysisRecord): void {
    this.database
      .prepare(
        `INSERT INTO analysis_records (
          analysis_id, meeting_id, kind, artifact_id, created_at, source_transcript_ids, source_transcript_shas
        ) VALUES (
          $analysisId, $meetingId, $kind, $artifactId, $createdAt, $sourceTranscriptIds, $sourceTranscriptShas
        )
         ON CONFLICT(meeting_id, kind) DO UPDATE SET
          artifact_id = excluded.artifact_id,
          created_at = excluded.created_at,
          source_transcript_ids = excluded.source_transcript_ids,
          source_transcript_shas = excluded.source_transcript_shas`,
      )
      .run({
        $analysisId: record.analysisId,
        $meetingId: record.meetingId,
        $kind: record.kind,
        $artifactId: record.artifactId,
        $createdAt: record.createdAt,
        $sourceTranscriptIds: record.sourceTranscriptIds ?? null,
        $sourceTranscriptShas: record.sourceTranscriptShas ?? null,
      });
  }

  public listAnalysis(meetingId: string): AnalysisRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM analysis_records WHERE meeting_id = $meetingId ORDER BY kind")
      .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
      const record: AnalysisRecord = {
        analysisId: stringValue(value.analysis_id),
        meetingId: stringValue(value.meeting_id),
        kind: stringValue(value.kind),
        artifactId: stringValue(value.artifact_id),
        createdAt: stringValue(value.created_at),
      };
      addOptional(record, "sourceTranscriptIds", optionalString(value.source_transcript_ids));
      addOptional(record, "sourceTranscriptShas", optionalString(value.source_transcript_shas));
      return record;
    });
  }

  public registerProcessingJob(job: ProcessingJobRecord): void {
    this.database
      .prepare(
        `INSERT INTO processing_jobs (
          job_id, meeting_id, job_type, state, engine_id, model_id, source_recording_id, error, created_at, updated_at
        ) VALUES (
          $jobId, $meetingId, $jobType, $state, $engineId, $modelId, $sourceRecordingId, $error, $createdAt, $updatedAt
        )`,
      )
      .run({
        $jobId: job.jobId,
        $meetingId: job.meetingId,
        $jobType: job.jobType,
        $state: job.state,
        $engineId: job.engineId ?? null,
        $modelId: job.modelId ?? null,
        $sourceRecordingId: job.sourceRecordingId ?? null,
        $error: job.error ?? null,
        $createdAt: job.createdAt,
        $updatedAt: job.updatedAt,
      });
  }

  public updateProcessingJob(jobId: string, updates: Partial<ProcessingJobRecord>): void {
    const sets: string[] = [];
    const params: Record<string, SqlValue> = { $jobId: jobId };
    if (updates.state !== undefined) {
      sets.push("state = $state");
      params.$state = updates.state;
    }
    if (updates.error !== undefined) {
      sets.push("error = $error");
      params.$error = updates.error;
    }
    if (updates.updatedAt !== undefined) {
      sets.push("updated_at = $updatedAt");
      params.$updatedAt = updates.updatedAt;
    }
    if (sets.length === 0) return;
    this.database.prepare(`UPDATE processing_jobs SET ${sets.join(", ")} WHERE job_id = $jobId`).run(params);
  }

  public getProcessingJob(jobId: string): ProcessingJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM processing_jobs WHERE job_id = $jobId").get({ $jobId: jobId }) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const record: ProcessingJobRecord = {
      jobId: stringValue(row.job_id),
      meetingId: stringValue(row.meeting_id),
      jobType: stringValue(row.job_type),
      state: stringValue(row.state) as "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "INCOMPLETE",
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at),
    };
    addOptional(record, "engineId", optionalString(row.engine_id));
    addOptional(record, "modelId", optionalString(row.model_id));
    addOptional(record, "sourceRecordingId", optionalString(row.source_recording_id));
    addOptional(record, "error", optionalString(row.error));
    return record;
  }

  public listProcessingJobs(meetingId: string): ProcessingJobRecord[] {
    const rows = this.database.prepare("SELECT * FROM processing_jobs WHERE meeting_id = $meetingId ORDER BY created_at").all({ $meetingId: meetingId }) as SqlRow[];
    return rows.map((row) => {
      const record: ProcessingJobRecord = {
        jobId: stringValue(row.job_id),
        meetingId: stringValue(row.meeting_id),
        jobType: stringValue(row.job_type),
        state: stringValue(row.state) as "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "INCOMPLETE",
        createdAt: stringValue(row.created_at),
        updatedAt: stringValue(row.updated_at),
      };
      addOptional(record, "engineId", optionalString(row.engine_id));
      addOptional(record, "modelId", optionalString(row.model_id));
      addOptional(record, "sourceRecordingId", optionalString(row.source_recording_id));
      addOptional(record, "error", optionalString(row.error));
      return record;
    });
  }

  public invalidateStaleAnalysis(meetingId: string): void {
    // Phase 9: Delete old analysis records that are stale.
    // They will be re-analyzed if transcripts change.
    this.database.prepare("DELETE FROM analysis_records WHERE meeting_id = $meetingId").run({ $meetingId: meetingId });
  }

  public upsertProject(project: ProjectRecord): void {
    this.database
      .prepare(
        `INSERT INTO projects (project_id, name, created_at, updated_at)
         VALUES ($projectId, $name, $createdAt, $updatedAt)
         ON CONFLICT(project_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run({ $projectId: project.projectId, $name: project.name, $createdAt: project.createdAt, $updatedAt: project.updatedAt });
  }

  public registerDecision(decision: DecisionRecord): void {
    this.database
      .prepare(
        `INSERT INTO decisions (decision_id, meeting_id, text, owner, decided_at, created_at)
         VALUES ($decisionId, $meetingId, $text, $owner, $decidedAt, $createdAt)`,
      )
      .run({
        $decisionId: decision.decisionId,
        $meetingId: decision.meetingId,
        $text: decision.text,
        $owner: decision.owner ?? null,
        $decidedAt: decision.decidedAt ?? null,
        $createdAt: decision.createdAt,
      });
  }

  public listDecisions(meetingId: string): DecisionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM decisions WHERE meeting_id = $meetingId ORDER BY created_at")
      .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
      const decision: DecisionRecord = {
        decisionId: stringValue(value.decision_id),
        meetingId: stringValue(value.meeting_id),
        text: stringValue(value.text),
        createdAt: stringValue(value.created_at),
      };
      addOptional(decision, "owner", optionalString(value.owner));
      addOptional(decision, "decidedAt", optionalString(value.decided_at));
      return decision;
    });
  }

  public registerTask(task: TaskRecord): void {
    this.database
      .prepare(
        `INSERT INTO tasks (
          task_id, meeting_id, project_id, text, assignee, due_date, status, source_artifact_id,
          created_at, updated_at
        ) VALUES (
          $taskId, $meetingId, $projectId, $text, $assignee, $dueDate, $status, $sourceArtifactId,
          $createdAt, $updatedAt
        )`,
      )
      .run({
        $taskId: task.taskId,
        $meetingId: task.meetingId,
        $projectId: task.projectId ?? null,
        $text: task.text,
        $assignee: task.assignee ?? null,
        $dueDate: task.dueDate ?? null,
        $status: task.status ?? "OPEN",
        $sourceArtifactId: task.sourceArtifactId ?? null,
        $createdAt: task.createdAt,
        $updatedAt: task.updatedAt,
      });
  }

  public getTask(taskId: string): TaskRecord | undefined {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = $taskId").get({ $taskId: taskId });
    return row === undefined ? undefined : mapTaskRecord(row as SqlRow);
  }

  public listTasks(meetingId: string): TaskRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks WHERE meeting_id = $meetingId ORDER BY created_at")
      .all({ $meetingId: meetingId });
    return rows.map((row) => mapTaskRecord(row as SqlRow));
  }

  /** Every task across all meetings (ordered by creation time). */
  public listAllTasks(): TaskRecord[] {
    const rows = this.database.prepare("SELECT * FROM tasks ORDER BY created_at").all();
    return rows.map((row) => mapTaskRecord(row as SqlRow));
  }

  public updateTask(taskId: string, fields: TaskUpdateFields): TaskRecord | undefined {
    const assignments: string[] = [];
    const parameters: Record<string, string | number | bigint | Uint8Array | null> = { $taskId: taskId };
    const push = (column: string, key: string, value: string | number | bigint | Uint8Array | null | undefined): void => {
      if (value !== undefined) {
        assignments.push(`${column} = $${key}`);
        parameters[`$${key}`] = value;
      }
    };
    push("text", "text", fields.text);
    push("assignee", "assignee", fields.assignee === undefined ? undefined : fields.assignee);
    push("due_date", "dueDate", fields.dueDate === undefined ? undefined : fields.dueDate);
    push("status", "status", fields.status);
    push("source_artifact_id", "sourceArtifactId", fields.sourceArtifactId === undefined ? undefined : fields.sourceArtifactId);
    push("updated_at", "updatedAt", fields.updatedAt);
    if (assignments.length === 0) {
      return this.getTask(taskId);
    }
    this.database
      .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE task_id = $taskId`)
      .run(parameters);
    return this.getTask(taskId);
  }

  /**
   * Inserts a notification. The unique dedupe key makes repeated generation
   * of the same event idempotent: an already-present key is ignored and the
   * method reports that nothing was inserted.
   */
  public addNotification(record: NotificationRecord): boolean {
    const result = this.database
      .prepare(
        `INSERT INTO notifications (
          notification_id, kind, severity, title, body, created_at, read_at,
          meeting_id, task_id, action, dedupe_key
        ) VALUES (
          $notificationId, $kind, $severity, $title, $body, $createdAt, $readAt,
          $meetingId, $taskId, $action, $dedupeKey
        ) ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run({
        $notificationId: record.notificationId,
        $kind: record.kind,
        $severity: record.severity,
        $title: record.title,
        $body: record.body,
        $createdAt: record.createdAt,
        $readAt: record.readAt ?? null,
        $meetingId: record.meetingId ?? null,
        $taskId: record.taskId ?? null,
        $action: record.action ?? null,
        $dedupeKey: record.dedupeKey,
      });
    return Number(result.changes) > 0;
  }

  /** Newest-first notification history for the in-app notification center. */
  public listNotifications(limit = 100): NotificationRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC, notification_id DESC LIMIT $limit")
      .all({ $limit: Math.min(Math.max(1, Math.trunc(limit)), 1000) });
    return rows.map((row) => mapNotificationRecord(row as SqlRow));
  }

  public unreadNotificationCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL").get() as SqlRow;
    return numberValue(row.count);
  }

  public markNotificationRead(notificationId: string, readAt: string): NotificationRecord | undefined {
    this.database
      .prepare("UPDATE notifications SET read_at = $readAt WHERE notification_id = $notificationId AND read_at IS NULL")
      .run({ $notificationId: notificationId, $readAt: readAt });
    return this.getNotification(notificationId);
  }

  public getNotification(notificationId: string): NotificationRecord | undefined {
    const row = this.database.prepare("SELECT * FROM notifications WHERE notification_id = $notificationId").get({ $notificationId: notificationId });
    return row === undefined ? undefined : mapNotificationRecord(row as SqlRow);
  }

  public markAllNotificationsRead(readAt: string): number {
    const result = this.database
      .prepare("UPDATE notifications SET read_at = $readAt WHERE read_at IS NULL")
      .run({ $readAt: readAt });
    return Number(result.changes);
  }

  /**
   * Retention for the notification center: keeps at most `keepLatest` rows
   * and drops rows older than `maxAgeMs`. Runs inside one transaction so the
   * in-app history can never grow without bound.
   */
  public pruneNotifications(keepLatest: number, maxAgeMs: number, now: Date): number {
    const keptBoundary = new Date(now.getTime() - maxAgeMs).toISOString();
    const overflow: SqlRow[] = this.database
      .prepare(
        "SELECT notification_id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET $keep",
      )
      .all({ $keep: Math.max(0, Math.trunc(keepLatest)) });
    let removed = 0;
    this.transaction(() => {
      for (const row of overflow) {
        const removedRow = this.database
          .prepare("DELETE FROM notifications WHERE notification_id = $notificationId")
          .run({ $notificationId: stringValue(row.notification_id) });
        removed += Number(removedRow.changes);
      }
      const aged = this.database
        .prepare("DELETE FROM notifications WHERE created_at < $boundary")
        .run({ $boundary: keptBoundary });
      removed += Number(aged.changes);
    });
    return removed;
  }

  public appendAudit(record: AuditRecord): void {
    this.database
      .prepare(
        `INSERT INTO audit_log (audit_id, action, meeting_id, artifact_id, details_json, created_at)
         VALUES ($auditId, $action, $meetingId, $artifactId, $detailsJson, $createdAt)`,
      )
      .run({
        $auditId: record.auditId,
        $action: record.action,
        $meetingId: record.meetingId ?? null,
        $artifactId: record.artifactId ?? null,
        $detailsJson: JSON.stringify(record.details ?? {}),
        $createdAt: record.createdAt,
      });
  }

  public listAuditRecords(limit = 100): AuditRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $limit")
      .all({ $limit: limit });
    return rows.map((row) => {
      const value = row as SqlRow;
      const details = JSON.parse(stringValue(value.details_json)) as Record<string, unknown>;
      const record: AuditRecord = {
        auditId: stringValue(value.audit_id),
        action: stringValue(value.action),
        createdAt: stringValue(value.created_at),
        details,
      };
      addOptional(record, "meetingId", optionalString(value.meeting_id));
      addOptional(record, "artifactId", optionalString(value.artifact_id));
      return record;
    });
  }

  public setMetadata(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES ($key, $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ $key: key, $value: value, $updatedAt: this.clock().toISOString() });
  }

  public getMetadata(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM app_metadata WHERE key = $key").get({ $key: key });
    return row === undefined ? undefined : stringValue((row as SqlRow).value);
  }

  public getLastIntegrityCheckAt(): string | undefined {
    return this.getMetadata("lastIntegrityCheckAt");
  }

  public countMeetings(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM meetings").get() as SqlRow;
    return numberValue(row.count);
  }

  /** Stable copy-verification view that excludes the append-only audit log. */
  public getMigrationFingerprint(): string {
    const tables = [
      "schema_migrations",
      "app_metadata",
      "meetings",
      "calendar_event_associations",
      "participants",
      "meeting_participants",
      "artifacts",
      "artifact_operations",
      "recordings",
      "transcripts",
      "analysis_records",
      "projects",
      "decisions",
      "tasks",
    ];
    return JSON.stringify(
      tables.map((table) => {
        const rows = this.database.prepare(`SELECT * FROM ${table}`).all() as SqlRow[];
        return {
          table,
          rows: rows
            .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        };
      }),
    );
  }

  public deleteMeetingMetadata(meetingId: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM meetings WHERE meeting_id = $meetingId").run({ $meetingId: meetingId });
    });
  }

  public applyMigrations(): void {
    this.ensureOpen();
    this.database.exec(SCHEMA_SQL);
    const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as SqlRow;
    const currentVersion = row.version === null ? 0 : numberValue(row.version);
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      throw new StorageError(
        `Database schema version ${currentVersion} is newer than supported version ${DATABASE_SCHEMA_VERSION}.`,
      );
    }
    if (currentVersion < DATABASE_SCHEMA_VERSION) {
      if (currentVersion > 0 && currentVersion < 3) {
        this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; ALTER TABLE meetings RENAME TO meetings_legacy;" +
          SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS meetings \([\s\S]*?\);/)?.[0].replace("meetings", "meetings") +
          "INSERT INTO meetings SELECT * FROM meetings_legacy; DROP TABLE meetings_legacy; COMMIT; PRAGMA foreign_keys = ON;");
      }
      if (currentVersion > 0 && currentVersion < 5) {
        this.applyRecordingMetadataMigration();
      }
      if (currentVersion > 0 && currentVersion < 8) {
        this.applyCalendarProviderMigration();
      }
      if (currentVersion > 0 && currentVersion < 9) {
        this.applyTaskSourceArtifactMigration();
      }
      this.database
        .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES ($version, $appliedAt)")
        .run({ $version: DATABASE_SCHEMA_VERSION, $appliedAt: this.clock().toISOString() });
    }
  }

  /** Schema v9: tasks gain optional source_artifact_id for analysis provenance. */
  private applyTaskSourceArtifactMigration(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tasks)").all() as SqlRow[])
        .map((row) => stringValue(row.name)),
    );
    if (!columns.has("source_artifact_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN source_artifact_id TEXT;");
    }
    // Backfill: analysis persistence wrote task rows and the matching
    // ANALYSIS_TASKS analysis record inside one transaction sharing the same
    // meeting and created_at, so each legacy analysis task can be pointed back
    // at the exact artifact that produced it. Rows left NULL are manual.
    this.database.exec(`
      UPDATE tasks SET source_artifact_id = (
        SELECT ar.artifact_id FROM analysis_records ar
        WHERE ar.meeting_id = tasks.meeting_id
          AND ar.kind = 'TASKS'
          AND ar.created_at = tasks.created_at
        ORDER BY ar.analysis_id
        LIMIT 1
      )
      WHERE source_artifact_id IS NULL
        AND EXISTS (
          SELECT 1 FROM analysis_records ar
          WHERE ar.meeting_id = tasks.meeting_id
            AND ar.kind = 'TASKS'
            AND ar.created_at = tasks.created_at
        );
    `);
  }

  /**
   * Schema v8: widens calendar_event_associations.provider to accept
   * GOOGLE_CALENDAR and adds the calendar_sync_state cursor table. SQLite
   * cannot alter a CHECK constraint, so the association table is rebuilt
   * inside one transaction; indexes are recreated for the new table.
   */
  private applyCalendarProviderMigration(): void {
    const currentDdl = this.readTableDdl("calendar_event_associations");
    if (currentDdl === undefined) {
      return; // fresh database: SCHEMA_SQL already created the v8 shape
    }
    if (currentDdl.includes("GOOGLE_CALENDAR")) {
      return; // already widened (interrupted migration completed by rerun)
    }
    const targetDdl = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS calendar_event_associations \([^]*?\);/)?.[0];
    if (targetDdl === undefined) {
      throw new StorageError("The calendar_event_associations schema definition is missing.");
    }
    const createTable = targetDdl.replace(
      "CREATE TABLE IF NOT EXISTS calendar_event_associations",
      "CREATE TABLE calendar_event_associations",
    );
    const recreateIndexes =
      "CREATE INDEX IF NOT EXISTS calendar_event_associations_meeting_index ON calendar_event_associations(meeting_id);" +
      "CREATE INDEX IF NOT EXISTS calendar_event_associations_start_index ON calendar_event_associations(start_time);" +
      "CREATE INDEX IF NOT EXISTS calendar_event_associations_platform_index ON calendar_event_associations(meeting_platform);";
    this.database.exec(
      "PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;" +
      "ALTER TABLE calendar_event_associations RENAME TO calendar_event_associations_legacy;" +
      `${createTable};` +
      "INSERT INTO calendar_event_associations SELECT * FROM calendar_event_associations_legacy;" +
      "DROP TABLE calendar_event_associations_legacy;" +
      // Index names are only free after the legacy table (which inherited the
      // old indexes on rename) is dropped.
      `${recreateIndexes}` +
      "COMMIT; PRAGMA foreign_keys = ON;",
    );
  }

  private readTableDdl(tableName: string): string | undefined {
    const row = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $name")
      .get({ $name: tableName }) as SqlRow | undefined;
    return optionalString(row?.sql);
  }

  private applyRecordingMetadataMigration(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(recordings)").all() as SqlRow[])
        .map((row) => stringValue(row.name)),
    );
    const addColumn = (name: string, definition: string): void => {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE recordings ADD COLUMN ${definition};`);
      }
    };
    addColumn("format", "format TEXT");
    addColumn("capture_started_at", "capture_started_at TEXT");
    addColumn("capture_ended_at", "capture_ended_at TEXT");
    addColumn("duration_ms", "duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)");
    addColumn("byte_size", "byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0)");
    addColumn("sha256", "sha256 TEXT");
    addColumn("relative_path", "relative_path TEXT");
    addColumn("capture_source", "capture_source TEXT");
    addColumn("final_status", "final_status TEXT CHECK (final_status IS NULL OR final_status IN ('COMMITTED', 'INCOMPLETE', 'FAILED'))");
  }

  private applyTranscriptRecordingMigration(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(transcripts)").all() as SqlRow[])
        .map((row) => stringValue(row.name)),
    );
    if (!columns.has("recording_id")) {
      this.database.exec("ALTER TABLE transcripts ADD COLUMN recording_id TEXT;");
    }
    if (!columns.has("engine_id")) {
      this.database.exec("ALTER TABLE transcripts ADD COLUMN engine_id TEXT;");
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError("The local database is closed.");
    }
  }
}


function mapRecording(row: SqlRow): RecordingRecord {
  const record: RecordingRecord = {
    recordingId: stringValue(row.recording_id),
    meetingId: stringValue(row.meeting_id),
    artifactId: stringValue(row.artifact_id),
    recordingVariant: stringValue(row.recording_variant) as RecordingVariant,
    createdAt: stringValue(row.created_at),
  };
  addOptional(record, "format", optionalString(row.format));
  addOptional(record, "captureStartedAt", optionalString(row.capture_started_at));
  addOptional(record, "captureEndedAt", optionalString(row.capture_ended_at));
  const durationMs = row.duration_ms === undefined || row.duration_ms === null ? undefined : numberValue(row.duration_ms);
  const byteSize = row.byte_size === undefined || row.byte_size === null ? undefined : numberValue(row.byte_size);
  addOptional(record, "durationMs", durationMs);
  addOptional(record, "byteSize", byteSize);
  addOptional(record, "sha256", optionalString(row.sha256));
  addOptional(record, "relativePath", optionalString(row.relative_path));
  addOptional(record, "captureSource", optionalString(row.capture_source));
  addOptional(record, "finalStatus", optionalString(row.final_status) as RecordingFinalStatus | undefined);
  return record;
}

function mapCalendarSyncState(row: SqlRow): CalendarSyncStateRecord {
  const state: CalendarSyncStateRecord = {
    provider: stringValue(row.provider) as CalendarProvider,
    updatedAt: stringValue(row.updated_at),
  };
  addOptional(state, "deltaCursor", optionalString(row.delta_cursor));
  addOptional(state, "syncWindowStart", optionalString(row.window_start));
  addOptional(state, "syncWindowEnd", optionalString(row.window_end));
  addOptional(state, "lastFullSyncAt", optionalString(row.last_full_sync_at));
  addOptional(state, "lastDeltaSyncAt", optionalString(row.last_delta_sync_at));
  return state;
}

function mapCalendarEventAssociation(row: SqlRow): CalendarEventAssociation {
  const association: CalendarEventAssociation = {
    provider: stringValue(row.provider) as CalendarProvider,
    externalEventId: stringValue(row.external_event_id),
    meetingId: stringValue(row.meeting_id),
    subject: stringValue(row.subject),
    startTime: stringValue(row.start_time),
    endTime: stringValue(row.end_time),
    attendees: JSON.parse(stringValue(row.attendees_json)) as CalendarEventAssociation["attendees"],
    isCancelled: numberValue(row.is_cancelled) === 1,
    meetingPlatform: stringValue(row.meeting_platform) as MeetingPlatform,
    normalizedFingerprint: stringValue(row.normalized_fingerprint),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
  const organizerJson = optionalString(row.organizer_json);
  if (organizerJson !== undefined) {
    association.organizer = JSON.parse(organizerJson) as CalendarEventAssociation["organizer"];
  }
  const onlineMeetingJson = optionalString(row.online_meeting_json);
  if (onlineMeetingJson !== undefined) {
    association.onlineMeeting = JSON.parse(onlineMeetingJson) as CalendarEventAssociation["onlineMeeting"];
  }
  addOptional(association, "location", optionalString(row.location));
  addOptional(association, "webUrl", optionalString(row.web_url));
  addOptional(association, "lastModifiedAt", optionalString(row.last_modified_at));
  return association;
}

function calendarEventAssociationEquals(left: CalendarEventAssociation, right: CalendarEventAssociation): boolean {
  return left.meetingId === right.meetingId &&
    left.subject === right.subject &&
    left.startTime === right.startTime &&
    left.endTime === right.endTime &&
    JSON.stringify(left.organizer ?? null) === JSON.stringify(right.organizer ?? null) &&
    JSON.stringify(left.attendees) === JSON.stringify(right.attendees) &&
    (left.location ?? null) === (right.location ?? null) &&
    JSON.stringify(left.onlineMeeting ?? null) === JSON.stringify(right.onlineMeeting ?? null) &&
    (left.webUrl ?? null) === (right.webUrl ?? null) &&
    left.isCancelled === right.isCancelled &&
    (left.lastModifiedAt ?? null) === (right.lastModifiedAt ?? null) &&
    left.meetingPlatform === right.meetingPlatform &&
    left.normalizedFingerprint === right.normalizedFingerprint;
}

function mapArtifactOperation(row: SqlRow): ArtifactOperation {
  const operation: ArtifactOperation = {
    operationId: stringValue(row.operation_id),
    meetingId: stringValue(row.meeting_id),
    relativePath: stringValue(row.relative_path),
    artifactType: stringValue(row.artifact_type) as Artifact["artifactType"],
    state: stringValue(row.state) as ArtifactOperationState,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
  addOptional(operation, "fileId", optionalString(row.file_id));
  addOptional(operation, "expectedSha256", optionalString(row.expected_sha256));
  addOptional(operation, "actualSha256", optionalString(row.actual_sha256));
  const size = row.size === undefined || row.size === null ? undefined : numberValue(row.size);
  addOptional(operation, "size", size);
  addOptional(operation, "error", optionalString(row.error));
  return operation;
}

function mapMeeting(row: SqlRow): Meeting {
  const meeting: Meeting = {
    meetingId: stringValue(row.meeting_id),
    title: stringValue(row.title),
    slug: stringValue(row.slug),
    folderName: stringValue(row.folder_name),
    folderRelativePath: stringValue(row.folder_relative_path),
    meetingDate: stringValue(row.meeting_date),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    status: stringValue(row.status) as MeetingStatus,
    storageVersion: numberValue(row.storage_version),
    metadata: JSON.parse(stringValue(row.metadata_json)) as Record<string, unknown>,
  };
  addOptional(meeting, "startedAt", optionalString(row.started_at));
  addOptional(meeting, "endedAt", optionalString(row.ended_at));
  addOptional(meeting, "providerMeetingId", optionalString(row.provider_meeting_id));
  addOptional(meeting, "calendarEventId", optionalString(row.calendar_event_id));
  return meeting;
}

function mapTranscriptRecord(value: SqlRow): TranscriptRecord {
  const record: TranscriptRecord = {
    transcriptId: stringValue(value.transcript_id),
    meetingId: stringValue(value.meeting_id),
    jsonArtifactId: stringValue(value.json_artifact_id),
    textArtifactId: stringValue(value.text_artifact_id),
    language: stringValue(value.language),
    createdAt: stringValue(value.created_at),
  };
  addOptional(record, "vttArtifactId", optionalString(value.vtt_artifact_id));
  addOptional(record, "srtArtifactId", optionalString(value.srt_artifact_id));
  addOptional(record, "recordingId", optionalString(value.recording_id));
  addOptional(record, "engineId", optionalString(value.engine_id));
  addOptional(record, "sourceCapability", optionalString(value.source_capability));
  addOptional(record, "sourceSha256", optionalString(value.source_sha256));
  return record;
}

function mapArtifact(row: SqlRow): Artifact {
  const artifact: Artifact = {
    fileId: stringValue(row.file_id),
    meetingId: stringValue(row.meeting_id),
    relativePath: stringValue(row.relative_path),
    artifactType: stringValue(row.artifact_type) as Artifact["artifactType"],
    mimeType: stringValue(row.mime_type),
    size: numberValue(row.size),
    createdAt: stringValue(row.created_at),
    modifiedAt: stringValue(row.modified_at),
    sha256: stringValue(row.sha256),
    status: stringValue(row.status) as ArtifactStatus,
  };
  const recordingVariant = optionalString(row.recording_variant) as RecordingVariant | undefined;
  addOptional(artifact, "recordingVariant", recordingVariant);
  return artifact;
}

function mapTaskRecord(value: SqlRow): TaskRecord {
  const task: TaskRecord = {
    taskId: stringValue(value.task_id),
    meetingId: stringValue(value.meeting_id),
    text: stringValue(value.text),
    status: stringValue(value.status) as TaskRecord["status"],
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
  };
  addOptional(task, "projectId", optionalString(value.project_id));
  addOptional(task, "assignee", optionalString(value.assignee));
  addOptional(task, "dueDate", optionalString(value.due_date));
  addOptional(task, "sourceArtifactId", optionalString(value.source_artifact_id));
  return task;
}

function mapNotificationRecord(value: SqlRow): NotificationRecord {
  const record: NotificationRecord = {
    notificationId: stringValue(value.notification_id),
    kind: stringValue(value.kind) as NotificationRecord["kind"],
    severity: stringValue(value.severity) as NotificationRecord["severity"],
    title: stringValue(value.title),
    body: stringValue(value.body),
    createdAt: stringValue(value.created_at),
    dedupeKey: stringValue(value.dedupe_key),
  };
  addOptional(record, "readAt", optionalString(value.read_at));
  addOptional(record, "meetingId", optionalString(value.meeting_id));
  addOptional(record, "taskId", optionalString(value.task_id));
  addOptional(record, "action", optionalString(value.action) as NotificationAction | undefined);
  return record;
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}

function optionalString(value: SqlValue | undefined): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function stringValue(value: SqlValue | undefined): string {
  if (value === undefined || value === null) {
    throw new StorageError("The local database returned an incomplete row.");
  }
  return String(value);
}

function numberValue(value: SqlValue | undefined): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new StorageError("The local database returned an invalid numeric value.");
  }
  return number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique constraint");
}

function isValidMeetingTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_STATUS_TRANSITIONS[from].includes(to);
}
