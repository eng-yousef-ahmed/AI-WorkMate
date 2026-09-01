import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  lstat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import type {
  ArtifactType,
  DataRootValidation,
  Meeting,
  MeetingFolder,
  MigrationPlan,
  MigrationResult,
  RecordingVariant,
  StorageManifest,
  StorageStats,
  StoredArtifact,
} from "../domain/models";
import { STORAGE_VERSION } from "../domain/models";
import {
  DataRootValidationError,
  InsufficientDiskSpaceError,
  MigrationVerificationError,
  UnsafePathError,
} from "./errors";
import type { StorageLayoutMigrator } from "./StorageMigrator";

export const STORAGE_DIRECTORIES = [
  "Meetings",
  "Database",
  "Backups",
  "Exports",
] as const;

const MEETING_DIRECTORIES = [
  "Recording",
  "Audio",
  "Transcript",
  "Analysis",
  "Attachments",
  "Exports",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARTIFACT_EXTENSION_LENGTH = 12;
const DEFAULT_SPACE_SAFETY_MARGIN = 512 * 1024 * 1024;

export interface LocalStorageServiceOptions {
  clock?: () => Date;
  spaceSafetyMarginBytes?: number;
  layoutMigrator?: StorageLayoutMigrator;
  installationDirectory?: string;
  availableBytesProvider?: () => Promise<number | null>;
}

export interface ArtifactWriteRequest {
  meeting: Meeting;
  artifactType: ArtifactType;
  mimeType: string;
  extension: string;
  contents?: Uint8Array | string;
  sourcePath?: string;
  recordingVariant?: RecordingVariant;
  expectedSha256?: string;
  relativePath?: string;
}

export interface FileVerification {
  exists: boolean;
  status: "AVAILABLE" | "MISSING" | "CORRUPTED";
  size: number;
  sha256?: string;
  actualSha256?: string;
  modifiedAt?: string;
}

export interface StorageTreeEntry {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
}

export type StorageMigrationPhase = "COPYING" | "VERIFIED" | "ACTIVATING" | "ACTIVATED" | "RUNTIME_SWITCHED";
export type StorageMigrationPhaseHandler = (phase: StorageMigrationPhase) => Promise<void>;

/**
 * The only service that is allowed to perform data-root filesystem operations.
 * Database code stores relative paths and never reaches into this service's
 * root directly. This makes the local boundary auditable and keeps the
 * renderer away from arbitrary filesystem access.
 */
export class LocalStorageService {
  public readonly dataRoot: string;
  public readonly spaceSafetyMarginBytes: number;
  private readonly clock: () => Date;
  private readonly layoutMigrator: StorageLayoutMigrator | undefined;
  private readonly installationDirectory: string | undefined;
  private readonly availableBytesProvider: () => Promise<number | null>;

  public constructor(dataRoot: string, options: LocalStorageServiceOptions = {}) {
    this.dataRoot = normalizeAbsolutePath(dataRoot);
    this.installationDirectory = options.installationDirectory === undefined
      ? undefined
      : normalizeAbsolutePath(options.installationDirectory);
    const protectionError = getDataRootProtectionError(this.dataRoot, this.installationDirectory);
    if (protectionError !== undefined) {
      throw new DataRootValidationError(protectionError);
    }
    this.clock = options.clock ?? (() => new Date());
    this.spaceSafetyMarginBytes = options.spaceSafetyMarginBytes ?? DEFAULT_SPACE_SAFETY_MARGIN;
    this.layoutMigrator = options.layoutMigrator;
    this.availableBytesProvider = options.availableBytesProvider ?? (() => getAvailableBytes(this.dataRoot));
  }

  public get databasePath(): string {
    return join(this.dataRoot, "Database", "ai-workmate.sqlite");
  }

  public get installationDirectoryPath(): string | undefined {
    return this.installationDirectory;
  }

  public get manifestRelativePath(): string {
    return "storage.json";
  }

  public get manifestPath(): string {
    return this.absolutePathFor(this.manifestRelativePath);
  }

  public async initialize(): Promise<StorageManifest> {
    await mkdir(this.dataRoot, { recursive: true });
    for (const directory of STORAGE_DIRECTORIES) {
      await mkdir(join(this.dataRoot, directory), { recursive: true });
    }

    const existing = await this.tryReadManifest();
    if (existing !== undefined) {
      if (existing.storageVersion > STORAGE_VERSION) {
        throw new DataRootValidationError(
          `Data root uses storage version ${existing.storageVersion}, but this application supports ${STORAGE_VERSION}.`,
        );
      }
      if (existing.storageVersion < STORAGE_VERSION) {
        // The storage migrator is deliberately explicit. Never silently change
        // a user's folder layout during startup.
        if (this.layoutMigrator === undefined) {
          throw new DataRootValidationError(
            `Data root uses storage version ${existing.storageVersion}; run an explicit storage migration before opening it.`,
          );
        }
        return this.layoutMigrator.migrate(this, existing);
      }
      return existing;
    }

    const now = this.clock().toISOString();
    const manifest: StorageManifest = {
      storageVersion: STORAGE_VERSION,
      createdAt: now,
      updatedAt: now,
      dataRootLabel: this.dataRoot,
    };
    await this.atomicWriteJson(this.manifestRelativePath, manifest);
    return manifest;
  }

  public async updateManifest(patch: Partial<StorageManifest>): Promise<StorageManifest> {
    const current = (await this.tryReadManifest()) ?? {
      storageVersion: STORAGE_VERSION,
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
      dataRootLabel: this.dataRoot,
    };
    const next: StorageManifest = {
      ...current,
      ...patch,
      storageVersion: STORAGE_VERSION,
      updatedAt: this.clock().toISOString(),
    };
    await this.atomicWriteJson(this.manifestRelativePath, next, true);
    return next;
  }

  public async createMeetingFolder(meeting: Meeting): Promise<MeetingFolder> {
    assertUuid(meeting.meetingId);
    const expectedFolderName = buildMeetingFolderName(meeting.meetingDate, meeting.title, meeting.meetingId);
    if (meeting.folderName !== expectedFolderName) {
      throw new UnsafePathError(`meeting folder does not match its meeting ID: ${meeting.folderName}`);
    }

    const relativePath = this.meetingFolderRelativePath(meeting);
    const absolutePath = this.absolutePathFor(relativePath);
    if (await pathExists(absolutePath)) {
      throw new DataRootValidationError(`Meeting folder already exists: ${relativePath}`);
    }

    await mkdir(absolutePath, { recursive: true });
    for (const directory of MEETING_DIRECTORIES) {
      await mkdir(join(absolutePath, directory), { recursive: true });
    }
    await mkdir(join(absolutePath, "Recording", "Original"), { recursive: true });
    await mkdir(join(absolutePath, "Recording", "Normalized"), { recursive: true });
    await this.atomicWriteJson(join(relativePath, "Meeting.json"), meeting);

    return { meeting, absolutePath, relativePath };
  }

  public meetingFolderRelativePath(meeting: Pick<Meeting, "folderName" | "meetingDate">): string {
    const year = meeting.meetingDate.slice(0, 4);
    const month = meeting.meetingDate.slice(5, 7);
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) {
      throw new DataRootValidationError(`Invalid meeting date: ${meeting.meetingDate}`);
    }
    return join("Meetings", year, month, meeting.folderName).replaceAll("\\", "/");
  }

  public buildArtifactRelativePath(
    meeting: Pick<Meeting, "meetingId" | "folderName" | "meetingDate">,
    artifactType: ArtifactType,
    extension: string,
  ): string {
    assertUuid(meeting.meetingId);
    const normalizedExtension = normalizeExtension(extension);
    const folder = this.meetingFolderRelativePath(meeting);
    const id = meeting.meetingId;

    switch (artifactType) {
      case "MEETING_MANIFEST":
        return `${folder}/Meeting.json`;
      case "RECORDING_ORIGINAL":
        return `${folder}/Recording/Original/meeting_${id}.${normalizedExtension}`;
      case "RECORDING_NORMALIZED":
        return `${folder}/Recording/Normalized/meeting_${id}.${normalizedExtension}`;
      case "AUDIO":
        return `${folder}/Audio/audio_${id}.${normalizedExtension}`;
      case "TRANSCRIPT_JSON":
        return `${folder}/Transcript/transcript_${id}.json`;
      case "TRANSCRIPT_TEXT":
        return `${folder}/Transcript/transcript_${id}.txt`;
      case "TRANSCRIPT_VTT":
        return `${folder}/Transcript/transcript_${id}.vtt`;
      case "TRANSCRIPT_SRT":
        return `${folder}/Transcript/transcript_${id}.srt`;
      case "ANALYSIS_SUMMARY_JSON":
        return `${folder}/Analysis/summary.json`;
      case "ANALYSIS_SUMMARY_MARKDOWN":
        return `${folder}/Analysis/summary.md`;
      case "ANALYSIS_DECISIONS":
        return `${folder}/Analysis/decisions.json`;
      case "ANALYSIS_TASKS":
        return `${folder}/Analysis/tasks.json`;
      case "ANALYSIS_RISKS":
        return `${folder}/Analysis/risks.json`;
      case "ANALYSIS_QUESTIONS":
        return `${folder}/Analysis/questions.json`;
      case "ANALYSIS_FOLLOWUPS":
        return `${folder}/Analysis/followups.json`;
      case "ATTACHMENT":
        return `${folder}/Attachments/attachment_${id}.${normalizedExtension}`;
      case "DOCUMENT":
        return `${folder}/Exports/document_${id}.${normalizedExtension}`;
      case "EXPORT":
        return `${folder}/Exports/export_${id}.${normalizedExtension}`;
      default:
        return assertNever(artifactType);
    }
  }

  public async writeArtifact(request: ArtifactWriteRequest): Promise<StoredArtifact> {
    const relativePath = request.relativePath
      ? this.assertRelativePath(request.relativePath)
      : this.buildArtifactRelativePath(
          request.meeting,
          request.artifactType,
          request.extension,
        );
    const absolutePath = this.absolutePathFor(relativePath);

    if (request.contents !== undefined && request.sourcePath !== undefined) {
      throw new DataRootValidationError("An artifact must provide contents or sourcePath, not both.");
    }
    if (request.contents === undefined && request.sourcePath === undefined) {
      throw new DataRootValidationError("An artifact requires contents or sourcePath.");
    }

    if (request.contents !== undefined) {
      await this.atomicWrite(relativePath, request.contents);
    } else {
      const sourcePath = request.sourcePath as string;
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) {
        throw new DataRootValidationError(`Artifact source is not a file: ${sourcePath}`);
      }
      await this.atomicCopy(sourcePath, relativePath);
    }

    const verification = await this.inspectFile(relativePath, request.expectedSha256);
    if (
      !verification.exists ||
      verification.status !== "AVAILABLE" ||
      verification.sha256 === undefined ||
      verification.modifiedAt === undefined
    ) {
      throw new MigrationVerificationError(`Artifact could not be verified after writing: ${relativePath}`);
    }
    const now = this.clock().toISOString();
    const artifact: StoredArtifact = {
      fileId: randomUUID(),
      meetingId: request.meeting.meetingId,
      relativePath,
      artifactType: request.artifactType,
      mimeType: request.mimeType,
      size: verification.size,
      createdAt: now,
      modifiedAt: verification.modifiedAt,
      sha256: verification.sha256,
      status: "AVAILABLE",
      absolutePath,
    };
    if (request.recordingVariant !== undefined) {
      artifact.recordingVariant = request.recordingVariant;
    }
    return artifact;
  }

  public async inspectFile(relativePath: string, expectedSha256?: string): Promise<FileVerification> {
    const safePath = this.assertRelativePath(relativePath);
    const absolutePath = this.absolutePathFor(safePath);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return { exists: false, status: "MISSING", size: 0 };
      }
      const actualSha256 = await this.hashFile(absolutePath);
      const expected = expectedSha256?.toLowerCase();
      const isValid = expected === undefined || actualSha256 === expected;
      return {
        exists: true,
        status: isValid ? "AVAILABLE" : "CORRUPTED",
        size: fileStat.size,
        sha256: actualSha256,
        actualSha256,
        modifiedAt: fileStat.mtime.toISOString(),
      };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { exists: false, status: "MISSING", size: 0 };
      }
      throw error;
    }
  }

  public async inspectSourceFile(sourcePath: string): Promise<{ size: number; sha256: string }> {
    const source = resolve(sourcePath);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) {
      throw new DataRootValidationError(`Artifact source is not a file: ${sourcePath}`);
    }
    return { size: sourceStat.size, sha256: await this.hashFile(source) };
  }

  public async hashFile(absolutePath: string): Promise<string> {
    const hash = createHash("sha256");
    const input = createReadStream(absolutePath);
    for await (const chunk of input) {
      hash.update(chunk as Uint8Array);
    }
    return hash.digest("hex");
  }

  public hashBytes(contents: Uint8Array | string): string {
    return createHash("sha256").update(contents).digest("hex");
  }

  public createReadStream(relativePath: string): Readable {
    return createReadStream(this.absolutePathFor(relativePath));
  }

  public async writeFileAtomic(relativePath: string, contents: Uint8Array | string): Promise<void> {
    await this.atomicWrite(relativePath, contents);
  }

  public async writeStreamAtomic(relativePath: string, source: Readable): Promise<void> {
    const safePath = this.assertRelativePath(relativePath);
    const destination = this.absolutePathFor(safePath);
    await mkdir(dirname(destination), { recursive: true });
    if (await pathExists(destination)) {
      throw new DataRootValidationError(`Refusing to overwrite an existing artifact: ${safePath}`);
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await pipeline(source, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      await syncDirectory(dirname(destination));
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async exists(relativePath: string): Promise<boolean> {
    return pathExists(this.absolutePathFor(relativePath));
  }

  public async readFile(relativePath: string): Promise<Buffer> {
    return readFile(this.absolutePathFor(relativePath));
  }

  public async readJson<T>(relativePath: string): Promise<T> {
    const contents = await this.readFile(relativePath);
    return JSON.parse(contents.toString("utf8")) as T;
  }

  public absolutePathFor(relativePath: string): string {
    const safePath = this.assertRelativePath(relativePath);
    return resolve(this.dataRoot, ...safePath.split("/"));
  }

  public assertRelativePath(relativePath: string): string {
    if (!relativePath || relativePath.includes("\0")) {
      throw new UnsafePathError(relativePath);
    }
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
      throw new UnsafePathError(relativePath);
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
      throw new UnsafePathError(relativePath);
    }
    const candidate = resolve(this.dataRoot, ...segments);
    if (!isPathInside(this.dataRoot, candidate)) {
      throw new UnsafePathError(relativePath);
    }
    return segments.join("/");
  }

  public async listMeetingFolderPaths(): Promise<string[]> {
    const meetingsRoot = this.absolutePathFor("Meetings");
    const folders: string[] = [];
    let years;
    try {
      years = await readdir(meetingsRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) return folders;
      throw error;
    }
    for (const year of years) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
      const yearPath = join(meetingsRoot, year.name);
      const months = await readdir(yearPath, { withFileTypes: true });
      for (const month of months) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
        const monthPath = join(yearPath, month.name);
        const meetingDirectories = await readdir(monthPath, { withFileTypes: true });
        for (const folder of meetingDirectories) {
          if (folder.isDirectory() && !folder.isSymbolicLink()) {
            folders.push(`Meetings/${year.name}/${month.name}/${folder.name}`);
          }
        }
      }
    }
    return folders.sort();
  }

  public async listFiles(prefix = ""): Promise<StorageTreeEntry[]> {
    const safePrefix = prefix ? this.assertRelativePath(prefix) : "";
    const start = safePrefix ? this.absolutePathFor(safePrefix) : this.dataRoot;
    const entries: StorageTreeEntry[] = [];
    await this.walkFiles(start, safePrefix, entries);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  public async listMeetingFiles(meeting: Pick<Meeting, "folderName" | "meetingDate">): Promise<StorageTreeEntry[]> {
    return this.listFiles(this.meetingFolderRelativePath(meeting));
  }

  public async removeRelativePath(relativePath: string): Promise<void> {
    const safePath = this.assertRelativePath(relativePath);
    await rm(this.absolutePathFor(safePath), { recursive: true, force: false });
    await syncDirectory(dirname(this.absolutePathFor(safePath)));
  }

  public async getAvailableBytes(): Promise<number | null> {
    return this.availableBytesProvider();
  }

  public async checkDiskSpace(requiredBytes: number): Promise<void> {
    if (!Number.isFinite(requiredBytes) || requiredBytes < 0) {
      throw new DataRootValidationError("requiredBytes must be a non-negative finite number.");
    }
    const requiredWithMargin = requiredBytes + this.spaceSafetyMarginBytes;
    const availableBytes = await this.getAvailableBytes();
    if (availableBytes === null || availableBytes < requiredWithMargin) {
      throw new InsufficientDiskSpaceError(availableBytes, requiredWithMargin);
    }
  }

  public async getStorageStats(meetingCount = 0): Promise<StorageStats> {
    const files = await this.listFiles();
    const stats: StorageStats = {
      totalBytes: 0,
      recordingsBytes: 0,
      audioBytes: 0,
      transcriptsBytes: 0,
      documentsBytes: 0,
      databaseBytes: 0,
      availableBytes: await this.getAvailableBytes(),
      fileCount: files.length,
      meetingCount,
    };
    for (const file of files) {
      stats.totalBytes += file.size;
      const path = file.relativePath.toLowerCase();
      if (path.startsWith("meetings/") && path.includes("/recording/")) {
        stats.recordingsBytes += file.size;
      } else if (path.startsWith("meetings/") && path.includes("/audio/")) {
        stats.audioBytes += file.size;
      } else if (path.startsWith("meetings/") && path.includes("/transcript/")) {
        stats.transcriptsBytes += file.size;
      } else if (path.startsWith("database/")) {
        stats.databaseBytes += file.size;
      } else if (
        path.startsWith("exports/") ||
        (path.startsWith("meetings/") &&
          (path.includes("/analysis/") || path.includes("/attachments/") || path.includes("/exports/")))
      ) {
        stats.documentsBytes += file.size;
      }
    }
    return stats;
  }

  public async validateDataRoot(destination: string, requiredBytes = 0): Promise<DataRootValidation> {
    const errors: string[] = [];
    let normalized: string;
    try {
      normalized = normalizeAbsolutePath(destination);
    } catch (error: unknown) {
      return {
        path: destination,
        valid: false,
        exists: false,
        isDirectory: false,
        writable: false,
        availableBytes: null,
        requiredBytes,
        errors: [error instanceof Error ? error.message : "Invalid data location."],
      };
    }

    let exists = false;
    let isDirectory = false;
    let writable = false;
    let probePath = normalized;
    try {
      const destinationStat = await stat(normalized);
      exists = true;
      isDirectory = destinationStat.isDirectory();
      if (!isDirectory) {
        errors.push("The selected data location is not a folder.");
      }
      if (isDirectory) {
        try {
          await access(normalized, fsConstants.W_OK);
          writable = true;
        } catch {
          errors.push("The selected data location is not writable.");
        }
      }
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        errors.push(error instanceof Error ? error.message : "The data location could not be inspected.");
      } else {
        // For a new location, validate the nearest existing parent and leave
        // the actual creation to initialize/migration.
        probePath = await nearestExistingParent(normalized);
        try {
          await access(probePath, fsConstants.W_OK);
          writable = true;
        } catch {
          errors.push("The parent of the selected data location is not writable.");
        }
      }
    }

    const availableBytes = await getAvailableBytes(probePath);
    if (availableBytes === null && requiredBytes > 0) {
      errors.push("Available disk space could not be determined safely.");
    } else if (availableBytes !== null && availableBytes < requiredBytes) {
      errors.push(
        `Insufficient disk space: ${availableBytes.toLocaleString("en-US")} bytes available, ${requiredBytes.toLocaleString("en-US")} required.`,
      );
    }
    const protectionError = getDataRootProtectionError(normalized, this.installationDirectory);
    if (protectionError !== undefined) {
      errors.push(protectionError);
    }
    return {
      path: normalized,
      valid: errors.length === 0 && (!exists || isDirectory) && writable,
      exists,
      isDirectory,
      writable,
      availableBytes,
      requiredBytes,
      errors,
    };
  }

  public async createMigrationPlan(destination: string): Promise<MigrationPlan> {
    const destinationPath = normalizeAbsolutePath(destination);
    if (samePath(this.dataRoot, destinationPath)) {
      throw new DataRootValidationError("The new data location must be different from the current location.");
    }
    if (isPathInside(this.dataRoot, destinationPath) || isPathInside(destinationPath, this.dataRoot)) {
      throw new DataRootValidationError("The current and new data locations cannot contain one another.");
    }

    const sourceFiles = await this.listFiles();
    const bytesToMove = sourceFiles.reduce((total, file) => total + file.size, 0);
    const requiredBytes = bytesToMove + this.spaceSafetyMarginBytes;
    const validation = await this.validateDataRoot(destinationPath, requiredBytes);
    if (!validation.valid) {
      throw new DataRootValidationError(validation.errors.join(" "));
    }
    if (validation.exists) {
      const destinationFiles = await listFilesAt(destinationPath);
      if (destinationFiles.length > 0) {
        throw new DataRootValidationError("The destination must be empty before existing data is migrated.");
      }
    }

    const meetingFolders = new Set(
      sourceFiles
        .map((file) => file.relativePath.match(/^Meetings\/\d{4}\/\d{2}\/([^/]+)/)?.[1])
        .filter((folder): folder is string => folder !== undefined),
    );
    return {
      source: this.dataRoot,
      destination: destinationPath,
      bytesToMove,
      filesToMove: sourceFiles.length,
      meetingCount: meetingFolders.size,
      destinationAvailableBytes: validation.availableBytes,
      requiredBytes,
      explanation: [
        "The database, meetings, recordings, transcripts, analysis, attachments, and exports will be copied.",
        "The current data location will remain untouched until the copy and verification finish.",
        "The application will switch locations only after every copied file has been verified.",
      ],
    };
  }

  public async migrateTo(
    destination: string,
    onPhase?: StorageMigrationPhaseHandler,
  ): Promise<MigrationResult> {
    const plan = await this.createMigrationPlan(destination);
    const parent = dirname(plan.destination);
    const staging = join(parent, `.ai-workmate-migration-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      await onPhase?.("COPYING");
      const sourceFiles = await this.listFiles();
      for (const file of sourceFiles) {
        const relativePath = file.relativePath;
        await this.copyRelativeToRoot(relativePath, staging);
      }
      const destinationFiles = await listFilesAt(staging);
      await verifyFileSets(this.dataRoot, staging, sourceFiles, destinationFiles);
      await onPhase?.("VERIFIED");

      // Never overwrite a non-empty destination. An existing empty folder is
      // moved aside rather than deleted so an interrupted migration is recoverable.
      await onPhase?.("ACTIVATING");
      if (await pathExists(plan.destination)) {
        const preservedEmptyDestination = `${plan.destination}.previous-${randomUUID()}`;
        await rename(plan.destination, preservedEmptyDestination);
      }
      await rename(staging, plan.destination);
      await syncDirectory(parent);
      const migratedStorage = new LocalStorageService(plan.destination, {
        clock: this.clock,
        spaceSafetyMarginBytes: this.spaceSafetyMarginBytes,
        installationDirectory: this.installationDirectory,
      });
      await migratedStorage.updateManifest({ dataRootLabel: plan.destination });
      await onPhase?.("ACTIVATED");
      return {
        plan,
        verified: true,
        sourcePreserved: await pathExists(this.dataRoot),
        destination: plan.destination,
        copiedFiles: destinationFiles.length,
      };
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true });
      if (error instanceof MigrationVerificationError) {
        throw error;
      }
      throw new MigrationVerificationError(
        `Data migration was not completed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async copyRelativeToRoot(relativePath: string, destinationRoot: string): Promise<void> {
    const source = this.absolutePathFor(relativePath);
    const destination = resolve(destinationRoot, ...relativePath.split("/"));
    if (!isPathInside(destinationRoot, destination)) {
      throw new UnsafePathError(relativePath);
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  private async walkFiles(directory: string, prefix: string, output: StorageTreeEntry[]): Promise<void> {
    let directoryEntries;
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of directoryEntries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Do not follow links from a user-controlled data root. They could
        // otherwise make a scan read arbitrary files outside DATA_ROOT.
        continue;
      }
      if (entry.isDirectory()) {
        await this.walkFiles(absolutePath, relativePath, output);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        output.push({
          relativePath,
          absolutePath,
          size: fileStat.size,
          modifiedAt: fileStat.mtime.toISOString(),
        });
      }
    }
  }

  private async atomicWrite(relativePath: string, contents: Uint8Array | string, replaceExisting = false): Promise<void> {
    const safePath = this.assertRelativePath(relativePath);
    const destination = this.absolutePathFor(safePath);
    await mkdir(dirname(destination), { recursive: true });
    if (!replaceExisting && (await pathExists(destination))) {
      throw new DataRootValidationError(`Refusing to overwrite an existing artifact: ${safePath}`);
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const temporaryVerification = await this.inspectAbsoluteFile(temporary);
      if (!temporaryVerification.exists) {
        throw new MigrationVerificationError(`Temporary file disappeared before rename: ${safePath}`);
      }
      try {
        await rename(temporary, destination);
      } catch (error: unknown) {
        if (!replaceExisting || !isReplaceRenameError(error)) {
          throw error;
        }
        // Windows does not replace an existing file with rename on every
        // filesystem. Manifest updates are small metadata writes; large
        // artifacts always use the strictly non-overwriting branch above.
        await rm(destination, { force: false });
        await rename(temporary, destination);
      }
      await syncDirectory(dirname(destination));
    } catch (error: unknown) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async atomicCopy(sourcePath: string, relativePath: string): Promise<void> {
    const source = resolve(sourcePath);
    const destination = this.absolutePathFor(relativePath);
    await mkdir(dirname(destination), { recursive: true });
    if (await pathExists(destination)) {
      throw new DataRootValidationError(`Refusing to overwrite an existing artifact: ${relativePath}`);
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await pipeline(createReadStream(source), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const handle = await open(temporary, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      await syncDirectory(dirname(destination));
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async atomicWriteJson(relativePath: string, value: unknown, replaceExisting = false): Promise<void> {
    await this.atomicWrite(relativePath, `${JSON.stringify(value, null, 2)}\n`, replaceExisting);
  }

  private async inspectAbsoluteFile(absolutePath: string): Promise<FileVerification> {
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        return { exists: false, status: "MISSING", size: 0 };
      }
      return {
        exists: true,
        status: "AVAILABLE",
        size: fileStat.size,
        actualSha256: await this.hashFile(absolutePath),
        modifiedAt: fileStat.mtime.toISOString(),
      };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { exists: false, status: "MISSING", size: 0 };
      }
      throw error;
    }
  }

  private async tryReadManifest(): Promise<StorageManifest | undefined> {
    try {
      const manifest = await this.readJson<StorageManifest>(this.manifestRelativePath);
      if (typeof manifest.storageVersion !== "number" || typeof manifest.dataRootLabel !== "string") {
        throw new DataRootValidationError("storage.json is invalid.");
      }
      return manifest;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

export function buildMeetingFolderName(meetingDate: string, title: string, meetingId: string): string {
  assertUuid(meetingId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
    throw new DataRootValidationError(`Meeting date must use YYYY-MM-DD: ${meetingDate}`);
  }
  const slug = slugify(title);
  return `${meetingDate}_${slug}_${meetingId}`;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return slug || "Meeting";
}

export function normalizeExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ARTIFACT_EXTENSION_LENGTH ||
    !/^[a-z0-9]+$/.test(normalized)
  ) {
    throw new DataRootValidationError(`Invalid artifact extension: ${extension}`);
  }
  return normalized;
}

export function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new DataRootValidationError(`A valid UUID meeting ID is required: ${value}`);
  }
}

export function normalizeAbsolutePath(value: string): string {
  if (!value || !value.trim() || !isAbsolute(value)) {
    throw new DataRootValidationError("DATA_ROOT must be an absolute path.");
  }
  return resolve(value);
}

/** Returns a user-facing violation for install/system locations. */
export function getDataRootProtectionError(
  candidate: string,
  installationDirectory?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") {
    if (!win32.isAbsolute(candidate)) {
      return "DATA_ROOT must be an absolute Windows path.";
    }
    const normalizedCandidate = win32.normalize(candidate);
    const driveRoot = win32.parse(normalizedCandidate).root;
    const protectedRoots = [
      `${driveRoot}Program Files`,
      `${driveRoot}Program Files (x86)`,
      `${driveRoot}Windows`,
      `${driveRoot}WindowsApps`,
      `${driveRoot}ProgramData`,
      `${driveRoot}Users\\Default`,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramW6432,
      process.env.CommonProgramFiles,
      process.env["CommonProgramFiles(x86)"],
      process.env.CommonProgramW6432,
      process.env.ProgramData,
      process.env.SystemRoot,
      process.env.WINDIR,
    ].filter((value): value is string => value !== undefined && value.length > 0);
    if (installationDirectory !== undefined && isWindowsPathInside(installationDirectory, normalizedCandidate)) {
      return "DATA_ROOT cannot be inside the AI WorkMate application installation directory.";
    }
    if (protectedRoots.some((root) => isWindowsPathInside(root, normalizedCandidate))) {
      return "DATA_ROOT cannot be inside a protected Windows application or system directory such as Program Files.";
    }
    return undefined;
  }

  if (installationDirectory !== undefined && isPathInside(installationDirectory, candidate)) {
    return "DATA_ROOT cannot be inside the application installation directory.";
  }
  return undefined;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const parentResolved = resolve(parent);
  const candidateResolved = resolve(candidate);
  if (samePath(parentResolved, candidateResolved)) {
    return true;
  }
  const pathDifference = relative(parentResolved, candidateResolved);
  return pathDifference !== "" && !pathDifference.startsWith("..") && !isAbsolute(pathDifference);
}

function isWindowsPathInside(parent: string, candidate: string): boolean {
  if (!win32.isAbsolute(parent) || !win32.isAbsolute(candidate)) {
    return false;
  }
  const parentResolved = win32.normalize(parent);
  const candidateResolved = win32.normalize(candidate);
  if (parentResolved.toLowerCase() === candidateResolved.toLowerCase()) {
    return true;
  }
  const pathDifference = win32.relative(parentResolved, candidateResolved);
  return pathDifference !== "" && !pathDifference.startsWith("..") && !win32.isAbsolute(pathDifference);
}

export async function getAvailableBytes(directory: string): Promise<number | null> {
  try {
    const fileSystem = await statfs(directory);
    const available = Number(fileSystem.bavail) * Number(fileSystem.bsize);
    return Number.isSafeInteger(available) ? available : Number.MAX_SAFE_INTEGER;
  } catch {
    // Some filesystems/platforms do not expose statfs. A null value means the
    // caller must surface that the estimate could not be obtained; it is not a
    // claim that space is unlimited.
    return null;
  }
}

async function verifyFileSets(
  sourceRoot: string,
  destinationRoot: string,
  sourceFiles: StorageTreeEntry[],
  destinationFiles: StorageTreeEntry[],
): Promise<void> {
  if (sourceFiles.length !== destinationFiles.length) {
    throw new MigrationVerificationError(
      `Migration file count mismatch: ${sourceFiles.length} source files, ${destinationFiles.length} copied files.`,
    );
  }
  const destinationByPath = new Map(destinationFiles.map((file) => [file.relativePath, file]));
  for (const source of sourceFiles) {
    const destination = destinationByPath.get(source.relativePath);
    if (destination === undefined || destination.size !== source.size) {
      throw new MigrationVerificationError(`Migration verification failed for ${source.relativePath}.`);
    }
    const [sourceHash, destinationHash] = await Promise.all([
      hashFileAt(source.absolutePath),
      hashFileAt(destination.absolutePath),
    ]);
    if (sourceHash !== destinationHash) {
      throw new MigrationVerificationError(`Migration hash mismatch for ${source.relativePath}.`);
    }
  }
  // Keep arguments explicit: the verification contract is source-to-destination
  // and these roots are useful when debugging a failed migration.
  void sourceRoot;
  void destinationRoot;
}

async function hashFileAt(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(absolutePath);
  for await (const chunk of input) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

async function listFilesAt(root: string): Promise<StorageTreeEntry[]> {
  const output: StorageTreeEntry[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        output.push({
          relativePath,
          absolutePath,
          size: fileStat.size,
          modifiedAt: fileStat.mtime.toISOString(),
        });
      }
    }
  };
  await walk(root, "");
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = candidate;
  while (current !== dirname(current)) {
    if (await pathExists(current)) {
      return current;
    }
    current = dirname(current);
  }
  return current;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems. File data
    // is still fsynced before rename; this best-effort step is documented.
  }
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isReplaceRenameError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "ENOTEMPTY");
}

function assertNever(value: never): never {
  throw new DataRootValidationError(`Unsupported artifact type: ${String(value)}`);
}
