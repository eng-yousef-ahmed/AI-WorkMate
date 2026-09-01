import { randomUUID } from "node:crypto";
import type {
  AnalysisArtifacts,
  AnalysisDocument,
  Artifact,
  Meeting,
  MeetingStatus,
  RecordingArtifactInput,
  StorageStats,
  TranscriptArtifacts,
  TranscriptDocument,
} from "../domain/models";
import { STORAGE_VERSION } from "../domain/models";
import { BackupService } from "./BackupService";
import { ExportService } from "./ExportService";
import { LocalDatabase, type AuditRecord, type DuplicateMeetingKeys, type ParticipantRecord, type TranscriptRecord } from "./LocalDatabase";
import type { StorageIntegrityService } from "./IntegrityService";
import { RecoveryScanner } from "./RecoveryScanner";
import { RecordingDiskMonitor, type RecordingDiskMonitorOptions } from "./RecordingDiskMonitor";
import {
  buildMeetingFolderName,
  LocalStorageService,
  slugify,
  type ArtifactWriteRequest,
  type LocalStorageServiceOptions,
} from "./LocalStorageService";
import { DataRootValidationError, DuplicateMeetingError, StorageError } from "./errors";

export interface NewMeetingInput {
  title: string;
  meetingDate?: string;
  startedAt?: string;
  endedAt?: string;
  providerMeetingId?: string;
  calendarEventId?: string;
  metadata?: Record<string, unknown>;
  meetingId?: string;
  status?: MeetingStatus;
  recordingSha256?: string;
}

export interface RecordingSaveOptions extends RecordingArtifactInput {
  complete?: boolean;
}

export interface TranscriptSaveOptions {
  includeVtt?: boolean;
  includeSrt?: boolean;
}

export interface DeleteMeetingOptions {
  deleteDatabaseMetadata: boolean;
  deleteLocalFiles: boolean;
  deleteRecording: boolean;
  deleteTranscript: boolean;
  deleteAnalysis: boolean;
}

export interface ApprovalRequest {
  action: "DELETE_MEETING";
  meetingId: string;
  options: DeleteMeetingOptions;
  reason: string;
}

export interface ApprovalEngine {
  approve(request: ApprovalRequest): Promise<boolean> | boolean;
}

export interface LocalFirstStoreOptions extends LocalStorageServiceOptions {
  clock?: () => Date;
  approvalEngine?: ApprovalEngine;
}

export interface RecordingReservation {
  meetingId: string;
  estimatedBytes: number;
  status: "READY";
}

/**
 * Application-facing local-first aggregate. It coordinates filesystem writes
 * and SQLite index updates while retaining the filesystem as the owner of
 * large artifacts.
 */
export class LocalFirstStore {
  public storage: LocalStorageService;
  public database!: LocalDatabase;
  public integrity!: StorageIntegrityService;
  public recovery!: RecoveryScanner;
  public backups!: BackupService;
  public exports!: ExportService;
  private readonly clock: () => Date;
  private readonly approvalEngine: ApprovalEngine;
  private databaseWasMissingAtOpen = false;
  private initialized = false;

  public constructor(dataRoot: string, options: LocalFirstStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.storage = new LocalStorageService(dataRoot, options);
    this.approvalEngine = options.approvalEngine ?? new DenyAllApprovalEngine();
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const hadStorageManifest = await this.storage.exists("storage.json");
    const hadDatabase = await this.storage.exists("Database/ai-workmate.sqlite");
    await this.storage.initialize();
    this.databaseWasMissingAtOpen = hadStorageManifest && !hadDatabase;
    this.database = new LocalDatabase(this.storage.databasePath, this.clock);
    this.database.setMetadata("storageVersion", String(STORAGE_VERSION));
    this.refreshServices();
    this.initialized = true;
  }

  public close(): void {
    if (this.initialized) {
      this.database.close();
      this.initialized = false;
    }
  }

  public getMeeting(meetingId: string): Meeting | undefined {
    return this.requireDatabase().getMeeting(meetingId);
  }

  public listMeetings(): Meeting[] {
    return this.requireDatabase().listMeetings();
  }

  public async createMeeting(input: NewMeetingInput): Promise<Meeting> {
    const database = this.requireDatabase();
    const title = input.title.trim();
    if (!title) {
      throw new DataRootValidationError("A meeting title is required.");
    }
    const meetingId = input.meetingId ?? randomUUID();
    const startedAt = input.startedAt;
    const meetingDate = input.meetingDate ?? startedAt?.slice(0, 10) ?? this.clock().toISOString().slice(0, 10);
    const folderName = buildMeetingFolderName(meetingDate, title, meetingId);
    const now = this.clock().toISOString();
    const meeting: Meeting = {
      meetingId,
      title,
      slug: slugify(title),
      folderName,
      folderRelativePath: this.storage.meetingFolderRelativePath({ folderName, meetingDate }),
      meetingDate,
      createdAt: now,
      updatedAt: now,
      status: input.status ?? "PLANNED",
      storageVersion: STORAGE_VERSION,
    };
    addOptional(meeting, "startedAt", startedAt);
    addOptional(meeting, "endedAt", input.endedAt);
    addOptional(meeting, "providerMeetingId", input.providerMeetingId);
    addOptional(meeting, "calendarEventId", input.calendarEventId);
    addOptional(meeting, "metadata", input.metadata);

    const duplicateKeys: DuplicateMeetingKeys = {};
    addOptional(duplicateKeys, "providerMeetingId", input.providerMeetingId);
    addOptional(duplicateKeys, "calendarEventId", input.calendarEventId);
    addOptional(duplicateKeys, "recordingSha256", input.recordingSha256);
    if (Object.keys(duplicateKeys).length > 0 && database.findDuplicateMeeting(duplicateKeys) !== undefined) {
      const duplicate = database.findDuplicateMeeting(duplicateKeys) as Meeting;
      throw new DuplicateMeetingError(`A matching meeting already exists: ${duplicate.meetingId}`, duplicate.meetingId);
    }

    await this.storage.createMeetingFolder(meeting);
    const manifestPath = `${meeting.folderRelativePath}/Meeting.json`;
    const manifestVerification = await this.storage.inspectFile(manifestPath);
    if (manifestVerification.status !== "AVAILABLE" || manifestVerification.sha256 === undefined || manifestVerification.modifiedAt === undefined) {
      throw new StorageError("Meeting.json could not be verified after meeting creation.");
    }
    const manifestArtifact: Artifact = {
      fileId: randomUUID(),
      meetingId,
      relativePath: manifestPath,
      artifactType: "MEETING_MANIFEST",
      mimeType: "application/json",
      size: manifestVerification.size,
      createdAt: manifestVerification.modifiedAt,
      modifiedAt: manifestVerification.modifiedAt,
      sha256: manifestVerification.sha256,
      status: "AVAILABLE",
    };

    // Folder creation precedes the DB transaction. If the process stops between
    // these operations, the recovery scanner sees Meeting.json and reports an
    // unknown folder instead of silently losing the meeting.
    database.transaction(() => {
      database.createMeeting(meeting);
      database.registerArtifact(manifestArtifact);
      database.appendAudit(this.audit("MEETING_CREATED", meetingId, { folder: meeting.folderRelativePath }));
    });
    return meeting;
  }

  public addParticipant(
    meetingId: string,
    input: { displayName: string; email?: string; participantId?: string; role?: string },
  ): ParticipantRecord {
    this.requireMeeting(meetingId);
    if (!input.displayName.trim()) {
      throw new DataRootValidationError("A participant name is required.");
    }
    const now = this.clock().toISOString();
    const participant: ParticipantRecord = {
      participantId: input.participantId ?? randomUUID(),
      displayName: input.displayName.trim(),
      createdAt: now,
    };
    addOptional(participant, "email", input.email);
    this.database.transaction(() => {
      this.database.upsertParticipant(participant);
      this.database.addParticipantToMeeting(meetingId, participant.participantId, input.role);
      this.database.appendAudit(this.audit("PARTICIPANT_ADDED", meetingId, { participantId: participant.participantId }));
    });
    return participant;
  }

  public async prepareRecording(meetingId: string, estimatedBytes: number): Promise<RecordingReservation> {
    const meeting = this.requireMeeting(meetingId);
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
      throw new DataRootValidationError("estimatedBytes must be a non-negative finite number.");
    }
    await this.storage.checkDiskSpace(estimatedBytes);
    this.database.updateMeetingStatus(meeting.meetingId, "RECORDING");
    this.database.appendAudit(this.audit("RECORDING_STARTED", meetingId, { estimatedBytes }));
    return { meetingId, estimatedBytes, status: "READY" };
  }

  public createRecordingDiskMonitor(
    meetingId: string,
    options: RecordingDiskMonitorOptions,
  ): RecordingDiskMonitor {
    this.requireMeeting(meetingId);
    return new RecordingDiskMonitor(this.storage, {
      ...options,
      onCritical: (availableBytes) => {
        this.database.updateMeetingStatus(meetingId, "INCOMPLETE");
        this.database.appendAudit(this.audit("RECORDING_STOPPED_INCOMPLETE", meetingId, { availableBytes, reason: "LOW_DISK_SPACE" }));
        options.onCritical(availableBytes);
      },
    });
  }

  public markRecordingIncomplete(meetingId: string, reason: string): void {
    this.requireMeeting(meetingId);
    this.database.updateMeetingStatus(meetingId, "INCOMPLETE");
    this.database.appendAudit(this.audit("RECORDING_STOPPED_INCOMPLETE", meetingId, { reason }));
  }

  public async saveRecording(options: RecordingSaveOptions): Promise<Artifact> {
    const meeting = this.requireMeeting(options.meetingId);
    const variant = options.variant ?? "ORIGINAL";
    const contents = options.contents;
    const sourcePath = options.sourcePath;
    let size: number;
    let sha256: string;
    if (sourcePath !== undefined) {
      const source = await this.storage.inspectSourceFile(sourcePath);
      size = source.size;
      sha256 = source.sha256;
    } else if (contents !== undefined) {
      size = contents.byteLength;
      sha256 = this.storage.hashBytes(contents);
    } else {
      throw new DataRootValidationError("A recording requires sourcePath or contents.");
    }
    await this.storage.checkDiskSpace(size);
    const duplicate = this.database.findDuplicateMeeting({ recordingSha256: sha256 });
    if (duplicate !== undefined && duplicate.meetingId !== meeting.meetingId) {
      throw new DuplicateMeetingError(`This recording is already indexed for meeting ${duplicate.meetingId}.`, duplicate.meetingId);
    }

    const artifact = await this.saveAndIndexArtifact(
      {
        meeting,
        artifactType: variant === "ORIGINAL" ? "RECORDING_ORIGINAL" : "RECORDING_NORMALIZED",
        mimeType: options.mimeType,
        extension: options.extension,
        contents,
        sourcePath,
        recordingVariant: variant,
        expectedSha256: sha256,
      },
      false,
    );
    this.database.transaction(() => {
      this.database.registerRecording(randomUUID(), meeting.meetingId, artifact.fileId, variant, this.clock().toISOString());
      this.database.updateMeetingStatus(meeting.meetingId, options.complete === false ? "INCOMPLETE" : "COMPLETED");
      this.database.appendAudit(
        this.audit(options.complete === false ? "RECORDING_STOPPED_INCOMPLETE" : "RECORDING_STOPPED", meeting.meetingId, {
          fileId: artifact.fileId,
          sha256: artifact.sha256,
          size: artifact.size,
          variant,
        }),
      );
    });
    return artifact;
  }

  public async saveAudio(
    meetingId: string,
    input: { extension: string; mimeType: string; contents?: Uint8Array | string; sourcePath?: string },
  ): Promise<Artifact> {
    const meeting = this.requireMeeting(meetingId);
    return this.saveAndIndexArtifact(
      {
        meeting,
        artifactType: "AUDIO",
        mimeType: input.mimeType,
        extension: input.extension,
        contents: input.contents,
        sourcePath: input.sourcePath,
      },
      true,
    );
  }

  public async saveDocument(
    meetingId: string,
    input: { extension: string; mimeType: string; contents?: Uint8Array | string; sourcePath?: string },
  ): Promise<Artifact> {
    const meeting = this.requireMeeting(meetingId);
    return this.saveAndIndexArtifact(
      {
        meeting,
        artifactType: "DOCUMENT",
        mimeType: input.mimeType,
        extension: input.extension,
        contents: input.contents,
        sourcePath: input.sourcePath,
      },
      true,
    );
  }

  public async saveAttachment(
    meetingId: string,
    input: { extension: string; mimeType: string; contents?: Uint8Array | string; sourcePath?: string },
  ): Promise<Artifact> {
    const meeting = this.requireMeeting(meetingId);
    return this.saveAndIndexArtifact(
      {
        meeting,
        artifactType: "ATTACHMENT",
        mimeType: input.mimeType,
        extension: input.extension,
        contents: input.contents,
        sourcePath: input.sourcePath,
      },
      true,
    );
  }

  public async saveTranscript(document: TranscriptDocument, options: TranscriptSaveOptions = {}): Promise<TranscriptArtifacts> {
    const meeting = this.requireMeeting(document.meetingId);
    validateTranscript(document);
    const json = `${JSON.stringify(document, null, 2)}\n`;
    const text = transcriptToText(document);
    const saved: Partial<TranscriptArtifacts> = {};
    saved.json = await this.saveAndIndexArtifact(
      { meeting, artifactType: "TRANSCRIPT_JSON", mimeType: "application/json", extension: "json", contents: json },
      true,
    );
    saved.text = await this.saveAndIndexArtifact(
      { meeting, artifactType: "TRANSCRIPT_TEXT", mimeType: "text/plain", extension: "txt", contents: text },
      true,
    );
    if (options.includeVtt === true) {
      saved.vtt = await this.saveAndIndexArtifact(
        { meeting, artifactType: "TRANSCRIPT_VTT", mimeType: "text/vtt", extension: "vtt", contents: transcriptToVtt(document) },
        true,
      );
    }
    if (options.includeSrt === true) {
      saved.srt = await this.saveAndIndexArtifact(
        { meeting, artifactType: "TRANSCRIPT_SRT", mimeType: "application/x-subrip", extension: "srt", contents: transcriptToSrt(document) },
        true,
      );
    }

    const record: TranscriptRecord = {
      transcriptId: randomUUID(),
      meetingId: meeting.meetingId,
      jsonArtifactId: (saved.json as Artifact).fileId,
      textArtifactId: (saved.text as Artifact).fileId,
      language: document.language,
      createdAt: document.createdAt,
    };
    addOptional(record, "vttArtifactId", saved.vtt?.fileId);
    addOptional(record, "srtArtifactId", saved.srt?.fileId);
    this.database.registerTranscript(record);
    this.database.appendAudit(this.audit("TRANSCRIPT_CREATED", meeting.meetingId, { transcriptId: record.transcriptId }));
    return saved as TranscriptArtifacts;
  }

  public async saveAnalysis(document: AnalysisDocument): Promise<AnalysisArtifacts> {
    const meeting = this.requireMeeting(document.meetingId);
    validateAnalysis(document);
    const savedSummaryJson = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_SUMMARY_JSON", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document, null, 2)}\n` },
      true,
    );
    const savedSummaryMarkdown = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_SUMMARY_MARKDOWN", mimeType: "text/markdown", extension: "md", contents: analysisToMarkdown(document) },
      true,
    );
    const savedDecisions = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_DECISIONS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document.decisions, null, 2)}\n` },
      true,
    );
    const savedTasks = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_TASKS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document.tasks, null, 2)}\n` },
      true,
    );
    const savedRisks = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_RISKS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document.risks, null, 2)}\n` },
      true,
    );
    const savedQuestions = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_QUESTIONS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document.questions, null, 2)}\n` },
      true,
    );
    const savedFollowups = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_FOLLOWUPS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(document.followups, null, 2)}\n` },
      true,
    );

    const createdAt = document.createdAt;
    this.database.transaction(() => {
      const records = [
        ["SUMMARY", savedSummaryJson],
        ["SUMMARY_MARKDOWN", savedSummaryMarkdown],
        ["DECISIONS", savedDecisions],
        ["TASKS", savedTasks],
        ["RISKS", savedRisks],
        ["QUESTIONS", savedQuestions],
        ["FOLLOWUPS", savedFollowups],
      ] as const;
      for (const [kind, artifact] of records) {
        this.database.registerAnalysis({ analysisId: randomUUID(), meetingId: meeting.meetingId, kind, artifactId: artifact.fileId, createdAt });
      }
      for (const decision of document.decisions) {
        this.database.registerDecision({ ...decision, meetingId: meeting.meetingId, createdAt });
      }
      for (const task of document.tasks) {
        this.database.registerTask({ ...task, meetingId: meeting.meetingId, createdAt, updatedAt: createdAt });
        this.database.appendAudit(this.audit("TASK_CREATED", meeting.meetingId, { taskId: task.taskId }));
        if (task.assignee !== undefined) {
          this.database.appendAudit(this.audit("TASK_ASSIGNED", meeting.meetingId, { taskId: task.taskId, assignee: task.assignee }));
        }
      }
      this.database.appendAudit(this.audit("ANALYSIS_CREATED", meeting.meetingId, { createdAt }));
    });
    return {
      summaryJson: savedSummaryJson,
      summaryMarkdown: savedSummaryMarkdown,
      decisions: savedDecisions,
      tasks: savedTasks,
      risks: savedRisks,
      questions: savedQuestions,
      followups: savedFollowups,
    };
  }

  public async verifyStorage() {
    return this.integrity.verifyStorage();
  }

  public async repairStorageIndex() {
    return this.integrity.repairIndex();
  }

  public async getStorageStats(): Promise<StorageStats> {
    return this.storage.getStorageStats(this.database.countMeetings());
  }

  public async migrateDataRoot(destination: string) {
    const oldStorage = this.storage;
    const oldDatabase = this.database;
    const oldMeetings = oldDatabase.listMeetings();
    oldDatabase.checkpoint();
    oldDatabase.close();
    try {
      const result = await oldStorage.migrateTo(destination);
      const newStorage = new LocalStorageService(result.destination, { spaceSafetyMarginBytes: oldStorage.spaceSafetyMarginBytes, clock: this.clock });
      await newStorage.initialize();
      const newDatabase = new LocalDatabase(newStorage.databasePath, this.clock);
      const newIds = new Set(newDatabase.listMeetings().map((meeting) => meeting.meetingId));
      if (newIds.size !== oldMeetings.length || oldMeetings.some((meeting) => !newIds.has(meeting.meetingId))) {
        newDatabase.close();
        throw new StorageError("Migration verification failed: meeting relationships were not preserved.");
      }
      this.storage = newStorage;
      this.database = newDatabase;
      this.databaseWasMissingAtOpen = false;
      this.database.appendAudit(this.audit("DATA_ROOT_CHANGED", undefined, { from: oldStorage.dataRoot, to: result.destination }));
      this.refreshServices();
      return result;
    } catch (error: unknown) {
      // The source was deliberately preserved. Reopen it so the app remains
      // usable if destination verification or the config update fails.
      this.storage = oldStorage;
      this.database = new LocalDatabase(oldStorage.databasePath, this.clock);
      this.refreshServices();
      throw error;
    }
  }

  public async deleteMeeting(meetingId: string, options: DeleteMeetingOptions, reason: string): Promise<void> {
    const meeting = this.requireMeeting(meetingId);
    const approved = await this.approvalEngine.approve({ action: "DELETE_MEETING", meetingId, options, reason });
    if (!approved) {
      throw new StorageError("Delete Meeting was not approved.");
    }
    const artifacts = this.database.listArtifacts(meetingId);
    const shouldDelete = (artifact: Artifact): boolean => {
      if (options.deleteLocalFiles) return true;
      if (options.deleteRecording && (artifact.artifactType === "RECORDING_ORIGINAL" || artifact.artifactType === "RECORDING_NORMALIZED" || artifact.artifactType === "AUDIO")) return true;
      if (options.deleteTranscript && artifact.artifactType.startsWith("TRANSCRIPT_")) return true;
      if (options.deleteAnalysis && artifact.artifactType.startsWith("ANALYSIS_")) return true;
      return false;
    };

    for (const artifact of artifacts.filter(shouldDelete)) {
      try {
        await this.storage.removeRelativePath(artifact.relativePath);
      } catch (error: unknown) {
        if (!isMissingFileError(error)) throw error;
      }
      this.database.updateArtifactVerification(artifact.fileId, "DELETED");
      this.database.appendAudit(this.audit("FILE_DELETED", meetingId, { relativePath: artifact.relativePath, fileId: artifact.fileId }));
    }
    if (options.deleteLocalFiles) {
      // This is deliberate and approval-gated. It also removes unknown files in
      // the selected meeting folder, but never anything outside that folder.
      await this.storage.removeRelativePath(meeting.folderRelativePath).catch((error: unknown) => {
        if (!isMissingFileError(error)) throw error;
      });
    }
    this.database.appendAudit(this.audit("MEETING_DELETED", meetingId, {
      deleteDatabaseMetadata: options.deleteDatabaseMetadata,
      deleteLocalFiles: options.deleteLocalFiles,
    }));
    if (options.deleteDatabaseMetadata) {
      this.database.deleteMeetingMetadata(meetingId);
    }
  }

  private async saveAndIndexArtifact(request: ArtifactWriteRequest, appendAudit: boolean): Promise<Artifact> {
    const artifact = await this.storage.writeArtifact(request);
    const { absolutePath: _absolutePath, ...indexArtifact } = artifact;
    this.database.transaction(() => {
      this.database.registerArtifact(indexArtifact);
      if (appendAudit) {
        this.database.appendAudit(this.audit("FILE_CREATED", artifact.meetingId, { fileId: artifact.fileId, relativePath: artifact.relativePath }));
      }
    });
    return indexArtifact;
  }

  private requireDatabase(): LocalDatabase {
    if (!this.initialized) {
      throw new StorageError("LocalFirstStore.initialize() must be called before use.");
    }
    return this.database;
  }

  private requireMeeting(meetingId: string): Meeting {
    const meeting = this.requireDatabase().getMeeting(meetingId);
    if (meeting === undefined) {
      throw new DataRootValidationError(`Meeting not found: ${meetingId}`);
    }
    return meeting;
  }

  private refreshServices(): void {
    this.recovery = new RecoveryScanner(this.storage, this.database, this.clock, this.databaseWasMissingAtOpen);
    this.integrity = this.recovery;
    this.backups = new BackupService(this.storage, this.database, this.clock);
    this.exports = new ExportService(this.storage, this.database, this.clock);
  }

  private audit(action: string, meetingId?: string, details?: Record<string, unknown>): AuditRecord {
    const record: AuditRecord = { auditId: randomUUID(), action, createdAt: this.clock().toISOString() };
    addOptional(record, "meetingId", meetingId);
    addOptional(record, "details", details);
    return record;
  }
}

export class DenyAllApprovalEngine implements ApprovalEngine {
  public approve(_request: ApprovalRequest): boolean {
    return false;
  }
}

function validateTranscript(document: TranscriptDocument): void {
  if (!document.language || !document.createdAt || document.timestamps !== true) {
    throw new DataRootValidationError("A transcript must include language, createdAt, and timestamps.");
  }
  for (const segment of document.segments) {
    if (
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.endMs) ||
      segment.startMs < 0 ||
      segment.endMs < segment.startMs ||
      segment.text.trim().length === 0 ||
      (segment.confidence !== undefined && (segment.confidence < 0 || segment.confidence > 1))
    ) {
      throw new DataRootValidationError(`Invalid transcript segment: ${segment.segmentId}`);
    }
  }
}

function validateAnalysis(document: AnalysisDocument): void {
  if (!document.createdAt || document.meetingId.length === 0) {
    throw new DataRootValidationError("Analysis must include meetingId and createdAt.");
  }
}

function transcriptToText(document: TranscriptDocument): string {
  const speakers = new Map(document.speakers.map((speaker) => [speaker.speakerId, speaker.displayName ?? speaker.speakerId]));
  return document.segments
    .map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.speakerId ? speakers.get(segment.speakerId) ?? segment.speakerId : "Speaker"}: ${segment.text}`)
    .join("\n") + "\n";
}

function transcriptToVtt(document: TranscriptDocument): string {
  const speakers = new Map(document.speakers.map((speaker) => [speaker.speakerId, speaker.displayName ?? speaker.speakerId]));
  const lines = ["WEBVTT", ""];
  for (const segment of document.segments) {
    lines.push(`${formatTimestamp(segment.startMs)} --> ${formatTimestamp(segment.endMs)}`);
    const speaker = segment.speakerId ? `${speakers.get(segment.speakerId) ?? segment.speakerId}: ` : "";
    lines.push(`${speaker}${segment.text}`, "");
  }
  return lines.join("\n");
}

function transcriptToSrt(document: TranscriptDocument): string {
  const speakers = new Map(document.speakers.map((speaker) => [speaker.speakerId, speaker.displayName ?? speaker.speakerId]));
  const lines: string[] = [];
  document.segments.forEach((segment, index) => {
    lines.push(String(index + 1));
    lines.push(`${formatTimestamp(segment.startMs, ",")} --> ${formatTimestamp(segment.endMs, ",")}`);
    const speaker = segment.speakerId ? `${speakers.get(segment.speakerId) ?? segment.speakerId}: ` : "";
    lines.push(`${speaker}${segment.text}`, "");
  });
  return lines.join("\n");
}

function formatTimestamp(milliseconds: number, separator = "."): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = Math.floor(milliseconds % 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function analysisToMarkdown(document: AnalysisDocument): string {
  const section = (title: string, values: string[]): string => `## ${title}\n${values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "_None recorded._"}\n`;
  return [
    "# Meeting Summary",
    "",
    document.summary.trim(),
    "",
    section("Decisions", document.decisions.map((decision) => decision.text)),
    section("Action Items", document.tasks.map((task) => task.text)),
    section("Risks", document.risks),
    section("Questions", document.questions),
    section("Follow-ups", document.followups),
  ].join("\n");
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
