import { backup, DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DATABASE_SCHEMA_VERSION,
  type ActionItem,
  type Artifact,
  type ArtifactStatus,
  type Decision,
  type Meeting,
  type MeetingStatus,
  type RecordingVariant,
} from "../domain/models";
import { DuplicateMeetingError, StorageError } from "./errors";

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
}

export interface AnalysisRecord {
  analysisId: string;
  meetingId: string;
  kind: string;
  artifactId: string;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
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
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'RECORDING', 'COMPLETED', 'INCOMPLETE')),
  storage_version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS meetings_provider_id_unique
  ON meetings(provider_meeting_id) WHERE provider_meeting_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meetings_calendar_event_id_unique
  ON meetings(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meetings_date_index ON meetings(meeting_date);
CREATE INDEX IF NOT EXISTS meetings_status_index ON meetings(status);

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

CREATE TABLE IF NOT EXISTS recordings (
  recording_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  recording_variant TEXT NOT NULL CHECK (recording_variant IN ('ORIGINAL', 'NORMALIZED')),
  created_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_meeting_index ON transcripts(meeting_id);

CREATE TABLE IF NOT EXISTS analysis_records (
  analysis_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(file_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(meeting_id, kind)
);
CREATE INDEX IF NOT EXISTS analysis_meeting_index ON analysis_records(meeting_id);

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

  public updateMeetingStatus(meetingId: string, status: MeetingStatus, endedAt?: string): void {
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

  public registerRecording(
    recordingId: string,
    meetingId: string,
    artifactId: string,
    recordingVariant: RecordingVariant,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO recordings (recording_id, meeting_id, artifact_id, recording_variant, created_at)
         VALUES ($recordingId, $meetingId, $artifactId, $recordingVariant, $createdAt)`,
      )
      .run({ $recordingId: recordingId, $meetingId: meetingId, $artifactId: artifactId, $recordingVariant: recordingVariant, $createdAt: createdAt });
  }

  public registerTranscript(record: TranscriptRecord): void {
    this.database
      .prepare(
        `INSERT INTO transcripts (
          transcript_id, meeting_id, json_artifact_id, text_artifact_id,
          vtt_artifact_id, srt_artifact_id, language, created_at
        ) VALUES (
          $transcriptId, $meetingId, $jsonArtifactId, $textArtifactId,
          $vttArtifactId, $srtArtifactId, $language, $createdAt
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
      });
  }

  public listTranscripts(meetingId: string): TranscriptRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM transcripts WHERE meeting_id = $meetingId ORDER BY created_at")
      .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
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
      return record;
    });
  }

  public registerAnalysis(record: AnalysisRecord): void {
    this.database
      .prepare(
        `INSERT INTO analysis_records (analysis_id, meeting_id, kind, artifact_id, created_at)
         VALUES ($analysisId, $meetingId, $kind, $artifactId, $createdAt)
         ON CONFLICT(meeting_id, kind) DO UPDATE SET artifact_id = excluded.artifact_id, created_at = excluded.created_at`,
      )
      .run({
        $analysisId: record.analysisId,
        $meetingId: record.meetingId,
        $kind: record.kind,
        $artifactId: record.artifactId,
        $createdAt: record.createdAt,
      });
  }

  public listAnalysis(meetingId: string): AnalysisRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM analysis_records WHERE meeting_id = $meetingId ORDER BY kind")
      .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
      return {
        analysisId: stringValue(value.analysis_id),
        meetingId: stringValue(value.meeting_id),
        kind: stringValue(value.kind),
        artifactId: stringValue(value.artifact_id),
        createdAt: stringValue(value.created_at),
      };
    });
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
          task_id, meeting_id, project_id, text, assignee, due_date, status,
          created_at, updated_at
        ) VALUES (
          $taskId, $meetingId, $projectId, $text, $assignee, $dueDate, $status,
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
        $createdAt: task.createdAt,
        $updatedAt: task.updatedAt,
      });
  }

  public listTasks(meetingId: string): TaskRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM tasks WHERE meeting_id = $meetingId ORDER BY created_at")
      .all({ $meetingId: meetingId });
    return rows.map((row) => {
      const value = row as SqlRow;
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
      return task;
    });
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
      this.database
        .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES ($version, $appliedAt)")
        .run({ $version: DATABASE_SCHEMA_VERSION, $appliedAt: this.clock().toISOString() });
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError("The local database is closed.");
    }
  }
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
