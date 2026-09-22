import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import type {
  Artifact,
  ArtifactType,
  IntegrityIssue,
  IntegrityReport,
  Meeting,
  RecordingVariant,
} from "../domain/models";
import type { LocalDatabase } from "./LocalDatabase";
import type { LocalStorageService } from "./LocalStorageService";

export class StorageIntegrityService {
  public constructor(
    private readonly storage: LocalStorageService,
    private readonly database: LocalDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly databaseWasMissingAtOpen = false,
    private readonly interruptedRecordingMeetingIds: ReadonlySet<string> = new Set(),
  ) {}

  public async verifyStorage(): Promise<IntegrityReport> {
    const checkedAt = this.clock().toISOString();
    const issues: IntegrityIssue[] = [];
    const artifacts = this.database.listArtifacts();
    let availableArtifacts = 0;

    const unfinishedOperations = [
      ...this.database.listPendingArtifactOperations(),
      ...this.database.listIncompleteArtifactOperations(),
    ];
    for (const operation of unfinishedOperations) {
      issues.push({
        kind: "INCOMPLETE_ARTIFACT_OPERATION",
        path: operation.relativePath,
        meetingId: operation.meetingId,
        details: operation.error ?? `Artifact operation ${operation.operationId} did not reach COMMITTED state.`,
      });
    }
    for (const meetingId of this.interruptedRecordingMeetingIds) {
      const meeting = this.database.getMeeting(meetingId);
      if (meeting !== undefined) {
        issues.push({
          kind: "INCOMPLETE_RECORDING",
          path: meeting.folderRelativePath,
          meetingId,
          details: "The meeting was still marked RECORDING when the application restarted and was safely marked INCOMPLETE.",
        });
      }
    }

    for (const artifact of artifacts) {
      const meeting = this.database.getMeeting(artifact.meetingId);
      const expectedPrefix = meeting === undefined ? "" : `${meeting.folderRelativePath}/`;
      if (meeting === undefined || !artifact.relativePath.startsWith(expectedPrefix)) {
        this.database.updateArtifactVerification(artifact.fileId, "CORRUPTED");
        issues.push({
          kind: "CORRUPTED_ARTIFACT",
          path: artifact.relativePath,
          meetingId: artifact.meetingId,
          fileId: artifact.fileId,
          details: "The artifact path does not belong to the meeting recorded by SQLite.",
        });
        continue;
      }
      try {
        const verification = await this.storage.inspectFile(artifact.relativePath, artifact.sha256);
        if (verification.status === "AVAILABLE") {
          availableArtifacts += 1;
          this.database.updateArtifactVerification(
            artifact.fileId,
            "AVAILABLE",
            verification.size,
            verification.modifiedAt,
            verification.actualSha256,
          );
        } else if (verification.status === "MISSING") {
          this.database.updateArtifactVerification(artifact.fileId, "MISSING");
          issues.push({
            kind: "MISSING_ARTIFACT",
            path: artifact.relativePath,
            meetingId: artifact.meetingId,
            fileId: artifact.fileId,
            details: "The database references a file that is no longer present in DATA_ROOT.",
          });
        } else {
          this.database.updateArtifactVerification(artifact.fileId, "CORRUPTED");
          issues.push({
            kind: "CORRUPTED_ARTIFACT",
            path: artifact.relativePath,
            meetingId: artifact.meetingId,
            fileId: artifact.fileId,
            details: "The file exists, but its SHA-256 hash differs from the indexed hash.",
          });
        }
      } catch (error: unknown) {
        this.database.updateArtifactVerification(artifact.fileId, "CORRUPTED");
        issues.push({
          kind: "CORRUPTED_ARTIFACT",
          path: artifact.relativePath,
          meetingId: artifact.meetingId,
          fileId: artifact.fileId,
          details: `The indexed artifact path is invalid or could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const files = await this.storage.listFiles();
    const indexedPaths = new Set(artifacts.map((artifact) => artifact.relativePath));
    const meetingsByFolder = new Map(this.database.listMeetings().map((meeting) => [meeting.folderRelativePath, meeting]));
    const discoveredFolders = new Set(await this.storage.listMeetingFolderPaths());
    let databasePresent = false;

    for (const file of files) {
      if (file.relativePath.toLowerCase() === "database/ai-workmate.sqlite") {
        databasePresent = true;
      }
      if (file.relativePath.includes(".tmp-")) {
        if (file.relativePath.toLowerCase().includes("/recording/")) {
          issues.push({
            kind: "INCOMPLETE_RECORDING",
            path: file.relativePath,
            details: "A temporary recording file was left after an interrupted write.",
          });
        }
        issues.push({
          kind: "INCOMPLETE_ARTIFACT_OPERATION",
          path: file.relativePath,
          details: "A temporary artifact file was left after an interrupted write.",
        });
        continue;
      }
      const folder = getMeetingFolderFromPath(file.relativePath);
      if (folder === undefined) {
        continue;
      }
      discoveredFolders.add(folder.relativePath);
      if (file.relativePath !== `${folder.relativePath}/Meeting.json` && !indexedPaths.has(file.relativePath)) {
        const meeting = meetingsByFolder.get(folder.relativePath);
        issues.push({
          kind: "ORPHANED_FILE",
          path: file.relativePath,
          ...(meeting === undefined ? {} : { meetingId: meeting.meetingId }),
          details:
            meeting === undefined
              ? "A file was found in a meeting-shaped folder that is not indexed."
              : "A file exists in an indexed meeting folder but has no artifact row.",
        });
      }
    }

    for (const folderPath of discoveredFolders) {
      const meeting = meetingsByFolder.get(folderPath);
      const manifestPath = `${folderPath}/Meeting.json`;
      if (meeting === undefined) {
        const manifest = await this.tryReadManifest(manifestPath);
        issues.push({
          kind: "UNKNOWN_MEETING_FOLDER",
          path: folderPath,
          ...(manifest?.meetingId === undefined ? {} : { meetingId: manifest.meetingId }),
          details: "The folder contains meeting data but no matching meeting row.",
        });
      } else {
        const manifest = await this.tryReadManifest(manifestPath);
        if (manifest === undefined || manifest.meetingId !== meeting.meetingId) {
          issues.push({
            kind: manifest === undefined ? "INVALID_MANIFEST" : "INVALID_MANIFEST",
            path: manifestPath,
            meetingId: meeting.meetingId,
            details: "Meeting.json is missing, unreadable, or does not match the indexed meeting ID.",
          });
        }
      }
    }

    if (!databasePresent || this.databaseWasMissingAtOpen) {
      issues.push({
        kind: "MISSING_DATABASE",
        path: "Database/ai-workmate.sqlite",
        details: this.databaseWasMissingAtOpen
          ? "The SQLite database was missing when the workspace opened; a recovery database was created so the app could report the issue."
          : "The local SQLite database file is missing from DATA_ROOT.",
      });
    }

    this.database.setMetadata("lastIntegrityCheckAt", checkedAt);
    this.database.appendAudit({
      auditId: randomUUID(),
      action: "STORAGE_INTEGRITY_VERIFIED",
      details: { issueCount: issues.length, checkedArtifacts: artifacts.length },
      createdAt: checkedAt,
    });

    return {
      checkedAt,
      issues,
      checkedArtifacts: artifacts.length,
      availableArtifacts,
      repairedArtifacts: 0,
    };
  }

  /**
   * Re-indexes only orphaned files inside a folder that already has an indexed
   * meeting. Unknown folders are reported, never imported or deleted.
   */
  public async repairIndex(): Promise<IntegrityReport> {
    const initial = await this.verifyStorage();
    let repairedArtifacts = 0;
    const meetingsByFolder = new Map(this.database.listMeetings().map((meeting) => [meeting.folderRelativePath, meeting]));
    for (const issue of initial.issues) {
      if (issue.kind !== "ORPHANED_FILE" || issue.meetingId === undefined) {
        continue;
      }
      if (this.database.getArtifactByPath(issue.path) !== undefined) {
        continue;
      }
      const meeting = [...meetingsByFolder.values()].find((candidate) => candidate.meetingId === issue.meetingId);
      const inferred = inferArtifact(issue.path, meeting);
      if (inferred === undefined) {
        continue;
      }
      const verification = await this.storage.inspectFile(issue.path);
      if (verification.status !== "AVAILABLE" || verification.sha256 === undefined || verification.modifiedAt === undefined) {
        continue;
      }
      const artifact: Artifact = {
        fileId: randomUUID(),
        meetingId: issue.meetingId,
        relativePath: issue.path,
        artifactType: inferred.artifactType,
        mimeType: inferred.mimeType,
        size: verification.size,
        createdAt: verification.modifiedAt,
        modifiedAt: verification.modifiedAt,
        sha256: verification.sha256,
        status: "AVAILABLE",
      };
      if (inferred.recordingVariant !== undefined) {
        artifact.recordingVariant = inferred.recordingVariant;
      }
      this.database.registerArtifact(artifact);
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "FILE_REINDEXED",
        meetingId: issue.meetingId,
        artifactId: artifact.fileId,
        details: { relativePath: issue.path },
        createdAt: this.clock().toISOString(),
      });
      repairedArtifacts += 1;
    }

    const finalReport = await this.verifyStorage();
    return { ...finalReport, repairedArtifacts };
  }

  private async tryReadManifest(path: string): Promise<Partial<Meeting> | undefined> {
    try {
      return await this.storage.readJson<Partial<Meeting>>(path);
    } catch {
      return undefined;
    }
  }
}

interface MeetingFolderPath {
  relativePath: string;
}

function getMeetingFolderFromPath(relativePath: string): MeetingFolderPath | undefined {
  const match = relativePath.match(/^(Meetings\/\d{4}\/\d{2}\/[^/]+)(?:\/|$)/);
  return match?.[1] === undefined ? undefined : { relativePath: match[1] };
}

function inferArtifact(
  relativePath: string,
  meeting: Meeting | undefined,
): { artifactType: ArtifactType; mimeType: string; recordingVariant?: RecordingVariant } | undefined {
  if (meeting === undefined) {
    return undefined;
  }
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith("/meeting.json")) {
    return { artifactType: "MEETING_MANIFEST", mimeType: "application/json" };
  }
  if (normalized.includes("/recording/original/")) {
    return {
      artifactType: "RECORDING_ORIGINAL",
      mimeType: mimeTypeFromExtension(extname(relativePath)),
      recordingVariant: "ORIGINAL",
    };
  }
  if (normalized.includes("/recording/normalized/")) {
    return {
      artifactType: "RECORDING_NORMALIZED",
      mimeType: mimeTypeFromExtension(extname(relativePath)),
      recordingVariant: "NORMALIZED",
    };
  }
  if (normalized.includes("/audio/")) {
    return { artifactType: "AUDIO", mimeType: mimeTypeFromExtension(extname(relativePath)) };
  }
  if (normalized.includes("/transcript/") && normalized.endsWith(".json")) {
    return { artifactType: "TRANSCRIPT_JSON", mimeType: "application/json" };
  }
  if (normalized.includes("/transcript/") && normalized.endsWith(".txt")) {
    return { artifactType: "TRANSCRIPT_TEXT", mimeType: "text/plain" };
  }
  if (normalized.includes("/transcript/") && normalized.endsWith(".vtt")) {
    return { artifactType: "TRANSCRIPT_VTT", mimeType: "text/vtt" };
  }
  if (normalized.includes("/transcript/") && normalized.endsWith(".srt")) {
    return { artifactType: "TRANSCRIPT_SRT", mimeType: "application/x-subrip" };
  }
  if (normalized.includes("/analysis/")) {
    const artifactType = analysisTypeFromPath(normalized);
    if (artifactType !== undefined) {
      return { artifactType, mimeType: normalized.endsWith(".md") ? "text/markdown" : "application/json" };
    }
  }
  if (normalized.includes("/attachments/")) {
    return { artifactType: "ATTACHMENT", mimeType: mimeTypeFromExtension(extname(relativePath)) };
  }
  if (normalized.includes("/exports/")) {
    return { artifactType: "DOCUMENT", mimeType: mimeTypeFromExtension(extname(relativePath)) };
  }
  return undefined;
}

function analysisTypeFromPath(path: string): ArtifactType | undefined {
  if (path.endsWith("/summary.json")) return "ANALYSIS_SUMMARY_JSON";
  if (path.endsWith("/summary.md")) return "ANALYSIS_SUMMARY_MARKDOWN";
  if (path.endsWith("/decisions.json")) return "ANALYSIS_DECISIONS";
  if (path.endsWith("/tasks.json")) return "ANALYSIS_TASKS";
  if (path.endsWith("/risks.json")) return "ANALYSIS_RISKS";
  if (path.endsWith("/questions.json")) return "ANALYSIS_QUESTIONS";
  if (path.endsWith("/followups.json")) return "ANALYSIS_FOLLOWUPS";
  return undefined;
}

function mimeTypeFromExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".flac":
      return "audio/flac";
    case ".wav":
      return "audio/wav";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".vtt":
      return "text/vtt";
    case ".srt":
      return "application/x-subrip";
    default:
      return "application/octet-stream";
  }
}
