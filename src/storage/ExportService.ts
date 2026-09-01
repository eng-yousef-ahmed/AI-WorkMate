import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExportManifest, Meeting } from "../domain/models";
import { ArchiveService, type ArchiveEntry, type CreatedArchive } from "./ArchiveService";
import type { LocalDatabase } from "./LocalDatabase";
import { DataRootValidationError, StorageError } from "./errors";
import { isPathInside, normalizeAbsolutePath } from "./LocalStorageService";
import type { LocalStorageService } from "./LocalStorageService";

export interface MeetingExportMetadata {
  meeting: Meeting;
  transcripts: ReturnType<LocalDatabase["listTranscripts"]>;
  analysis: ReturnType<LocalDatabase["listAnalysis"]>;
  decisions: ReturnType<LocalDatabase["listDecisions"]>;
  tasks: ReturnType<LocalDatabase["listTasks"]>;
}

/** Creates a portable meeting ZIP without exposing DATA_ROOT to a renderer. */
export class ExportService {
  private readonly archiveService = new ArchiveService();

  public constructor(
    private readonly storage: LocalStorageService,
    private readonly database: LocalDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async exportMeeting(meetingId: string, exportDirectory: string): Promise<CreatedArchive> {
    const meeting = this.database.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new DataRootValidationError(`Meeting not found: ${meetingId}`);
    }
    const directory = await this.validateExportDirectory(exportDirectory);
    const folderPrefix = `${meeting.folderRelativePath}/`;
    const artifacts = this.database.listArtifacts(meetingId);
    const files: string[] = [];
    const entries: ArchiveEntry[] = [];

    const manifestArtifact = artifacts.find((artifact) => artifact.relativePath === `${meeting.folderRelativePath}/Meeting.json`);
    if (manifestArtifact === undefined) {
      throw new StorageError("Meeting.json is not indexed; verify storage before exporting this meeting.");
    }
    await this.assertAvailable(manifestArtifact.relativePath, manifestArtifact.sha256);
    entries.push({ name: "Meeting.json", source: this.storage.createReadStream(manifestArtifact.relativePath) });
    files.push("Meeting.json");

    for (const artifact of artifacts) {
      if (artifact.relativePath === manifestArtifact.relativePath) {
        continue;
      }
      if (!artifact.relativePath.startsWith(folderPrefix)) {
        throw new StorageError(`Artifact ${artifact.fileId} does not belong to meeting ${meetingId}.`);
      }
      await this.assertAvailable(artifact.relativePath, artifact.sha256);
      const exportPath = artifact.relativePath.slice(folderPrefix.length);
      entries.push({ name: exportPath, source: this.storage.createReadStream(artifact.relativePath) });
      files.push(exportPath);
    }

    const metadata: MeetingExportMetadata = {
      meeting,
      transcripts: this.database.listTranscripts(meetingId),
      analysis: this.database.listAnalysis(meetingId),
      decisions: this.database.listDecisions(meetingId),
      tasks: this.database.listTasks(meetingId),
    };
    entries.push({ name: "MeetingMetadata.json", contents: `${JSON.stringify(metadata, null, 2)}\n` });
    files.push("MeetingMetadata.json");
    const exportManifest: ExportManifest = {
      format: "AI_WORKMATE_MEETING_EXPORT",
      formatVersion: 1,
      exportedAt: this.clock().toISOString(),
      meetingId,
      relationship: "Meeting -> Recording/Audio -> Transcript -> Analysis -> Decision/Task -> Project",
      files,
    };
    entries.unshift({ name: "ExportManifest.json", contents: `${JSON.stringify(exportManifest, null, 2)}\n` });

    const filename = `meeting_${meetingId}_${meeting.slug}.zip`;
    const created = await this.archiveService.createZip(join(directory, filename), entries);
    this.database.appendAudit({
      auditId: randomUUID(),
      action: "EXPORT_CREATED",
      meetingId,
      details: { path: created.path, fileCount: files.length },
      createdAt: this.clock().toISOString(),
    });
    return created;
  }

  private async assertAvailable(relativePath: string, expectedHash: string): Promise<void> {
    const verification = await this.storage.inspectFile(relativePath, expectedHash);
    if (verification.status !== "AVAILABLE") {
      throw new StorageError(`Cannot export unavailable artifact: ${relativePath} (${verification.status}).`);
    }
  }

  private async validateExportDirectory(value: string): Promise<string> {
    const directory = normalizeAbsolutePath(value);
    if (isPathInside(this.storage.dataRoot, directory) || isPathInside(directory, this.storage.dataRoot)) {
      throw new DataRootValidationError("Meeting exports must be written outside DATA_ROOT.");
    }
    await mkdir(directory, { recursive: true });
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new DataRootValidationError("The export location is not a folder.");
    }
    return directory;
  }
}
