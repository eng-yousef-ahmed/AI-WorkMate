import { randomUUID } from "node:crypto";
import type {
  AnalysisArtifacts,
  AnalysisDocument,
  Artifact,
  CalendarEventAssociation,
  MeetingPlatform,
  ArtifactOperation,
  Meeting,
  MeetingStatus,
  RecordingArtifactInput,
  RecordingVariant,
  StorageStats,
  TranscriptArtifacts,
  TranscriptDocument,
} from "../domain/models";
import { STORAGE_VERSION, type TranscriptSegment } from "../domain/models";
import type { CalendarMeetingUpsertResult, NormalizedCalendarEvent } from "../calendar/CalendarModels";
import type { AIProvider } from "../ai/AIProvider";
import { assignPersistentAnalysisIdentities, parseAnalysisDocument, validateAnalysisDocument } from "../ai/AnalysisDocument";
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
  type FileVerification,
  type LocalStorageServiceOptions,
  type StorageMigrationPhaseHandler,
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

export interface RecordingIngestionRequest {
  meetingId: string;
  sourceType: "FILE" | "STREAM";
  sourcePath: string;
  originalFilename?: string;
  mimeType: string;
  capturedAt?: string;
  startedAt?: string;
  endedAt?: string;
  size?: number;
}

export interface TranscriptIngestionRequest {
  meetingId: string;
  format: "PLAIN_TEXT" | "JSON" | "VTT" | "SRT";
  content: string;
  language: string;
  createdAt?: string;
}

export interface TranscriptSaveOptions {
  includeVtt?: boolean;
  includeSrt?: boolean;
  recordingId?: string;
  engineId?: string;
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

export interface RecordingCaptureStartInput {
  meetingId: string;
  extension: string;
  mimeType: string;
  estimatedBytes?: number;
  captureSource: string;
  startedAt?: string;
  recordingVariant?: RecordingVariant;
}

export interface RecordingCaptureOperation {
  operationId: string;
  meetingId: string;
  relativePath: string;
  extension: string;
  mimeType: string;
  captureSource: string;
  startedAt: string;
  recordingVariant: RecordingVariant;
}

export interface RecordingCaptureCommitInput extends RecordingCaptureOperation {
  verification: FileVerification & { sha256: string; modifiedAt: string };
  endedAt: string;
  durationMs?: number;
}

export interface RecordingCaptureFailureInput {
  meetingId: string;
  operationId: string;
  reason: string;
  failed?: boolean;
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
  private readonly interruptedRecordingMeetingIds = new Set<string>();
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
    this.recoverInterruptedRecordings();
    await this.recoverArtifactOperations();
    this.recoverInterruptedTranscriptions();
    this.recoverInterruptedAnalyses();
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

  public getRecording(recordingId: string) {
    return this.requireDatabase().getRecording(recordingId);
  }

  public getDataRoot(): string {
    return this.storage.dataRoot;
  }

  public async readArtifactBytes(relativePath: string): Promise<Uint8Array> {
    return this.storage.readFile(relativePath);
  }

  public resolveArtifactAbsolutePath(relativePath: string): string {
    return this.storage.absolutePathFor(relativePath);
  }

  public beginTranscription(meetingId: string, recordingId: string): void {
    this.requireMeeting(meetingId);
    this.transitionMeeting(meetingId, "PROCESSING");
    this.database.appendAudit(this.audit("TRANSCRIPTION_STARTED", meetingId, { recordingId }));
  }

  public completeTranscription(meetingId: string): void {
    this.transitionMeeting(meetingId, "COMPLETED");
    this.database.appendAudit(this.audit("TRANSCRIPTION_COMPLETED", meetingId));
  }

  public failTranscription(meetingId: string, status: "FAILED" | "INCOMPLETE"): void {
    try {
      this.transitionMeeting(meetingId, status);
    } catch {
      // Recovery may already have moved the meeting; preserve the original transcription error.
    }
    this.database.appendAudit(this.audit(status === "FAILED" ? "TRANSCRIPTION_FAILED" : "TRANSCRIPTION_INCOMPLETE", meetingId));
  }

  public beginAnalysis(meetingId: string, recordingId: string): void {
    this.requireMeeting(meetingId);
    this.transitionMeeting(meetingId, "PROCESSING");
    this.database.appendAudit(this.audit("ANALYSIS_STARTED", meetingId, { recordingId }));
  }

  public completeAnalysis(meetingId: string): void {
    this.transitionMeeting(meetingId, "COMPLETED");
    this.database.appendAudit(this.audit("ANALYSIS_COMPLETED", meetingId));
  }

  public failAnalysis(meetingId: string, status: "FAILED" | "INCOMPLETE"): void {
    try {
      this.transitionMeeting(meetingId, status);
    } catch {
      // Recovery or the provider boundary may already have moved the meeting.
    }
    this.database.appendAudit(this.audit(status === "FAILED" ? "ANALYSIS_FAILED" : "ANALYSIS_INCOMPLETE", meetingId));
  }

  public transitionMeeting(meetingId: string, status: MeetingStatus): void {
    this.database.updateMeetingStatus(meetingId, status);
  }

  public listMeetings(): Meeting[] {
    return this.requireDatabase().listMeetings();
  }

  public async upsertCalendarMeeting(
    event: NormalizedCalendarEvent & { meetingPlatform: MeetingPlatform; normalizedFingerprint: string },
  ): Promise<CalendarMeetingUpsertResult> {
    const database = this.requireDatabase();
    if (event.provider !== "MICROSOFT_GRAPH") {
      throw new StorageError(`Unsupported calendar provider: ${event.provider}`);
    }
    let existingAssociation = database.getCalendarEventAssociation(event.provider, event.externalEventId);
    let meeting = existingAssociation === undefined ? undefined : database.getMeeting(existingAssociation.meetingId);
    if (existingAssociation !== undefined && meeting === undefined) {
      throw new StorageError(`Calendar association points to a missing meeting: ${existingAssociation.meetingId}`);
    }
    if (meeting === undefined) {
      meeting = database.findDuplicateMeeting({ calendarEventId: event.externalEventId }) ??
        database.findDuplicateMeeting({ calendarEventId: `${event.provider}:${event.externalEventId}` });
    }
    if (event.isCancelled && meeting === undefined) {
      return { action: "CANCELLED_SKIPPED" };
    }

    let createdMeeting = false;
    if (meeting === undefined) {
      try {
        meeting = await this.createMeeting({
          title: event.subject,
          meetingDate: meetingDateFromCalendarStart(event.startTime),
          startedAt: event.startTime,
          endedAt: event.endTime,
          calendarEventId: event.externalEventId,
          status: "SCHEDULED",
          metadata: {
            calendarDiscovery: {
              provider: event.provider,
              externalEventId: event.externalEventId,
              meetingPlatform: event.meetingPlatform,
            },
          },
        });
        createdMeeting = true;
      } catch (error: unknown) {
        if (!(error instanceof DuplicateMeetingError)) {
          throw error;
        }
        if (error.meetingId === undefined) {
          throw error;
        }
        meeting = database.getMeeting(error.meetingId);
        if (meeting === undefined) {
          throw error;
        }
      }
    }

    existingAssociation = database.getCalendarEventAssociation(event.provider, event.externalEventId);
    const now = this.clock().toISOString();
    const association = calendarAssociationFromEvent(
      event,
      meeting.meetingId,
      existingAssociation?.createdAt ?? now,
      now,
    );

    const transactionResult = database.transaction(() => {
      const associationAction = database.upsertCalendarEventAssociation(association);
      let statusChanged = false;
      if (event.isCancelled && meeting.status === "SCHEDULED") {
        database.updateMeetingStatus(meeting.meetingId, "CANCELLED");
        statusChanged = true;
      }
      if (associationAction === "CREATED") {
        database.appendAudit(this.audit("CALENDAR_EVENT_ASSOCIATED", meeting.meetingId, {
          provider: event.provider,
          externalEventId: event.externalEventId,
          meetingPlatform: event.meetingPlatform,
        }));
      } else if (associationAction === "UPDATED") {
        database.appendAudit(this.audit("CALENDAR_EVENT_UPDATED", meeting.meetingId, {
          provider: event.provider,
          externalEventId: event.externalEventId,
          meetingPlatform: event.meetingPlatform,
          isCancelled: event.isCancelled,
        }));
      }
      if (statusChanged) {
        database.appendAudit(this.audit("CALENDAR_EVENT_CANCELLED", meeting.meetingId, {
          provider: event.provider,
          externalEventId: event.externalEventId,
        }));
      }
      return { associationAction, statusChanged };
    });

    const persistedAssociation = database.getCalendarEventAssociation(event.provider, event.externalEventId);
    if (createdMeeting) {
      return { action: "CREATED", meetingId: meeting.meetingId, association: persistedAssociation };
    }
    if (
      transactionResult.associationAction === "CREATED" ||
      transactionResult.associationAction === "UPDATED" ||
      transactionResult.statusChanged
    ) {
      return { action: "UPDATED", meetingId: meeting.meetingId, association: persistedAssociation };
    }
    return { action: "UNCHANGED", meetingId: meeting.meetingId, association: persistedAssociation };
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
      status: input.status ?? "SCHEDULED",
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
    this.transitionMeeting(meeting.meetingId, "PREPARING");
    this.database.appendAudit(this.audit("RECORDING_PREPARED", meetingId, { estimatedBytes }));
    return { meetingId, estimatedBytes, status: "READY" };
  }

  public async beginRecordingCapture(input: RecordingCaptureStartInput): Promise<RecordingCaptureOperation> {
    const meeting = this.requireMeeting(input.meetingId);
    const estimatedBytes = input.estimatedBytes ?? 0;
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
      throw new DataRootValidationError("estimatedBytes must be a non-negative finite number.");
    }
    try {
      await this.storage.checkDiskSpace(estimatedBytes);
    } catch (error: unknown) {
      this.transitionCaptureFailure(meeting.meetingId, true);
      this.database.appendAudit(this.audit("CAPTURE_PREFLIGHT_FAILED", meeting.meetingId, {
        reason: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }

    const recordingVariant = input.recordingVariant ?? "ORIGINAL";
    const artifactType = recordingVariant === "ORIGINAL" ? "RECORDING_ORIGINAL" : "RECORDING_NORMALIZED";
    const relativePath = this.storage.buildArtifactRelativePath(meeting, artifactType, input.extension);
    const operation: ArtifactOperation = {
      operationId: randomUUID(),
      meetingId: meeting.meetingId,
      relativePath,
      artifactType,
      state: "STARTED",
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    };
    const startedAt = input.startedAt ?? this.clock().toISOString();
    this.database.transaction(() => {
      this.transitionMeetingForCaptureStart(meeting.meetingId);
      this.database.startArtifactOperation(operation);
      this.database.appendAudit(this.audit("CAPTURE_STARTED", meeting.meetingId, {
        operationId: operation.operationId,
        relativePath,
        captureSource: input.captureSource,
      }));
    });
    return {
      operationId: operation.operationId,
      meetingId: meeting.meetingId,
      relativePath,
      extension: input.extension,
      mimeType: input.mimeType,
      captureSource: input.captureSource,
      startedAt,
      recordingVariant,
    };
  }

  public markRecordingCaptureWriting(operationId: string): void {
    const operation = this.requireArtifactOperation(operationId);
    if (operation.state !== "STARTED") {
      throw new StorageError(`Capture operation ${operationId} cannot move to WRITING from ${operation.state}.`);
    }
    this.database.updateArtifactOperation(operationId, { state: "WRITING" });
  }

  public commitRecordingCapture(input: RecordingCaptureCommitInput): Artifact {
    const meeting = this.requireMeeting(input.meetingId);
    const operation = this.requireArtifactOperation(input.operationId);
    const expectedType = input.recordingVariant === "ORIGINAL" ? "RECORDING_ORIGINAL" : "RECORDING_NORMALIZED";
    if (operation.meetingId !== meeting.meetingId || operation.relativePath !== input.relativePath || operation.artifactType !== expectedType) {
      throw new StorageError("Capture operation does not match the meeting-owned recording artifact.");
    }
    if (operation.state !== "WRITING" && operation.state !== "FINALIZING") {
      throw new StorageError(`Capture operation ${operation.operationId} cannot be committed from ${operation.state}.`);
    }
    if (input.verification.status !== "AVAILABLE") {
      throw new StorageError(`Capture artifact is not available for commit: ${input.verification.status}.`);
    }
    const now = this.clock().toISOString();
    const artifact: Artifact = {
      fileId: randomUUID(),
      meetingId: meeting.meetingId,
      relativePath: input.relativePath,
      artifactType: expectedType,
      mimeType: input.mimeType,
      size: input.verification.size,
      createdAt: now,
      modifiedAt: input.verification.modifiedAt,
      sha256: input.verification.sha256,
      status: "AVAILABLE",
      recordingVariant: input.recordingVariant,
    };
    this.database.transaction(() => {
      this.database.updateMeetingStatus(meeting.meetingId, "FINALIZING");
      this.database.registerArtifact(artifact);
      this.database.registerRecording({
        recordingId: randomUUID(),
        meetingId: meeting.meetingId,
        artifactId: artifact.fileId,
        recordingVariant: input.recordingVariant,
        createdAt: now,
        format: input.extension,
        captureStartedAt: input.startedAt,
        captureEndedAt: input.endedAt,
        durationMs: input.durationMs,
        byteSize: artifact.size,
        sha256: artifact.sha256,
        relativePath: artifact.relativePath,
        captureSource: input.captureSource,
        finalStatus: "COMMITTED",
      });
      this.database.updateArtifactOperation(input.operationId, {
        state: "FINALIZING",
        fileId: artifact.fileId,
        actualSha256: artifact.sha256,
        size: artifact.size,
      });
      this.database.updateArtifactOperation(input.operationId, { state: "COMMITTED" });
      this.database.updateMeetingStatus(meeting.meetingId, "PROCESSING");
      this.database.appendAudit(this.audit("CAPTURE_COMMITTED", meeting.meetingId, {
        operationId: input.operationId,
        fileId: artifact.fileId,
        sha256: artifact.sha256,
        size: artifact.size,
      }));
    });
    return artifact;
  }

  public failRecordingCapture(input: RecordingCaptureFailureInput): void {
    const operation = this.requireArtifactOperation(input.operationId);
    if (operation.meetingId !== input.meetingId) {
      throw new StorageError("Capture failure does not match the meeting-owned recording operation.");
    }
    if (operation.state === "COMMITTED") {
      throw new StorageError("A committed capture operation cannot be failed.");
    }
    this.database.transaction(() => {
      this.database.updateArtifactOperation(input.operationId, {
        state: input.failed === true ? "FAILED" : "INCOMPLETE",
        error: input.reason,
      });
      this.transitionCaptureFailure(input.meetingId, input.failed === true);
      this.database.appendAudit(this.audit(input.failed === true ? "CAPTURE_FAILED" : "CAPTURE_INCOMPLETE", input.meetingId, {
        operationId: input.operationId,
        reason: input.reason,
      }));
    });
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

  /** Production capture boundary: only a real file supplied by a capture engine is accepted. */
  public async ingestRecording(request: RecordingIngestionRequest): Promise<Artifact> {
    if (request.sourceType !== "FILE") {
      throw new StorageError("STREAM ingestion requires a capture adapter that materializes a verified file first.");
    }
    const extension = request.originalFilename?.split(".").pop() ?? mimeExtension(request.mimeType);
    return this.saveRecording({
      meetingId: request.meetingId, sourcePath: request.sourcePath, extension, mimeType: request.mimeType,
      originalFilename: request.originalFilename, capturedAt: request.capturedAt,
      sourceMetadata: { sourceType: request.sourceType, ...(request.size === undefined ? {} : { size: request.size }) },
    });
  }

  /** Production transcription boundary; content is supplied by a real transcription engine. */
  public async ingestTranscript(request: TranscriptIngestionRequest): Promise<TranscriptArtifacts> {
    if (!request.content) throw new DataRootValidationError("Transcript content cannot be empty.");
    const createdAt = request.createdAt ?? this.clock().toISOString();
    let document: TranscriptDocument;
    if (request.format === "JSON") {
      document = JSON.parse(request.content) as TranscriptDocument;
    } else {
      const segment: TranscriptSegment = { segmentId: randomUUID(), startMs: 0, endMs: 0, text: request.content };
      document = { meetingId: request.meetingId, speakers: [], timestamps: false, segments: [segment], language: request.language, createdAt };
    }
    if (document.meetingId !== request.meetingId) throw new DataRootValidationError("Transcript meeting ID does not match ingestion request.");
    return this.saveTranscript(document, { includeVtt: request.format === "VTT", includeSrt: request.format === "SRT" });
  }

  public async saveRecording(options: RecordingSaveOptions): Promise<Artifact> {
    const meeting = this.requireMeeting(options.meetingId);
    if (meeting.status === "SCHEDULED" || meeting.status === "DETECTED") this.transitionMeeting(meeting.meetingId, "PREPARING");
    if (this.getMeeting(meeting.meetingId)?.status === "PREPARING") this.transitionMeeting(meeting.meetingId, "RECORDING");
    if (this.getMeeting(meeting.meetingId)?.status === "RECORDING") this.transitionMeeting(meeting.meetingId, "FINALIZING");
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

    return this.saveAndIndexArtifact(
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
      (artifact) => {
        const preserveIncomplete = this.database.getMeeting(meeting.meetingId)?.status === "INCOMPLETE";
        const incomplete = options.complete === false || preserveIncomplete;
        const recordingCreatedAt = this.clock().toISOString();
        const metadata = options.sourceMetadata ?? {};
        this.database.registerRecording({
          recordingId: randomUUID(),
          meetingId: meeting.meetingId,
          artifactId: artifact.fileId,
          recordingVariant: variant,
          createdAt: recordingCreatedAt,
          format: options.extension,
          captureStartedAt: stringMetadata(metadata.captureStartedAt) ?? options.capturedAt,
          captureEndedAt: stringMetadata(metadata.captureEndedAt),
          durationMs: numberMetadata(metadata.durationMs),
          byteSize: artifact.size,
          sha256: artifact.sha256,
          relativePath: artifact.relativePath,
          captureSource: stringMetadata(metadata.captureSource) ?? stringMetadata(metadata.sourceType) ?? (options.sourcePath === undefined ? "MEMORY" : "FILE"),
          finalStatus: incomplete ? "INCOMPLETE" : "COMMITTED",
        });
        this.database.updateMeetingStatus(meeting.meetingId, incomplete ? "INCOMPLETE" : "COMPLETED");
        this.database.appendAudit(
          this.audit(incomplete ? "RECORDING_STOPPED_INCOMPLETE" : "RECORDING_STOPPED", meeting.meetingId, {
            fileId: artifact.fileId,
            sha256: artifact.sha256,
            size: artifact.size,
            variant,
          }),
        );
      },
    );
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
    addOptional(record, "recordingId", options.recordingId ?? document.recordingId);
    addOptional(record, "engineId", options.engineId ?? document.engine?.id);
    this.database.registerTranscript(record);
    this.database.appendAudit(this.audit("TRANSCRIPT_CREATED", meeting.meetingId, { transcriptId: record.transcriptId }));
    return saved as TranscriptArtifacts;
  }

  public async saveAnalysis(document: AnalysisDocument): Promise<AnalysisArtifacts> {
    const meeting = this.requireMeeting(document.meetingId);
    validateAnalysis(document);
    const persistable = assignPersistentAnalysisIdentities(document);
    const savedSummaryJson = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_SUMMARY_JSON", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable, null, 2)}\n` },
      true,
    );
    const savedSummaryMarkdown = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_SUMMARY_MARKDOWN", mimeType: "text/markdown", extension: "md", contents: analysisToMarkdown(persistable) },
      true,
    );
    const savedDecisions = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_DECISIONS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable.decisions, null, 2)}\n` },
      true,
    );
    const savedTasks = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_TASKS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable.tasks, null, 2)}\n` },
      true,
    );
    const savedRisks = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_RISKS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable.risks, null, 2)}\n` },
      true,
    );
    const savedQuestions = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_QUESTIONS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable.questions, null, 2)}\n` },
      true,
    );
    const savedFollowups = await this.saveAndIndexArtifact(
      { meeting, artifactType: "ANALYSIS_FOLLOWUPS", mimeType: "application/json", extension: "json", contents: `${JSON.stringify(persistable.followups, null, 2)}\n` },
      true,
    );

    const createdAt = persistable.createdAt;
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
      for (const decision of persistable.decisions) {
        this.database.registerDecision({ ...decision, meetingId: meeting.meetingId, createdAt });
      }
      for (const task of persistable.tasks) {
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

  /** Runs the real provider boundary and persists only a validated result locally. */
  public async processTranscriptWithProvider(document: TranscriptDocument, provider: AIProvider): Promise<AnalysisDocument> {
    const meeting = this.requireMeeting(document.meetingId);
    this.transitionMeeting(meeting.meetingId, "PROCESSING");
    try {
      const result = await provider.process({ meetingId: document.meetingId, purpose: "SUMMARY", content: JSON.stringify(document), language: document.language });
      if (result.persistedByProvider !== false) {
        throw new StorageError("AI provider must not persist meeting data; cloud AI is processing only.");
      }
      const analysis = parseAnalysisDocument(result.output, document.meetingId);
      await this.saveAnalysis(analysis);
      this.transitionMeeting(meeting.meetingId, "COMPLETED");
      this.database.appendAudit(this.audit("ANALYSIS_COMPLETED", meeting.meetingId, { providerId: result.providerId }));
      return analysis;
    } catch (error) {
      try {
        this.transitionMeeting(meeting.meetingId, "FAILED");
      } catch {
        // Keep the provider/validation error as the thrown cause.
      }
      throw error;
    }
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

  public async migrateDataRoot(
    destination: string,
    onPhase?: StorageMigrationPhaseHandler,
  ) {
    const oldStorage = this.storage;
    const oldDatabase = this.database;
    const oldMeetings = oldDatabase.listMeetings();
    oldDatabase.checkpoint();
    oldDatabase.close();
    try {
      const result = await oldStorage.migrateTo(destination, onPhase);
      const newStorage = new LocalStorageService(result.destination, {
        spaceSafetyMarginBytes: oldStorage.spaceSafetyMarginBytes,
        clock: this.clock,
        installationDirectory: oldStorage.installationDirectoryPath,
      });
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
      await onPhase?.("RUNTIME_SWITCHED");
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

  private async saveAndIndexArtifact(
    request: ArtifactWriteRequest,
    appendAudit: boolean,
    afterIndexed?: (artifact: Artifact) => void,
  ): Promise<Artifact> {
    const relativePath = request.relativePath === undefined
      ? this.storage.buildArtifactRelativePath(request.meeting, request.artifactType, request.extension)
      : this.storage.assertRelativePath(request.relativePath);
    const operation: ArtifactOperation = {
      operationId: randomUUID(),
      meetingId: request.meeting.meetingId,
      relativePath,
      artifactType: request.artifactType,
      state: "STARTED",
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    };
    if (request.expectedSha256 !== undefined) {
      operation.expectedSha256 = request.expectedSha256;
    }
    this.database.startArtifactOperation(operation);

    try {
      this.database.updateArtifactOperation(operation.operationId, { state: "WRITING" });
      const artifact = await this.storage.writeArtifact({ ...request, relativePath });
      this.database.updateArtifactOperation(operation.operationId, {
        state: "FINALIZING",
        fileId: artifact.fileId,
        actualSha256: artifact.sha256,
        size: artifact.size,
      });
      const { absolutePath: _absolutePath, ...indexArtifact } = artifact;
      this.database.transaction(() => {
        this.database.registerArtifact(indexArtifact);
        afterIndexed?.(indexArtifact);
        this.database.updateArtifactOperation(operation.operationId, { state: "COMMITTED" });
        if (appendAudit) {
          this.database.appendAudit(this.audit("FILE_CREATED", artifact.meetingId, { fileId: artifact.fileId, relativePath: artifact.relativePath }));
        }
      });
      return indexArtifact;
    } catch (error: unknown) {
      const verification = await this.storage.inspectFile(relativePath).catch(() => ({ status: "MISSING" as const }));
      const state = verification.status === "AVAILABLE" ? "INCOMPLETE" : "FAILED";
      this.database.updateArtifactOperation(operation.operationId, {
        state,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private recoverInterruptedAnalyses(): void {
    for (const operation of this.database.listIncompleteArtifactOperations()) {
      if (!operation.artifactType.startsWith("ANALYSIS_")) {
        continue;
      }
      const meeting = this.database.getMeeting(operation.meetingId);
      if (meeting?.status === "PROCESSING") {
        this.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
        this.database.appendAudit(this.audit("ANALYSIS_RECOVERED_INCOMPLETE", meeting.meetingId, {
          operationId: operation.operationId,
          reason: "APPLICATION_RESTARTED_DURING_ANALYSIS",
        }));
      }
    }
    for (const meeting of this.database.listMeetings()) {
      if (meeting.status !== "PROCESSING") {
        continue;
      }
      const audits = this.database.listAuditRecords(500).filter((record) => record.meetingId === meeting.meetingId);
      const started = audits.some((record) => record.action === "ANALYSIS_STARTED");
      const finished = audits.some((record) => record.action === "ANALYSIS_CREATED" || record.action === "ANALYSIS_COMPLETED");
      if (started && !finished) {
        this.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
        this.database.appendAudit(this.audit("ANALYSIS_RECOVERED_INCOMPLETE", meeting.meetingId, {
          reason: "APPLICATION_RESTARTED_DURING_ANALYSIS",
        }));
      }
    }
  }

  private recoverInterruptedTranscriptions(): void {
    for (const operation of this.database.listIncompleteArtifactOperations()) {
      if (!operation.artifactType.startsWith("TRANSCRIPT_")) {
        continue;
      }
      const meeting = this.database.getMeeting(operation.meetingId);
      if (meeting?.status === "PROCESSING") {
        this.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
        this.database.appendAudit(this.audit("TRANSCRIPTION_RECOVERED_INCOMPLETE", meeting.meetingId, {
          operationId: operation.operationId,
          reason: "APPLICATION_RESTARTED_DURING_TRANSCRIPTION",
        }));
      }
    }
    for (const meeting of this.database.listMeetings()) {
      if (meeting.status !== "PROCESSING") {
        continue;
      }
      const audits = this.database.listAuditRecords(500).filter((record) => record.meetingId === meeting.meetingId);
      const started = audits.some((record) => record.action === "TRANSCRIPTION_STARTED");
      const finished = audits.some((record) => record.action === "TRANSCRIPT_CREATED" || record.action === "TRANSCRIPTION_COMPLETED");
      if (started && !finished) {
        this.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
        this.database.appendAudit(this.audit("TRANSCRIPTION_RECOVERED_INCOMPLETE", meeting.meetingId, {
          reason: "APPLICATION_RESTARTED_DURING_TRANSCRIPTION",
        }));
      }
    }
  }

  private recoverInterruptedRecordings(): void {
    for (const meeting of this.database.listMeetings()) {
      if (meeting.status !== "RECORDING") {
        continue;
      }
      this.interruptedRecordingMeetingIds.add(meeting.meetingId);
      this.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
      this.database.appendAudit(this.audit("RECORDING_RECOVERED_INCOMPLETE", meeting.meetingId, {
        reason: "APPLICATION_RESTARTED_DURING_RECORDING",
      }));
    }
  }

  private async recoverArtifactOperations(): Promise<void> {
    for (const operation of this.database.listPendingArtifactOperations()) {
      let verification: Awaited<ReturnType<LocalStorageService["inspectFile"]>>;
      try {
        verification = await this.storage.inspectFile(
          operation.relativePath,
          operation.actualSha256 ?? operation.expectedSha256,
        );
      } catch (error: unknown) {
        this.database.updateArtifactOperation(operation.operationId, {
          state: "INCOMPLETE",
          error: `The unfinished artifact operation could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const indexedArtifact = operation.fileId === undefined ? undefined : this.database.getArtifact(operation.fileId);
      if (
        indexedArtifact !== undefined &&
        indexedArtifact.meetingId === operation.meetingId &&
        indexedArtifact.relativePath === operation.relativePath &&
        verification.status === "AVAILABLE"
      ) {
        this.database.updateArtifactOperation(operation.operationId, {
          state: "COMMITTED",
          actualSha256: verification.actualSha256,
          size: verification.size,
        });
        continue;
      }

      if (indexedArtifact !== undefined && verification.status !== "AVAILABLE") {
        this.database.updateArtifactVerification(
          indexedArtifact.fileId,
          verification.status === "MISSING" ? "MISSING" : "CORRUPTED",
        );
      }
      this.database.updateArtifactOperation(operation.operationId, {
        state: "INCOMPLETE",
        error: verification.status === "AVAILABLE"
          ? "The final file exists but its SQLite artifact transaction was not committed. It remains an orphan until explicitly re-indexed."
          : `The artifact operation ended before a verified final file existed (${verification.status}).`,
      });
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "ARTIFACT_OPERATION_RECOVERED",
        meetingId: operation.meetingId,
        details: { operationId: operation.operationId, path: operation.relativePath, state: "INCOMPLETE" },
        createdAt: this.clock().toISOString(),
      });
    }
  }

  private transitionMeetingForCaptureStart(meetingId: string): void {
    const meeting = this.database.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new StorageError(`Meeting not found: ${meetingId}`);
    }
    switch (meeting.status) {
      case "SCHEDULED":
        this.database.updateMeetingStatus(meetingId, "DETECTED");
        this.database.updateMeetingStatus(meetingId, "PREPARING");
        this.database.updateMeetingStatus(meetingId, "RECORDING");
        return;
      case "DETECTED":
        this.database.updateMeetingStatus(meetingId, "PREPARING");
        this.database.updateMeetingStatus(meetingId, "RECORDING");
        return;
      case "INCOMPLETE":
      case "FAILED":
        this.database.updateMeetingStatus(meetingId, "PREPARING");
        this.database.updateMeetingStatus(meetingId, "RECORDING");
        return;
      case "PREPARING":
        this.database.updateMeetingStatus(meetingId, "RECORDING");
        return;
      default:
        throw new StorageError(`Cannot start capture while meeting ${meetingId} is ${meeting.status}.`);
    }
  }

  private transitionCaptureFailure(meetingId: string, failed: boolean): void {
    const meeting = this.database.getMeeting(meetingId);
    if (meeting === undefined) {
      return;
    }
    const target: MeetingStatus = failed ? "FAILED" : "INCOMPLETE";
    if (meeting.status === target || meeting.status === "CANCELLED") {
      return;
    }
    try {
      this.database.updateMeetingStatus(meetingId, target);
    } catch {
      if (!failed && meeting.status !== "FAILED") {
        this.database.updateMeetingStatus(meetingId, "FAILED");
      }
    }
  }

  private requireArtifactOperation(operationId: string): ArtifactOperation {
    const operation = this.database.getArtifactOperation(operationId);
    if (operation === undefined) {
      throw new StorageError(`Artifact operation not found: ${operationId}`);
    }
    return operation;
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
    this.recovery = new RecoveryScanner(
      this.storage,
      this.database,
      this.clock,
      this.databaseWasMissingAtOpen,
      this.interruptedRecordingMeetingIds,
    );
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

function calendarAssociationFromEvent(
  event: NormalizedCalendarEvent & { meetingPlatform: MeetingPlatform; normalizedFingerprint: string },
  meetingId: string,
  createdAt: string,
  updatedAt: string,
): CalendarEventAssociation {
  const association: CalendarEventAssociation = {
    provider: event.provider,
    externalEventId: event.externalEventId,
    meetingId,
    subject: event.subject,
    startTime: event.startTime,
    endTime: event.endTime,
    attendees: event.attendees,
    isCancelled: event.isCancelled,
    meetingPlatform: event.meetingPlatform,
    normalizedFingerprint: event.normalizedFingerprint,
    createdAt,
    updatedAt,
  };
  addOptional(association, "organizer", event.organizer);
  addOptional(association, "location", event.location);
  addOptional(association, "onlineMeeting", event.onlineMeeting);
  addOptional(association, "webUrl", event.webUrl);
  addOptional(association, "lastModifiedAt", event.lastModifiedAt);
  return association;
}

function meetingDateFromCalendarStart(startTime: string): string {
  const isoDateMatch = startTime.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch?.[1] !== undefined) {
    return isoDateMatch[1];
  }
  const parsed = new Date(startTime);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  throw new DataRootValidationError(`Invalid calendar event start time: ${startTime}`);
}

function validateTranscript(document: TranscriptDocument): void {
  if (!document.language || !document.createdAt || typeof document.timestamps !== "boolean") {
    throw new DataRootValidationError("A transcript must include language, createdAt, and a timestamp-presence flag.");
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
  validateAnalysisDocument(document);
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

function stringMetadata(value: string | number | boolean | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function numberMetadata(value: string | number | boolean | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function addOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    object[key] = value;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function mimeExtension(mimeType: string): string {
  const extension = mimeType.split("/")[1]?.split(";")[0];
  return extension && /^[a-z0-9]+$/i.test(extension) ? extension : "bin";
}
