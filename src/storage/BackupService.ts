import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import unzipper from "unzipper";

import { STORAGE_VERSION, type BackupManifest } from "../domain/models";
import { ArchiveSecurityError, DataRootValidationError } from "./errors";
import { ArchiveService, normalizeArchiveEntryName, type CreatedArchive } from "./ArchiveService";
import type { LocalDatabase } from "./LocalDatabase";
import { isPathInside, LocalStorageService, normalizeAbsolutePath } from "./LocalStorageService";

export interface RestoreResult {
  destination: string;
  verified: boolean;
  restoredFiles: number;
  sourceArchive: string;
}

/**
 * Local, user-triggered backup and restore. A backup is a standard ZIP with a
 * manifest and a consistent SQLite snapshot; recordings are copied as-is and
 * are never transcoded.
 */
export class BackupService {
  private readonly archiveService = new ArchiveService();

  public constructor(
    private readonly storage: LocalStorageService,
    private readonly database: LocalDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async createBackup(backupDirectory: string): Promise<CreatedArchive> {
    const directory = await this.validateBackupDirectory(backupDirectory);
    this.database.checkpoint();

    const snapshotPath = join(tmpdir(), `ai-workmate-db-${randomUUID()}.sqlite`);
    try {
      await this.database.createConsistentCopy(snapshotPath);
      const sourceFiles = await this.storage.listFiles();
      const dataFiles = sourceFiles.filter((file) => !isExcludedFromBackup(file.relativePath));
      const databaseEntry = "Database/ai-workmate.sqlite";
      const databaseHash = await this.storage.hashFile(snapshotPath);
      const sha256ByPath: Record<string, string> = { [databaseEntry]: databaseHash };
      for (const file of dataFiles) {
        if (file.relativePath === databaseEntry) {
          continue;
        }
        sha256ByPath[file.relativePath] = await this.storage.hashFile(file.absolutePath);
      }

      const manifest: BackupManifest = {
        format: "AI_WORKMATE_BACKUP",
        formatVersion: 1,
        storageVersion: STORAGE_VERSION,
        createdAt: this.clock().toISOString(),
        sourceDataRoot: this.storage.dataRoot,
        includes: ["database", "meetings", "recordings", "audio", "transcripts", "analysis", "attachments", "exports", "metadata"],
        fileCount: Object.keys(sha256ByPath).length,
        sha256ByPath,
      };
      const filename = `ai-workmate-backup-${formatTimestamp(this.clock())}-${randomUUID()}.aiwm.zip`;
      const destination = join(directory, filename);
      const entries = [
        { name: "BackupManifest.json", contents: `${JSON.stringify(manifest, null, 2)}\n` },
        ...dataFiles
          .filter((file) => file.relativePath !== databaseEntry)
          .map((file) => ({ name: file.relativePath, source: this.storage.createReadStream(file.relativePath) })),
        { name: databaseEntry, source: createReadStream(snapshotPath) },
      ];
      const created = await this.archiveService.createZip(destination, entries);
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "BACKUP_CREATED",
        details: { path: created.path, fileCount: manifest.fileCount, format: manifest.format },
        createdAt: this.clock().toISOString(),
      });
      return created;
    } finally {
      await rm(snapshotPath, { force: true }).catch(() => undefined);
    }
  }

  public async restore(archivePath: string, destinationRoot: string): Promise<RestoreResult> {
    const archive = normalizeAbsolutePath(archivePath);
    const destination = normalizeAbsolutePath(destinationRoot);
    if (isPathInside(this.storage.dataRoot, destination) || isPathInside(destination, this.storage.dataRoot)) {
      throw new DataRootValidationError("A restore destination cannot contain or be contained by the active DATA_ROOT.");
    }
    const archiveStat = await stat(archive);
    if (!archiveStat.isFile()) {
      throw new DataRootValidationError("The selected backup is not a file.");
    }
    await ensureEmptyOrMissingDirectory(destination);

    const staging = join(dirname(destination), `.ai-workmate-restore-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    const restoredStorage = new LocalStorageService(staging, { spaceSafetyMarginBytes: 0 });
    const restoredPaths = new Set<string>();
    try {
      const archiveDirectory = await unzipper.Open.file(archive);
      for (const entry of archiveDirectory.files) {
        const rawName = entry.path.replaceAll("\\", "/");
        if (rawName.endsWith("/")) {
          const directoryName = rawName.slice(0, -1);
          if (directoryName) {
            normalizeArchiveEntryName(directoryName);
          }
          continue;
        }
        const name = normalizeArchiveEntryName(rawName);
        if (restoredPaths.has(name)) {
          throw new ArchiveSecurityError(`Backup contains duplicate entry: ${name}`);
        }
        restoredPaths.add(name);
        await restoredStorage.writeStreamAtomic(name, entry.stream());
      }

      const manifest = await restoredStorage.readJson<BackupManifest>("BackupManifest.json");
      validateBackupManifest(manifest);
      const restoredDataFiles = await restoredStorage.listFiles();
      const actualDataFiles = restoredDataFiles.filter((file) => file.relativePath !== "BackupManifest.json");
      if (actualDataFiles.length !== manifest.fileCount) {
        throw new ArchiveSecurityError(
          `Backup file count mismatch: manifest has ${manifest.fileCount}, restore has ${actualDataFiles.length}.`,
        );
      }
      for (const [relativePath, expectedHash] of Object.entries(manifest.sha256ByPath)) {
        const verification = await restoredStorage.inspectFile(relativePath, expectedHash);
        if (verification.status !== "AVAILABLE") {
          throw new ArchiveSecurityError(`Backup verification failed for ${relativePath}.`);
        }
      }
      if (!restoredPaths.has("storage.json") || !restoredPaths.has("Database/ai-workmate.sqlite")) {
        throw new ArchiveSecurityError("Backup is missing storage.json or the local SQLite database.");
      }

      if (await pathExists(destination)) {
        await rename(destination, `${destination}.previous-${randomUUID()}`);
      }
      await rename(staging, destination);
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "BACKUP_RESTORED",
        details: { sourceArchive: archive, destination, fileCount: manifest.fileCount },
        createdAt: this.clock().toISOString(),
      });
      return { destination, verified: true, restoredFiles: manifest.fileCount, sourceArchive: archive };
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true });
      if (error instanceof ArchiveSecurityError || error instanceof DataRootValidationError) {
        throw error;
      }
      throw new ArchiveSecurityError(
        `Backup restore was not completed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  public async listBackups(backupDirectory: string): Promise<string[]> {
    const directory = normalizeAbsolutePath(backupDirectory);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".aiwm.zip"))
        .map((entry) => join(directory, entry.name))
        .sort();
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  /** Deletion is never part of backup retention automatically. */
  public async deleteBackup(backupPath: string, confirmed = false): Promise<void> {
    if (!confirmed) {
      throw new DataRootValidationError("Deleting a backup requires explicit confirmation.");
    }
    const normalized = normalizeAbsolutePath(backupPath);
    if (isPathInside(this.storage.dataRoot, normalized)) {
      throw new DataRootValidationError("Backup deletion must not target DATA_ROOT.");
    }
    await rm(normalized, { force: false });
  }

  private async validateBackupDirectory(value: string): Promise<string> {
    const directory = normalizeAbsolutePath(value);
    if (isPathInside(this.storage.dataRoot, directory) || isPathInside(directory, this.storage.dataRoot)) {
      throw new DataRootValidationError("Backups must be stored outside DATA_ROOT to avoid recursive storage.");
    }
    await mkdir(directory, { recursive: true });
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new DataRootValidationError("The backup location is not a folder.");
    }
    return directory;
  }
}

function isExcludedFromBackup(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return (
    normalized.startsWith("backups/") ||
    normalized === "database/ai-workmate.sqlite" ||
    normalized === "database/ai-workmate.sqlite-wal" ||
    normalized === "database/ai-workmate.sqlite-shm" ||
    normalized.includes(".tmp-")
  );
}

function validateBackupManifest(manifest: BackupManifest): void {
  if (
    manifest.format !== "AI_WORKMATE_BACKUP" ||
    manifest.formatVersion !== 1 ||
    manifest.storageVersion !== STORAGE_VERSION ||
    !Number.isInteger(manifest.fileCount) ||
    manifest.fileCount < 2
  ) {
    throw new ArchiveSecurityError("The backup manifest is invalid or unsupported.");
  }
  if (Object.keys(manifest.sha256ByPath).length !== manifest.fileCount) {
    throw new ArchiveSecurityError("The backup manifest hash index is incomplete.");
  }
  for (const [path, hash] of Object.entries(manifest.sha256ByPath)) {
    normalizeArchiveEntryName(path);
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      throw new ArchiveSecurityError(`Invalid SHA-256 value in backup manifest for ${path}.`);
    }
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[.:]/g, "-");
}

async function ensureEmptyOrMissingDirectory(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new DataRootValidationError("The restore destination must be empty.");
    }
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
