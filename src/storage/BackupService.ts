import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import unzipper from "unzipper";

import { STORAGE_VERSION, type BackupManifest, type StorageManifest } from "../domain/models";
import { ArchiveSecurityError, DataRootValidationError, InsufficientDiskSpaceError, StorageError } from "./errors";
import { ArchiveService, normalizeArchiveEntryName, type ArchiveEntry, type CreatedArchive } from "./ArchiveService";
import { removeDirectoryAfterSqliteClose } from "./sqlite-lifecycle";
import type { LocalDatabase } from "./LocalDatabase";
import { getAvailableBytes, isPathInside, LocalStorageService, normalizeAbsolutePath } from "./LocalStorageService";
import { assertDirectoryHasSpace, type AvailableBytesForDirectory } from "./disk-space";

/** Staging folders left when a restore is interrupted (crash / kill). */
export const RESTORE_STAGING_PREFIX = ".ai-workmate-restore-";
/** Sentinel stored in new archives so a shared ZIP cannot leak DATA_ROOT. */
export const LOCAL_BACKUP_ORIGIN = "LOCAL";

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
  private readonly availableBytesForDirectory: AvailableBytesForDirectory;
  private busy = false;

  public constructor(
    private readonly storage: LocalStorageService,
    private readonly database: LocalDatabase,
    private readonly clock: () => Date = () => new Date(),
    availableBytesForDirectory?: AvailableBytesForDirectory,
  ) {
    this.availableBytesForDirectory = availableBytesForDirectory ?? getAvailableBytes;
  }

  private beginExclusive(): void {
    if (this.busy) {
      throw new StorageError("A backup or restore is already in progress.");
    }
    this.busy = true;
  }

  public async createBackup(backupDirectory: string): Promise<CreatedArchive> {
    this.beginExclusive();
    const snapshotPath = join(tmpdir(), `ai-workmate-db-${randomUUID()}.sqlite`);
    try {
      const directory = await this.validateBackupDirectory(backupDirectory);
      this.database.checkpoint();
      await this.database.createConsistentCopy(snapshotPath);
      const snapshotStat = await stat(snapshotPath);
      const sourceFiles = await this.storage.listFiles();
      const dataFiles = sourceFiles.filter((file) => !isExcludedFromBackup(file.relativePath));
      const databaseEntry = "Database/ai-workmate.sqlite";
      let requiredBytes = snapshotStat.size;
      const databaseHash = await this.storage.hashFile(snapshotPath);
      const sha256ByPath: Record<string, string> = { [databaseEntry]: databaseHash };
      const fileEntries: ArchiveEntry[] = [];
      for (const file of dataFiles) {
        if (file.relativePath === databaseEntry) {
          continue;
        }
        requiredBytes += file.size;
        if (file.relativePath === "storage.json") {
          const rewritten = rewriteStorageManifestForBackup(await this.storage.readJson<StorageManifest>("storage.json"));
          const contents = `${JSON.stringify(rewritten, null, 2)}\n`;
          sha256ByPath[file.relativePath] = this.storage.hashBytes(contents);
          fileEntries.push({ name: file.relativePath, contents });
          continue;
        }
        sha256ByPath[file.relativePath] = await this.storage.hashFile(file.absolutePath);
        fileEntries.push({ name: file.relativePath, source: this.storage.createReadStream(file.relativePath) });
      }
      await assertDirectoryHasSpace(
        directory,
        requiredBytes,
        this.storage.spaceSafetyMarginBytes,
        this.availableBytesForDirectory,
      );

      const manifest: BackupManifest = {
        format: "AI_WORKMATE_BACKUP",
        formatVersion: 1,
        storageVersion: STORAGE_VERSION,
        createdAt: this.clock().toISOString(),
        sourceDataRoot: LOCAL_BACKUP_ORIGIN,
        includes: ["database", "meetings", "recordings", "audio", "transcripts", "analysis", "attachments", "exports", "metadata"],
        fileCount: Object.keys(sha256ByPath).length,
        sha256ByPath,
      };
      const filename = `ai-workmate-backup-${formatTimestamp(this.clock())}-${randomUUID()}.aiwm.zip`;
      const destination = join(directory, filename);
      const entries: ArchiveEntry[] = [
        { name: "BackupManifest.json", contents: `${JSON.stringify(manifest, null, 2)}\n` },
        ...fileEntries,
        { name: databaseEntry, source: createReadStream(snapshotPath) },
      ];
      const created = await this.archiveService.createZip(destination, entries);
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "BACKUP_CREATED",
        details: { fileCount: manifest.fileCount, format: manifest.format, size: created.size },
        createdAt: this.clock().toISOString(),
      });
      return created;
    } finally {
      await removeDirectoryAfterSqliteClose(snapshotPath).catch(() => undefined);
      this.busy = false;
    }
  }

  public async restore(archivePath: string, destinationRoot: string): Promise<RestoreResult> {
    this.beginExclusive();
    let staging: string | undefined;
    try {
      const archive = normalizeAbsolutePath(archivePath);
      const destination = normalizeAbsolutePath(destinationRoot);
      if (isPathInside(this.storage.dataRoot, destination) || isPathInside(destination, this.storage.dataRoot)) {
        throw new DataRootValidationError("A restore destination cannot contain or be contained by the active DATA_ROOT.");
      }
      const archiveStat = await stat(archive);
      if (!archiveStat.isFile() || archiveStat.size === 0) {
        throw new ArchiveSecurityError("The selected backup is not a readable archive.");
      }
      await ensureEmptyOrMissingDirectory(destination);
      const parent = dirname(destination);
      await cleanupInterruptedRestoreStaging(parent);
      await assertDirectoryHasSpace(
        parent,
        archiveStat.size,
        this.storage.spaceSafetyMarginBytes,
        this.availableBytesForDirectory,
      );

      staging = join(parent, `${RESTORE_STAGING_PREFIX}${randomUUID()}`);
      await mkdir(staging, { recursive: true });
      const restoredStorage = new LocalStorageService(staging, { spaceSafetyMarginBytes: 0 });
      const restoredPaths = new Set<string>();
      let archiveDirectory;
      try {
        archiveDirectory = await unzipper.Open.file(archive);
      } catch (error: unknown) {
        throw new ArchiveSecurityError("The backup archive is corrupted or not a valid ZIP.", { cause: error });
      }
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
      for (const file of actualDataFiles) {
        if (manifest.sha256ByPath[file.relativePath] === undefined) {
          throw new ArchiveSecurityError(`Backup contains an unexpected file: ${file.relativePath}.`);
        }
      }
      for (const [relativePath, expectedHash] of Object.entries(manifest.sha256ByPath)) {
        const verification = await restoredStorage.inspectFile(relativePath, expectedHash);
        if (verification.status !== "AVAILABLE") {
          throw new ArchiveSecurityError(`Backup SHA-256 verification failed for ${relativePath}.`);
        }
      }
      if (!restoredPaths.has("storage.json") || !restoredPaths.has("Database/ai-workmate.sqlite")) {
        throw new ArchiveSecurityError("Backup is missing storage.json or the local SQLite database.");
      }

      if (await pathExists(destination)) {
        await rename(destination, `${destination}.previous-${randomUUID()}`);
      }
      await rename(staging, destination);
      staging = undefined;
      this.database.appendAudit({
        auditId: randomUUID(),
        action: "BACKUP_RESTORED",
        details: { fileCount: manifest.fileCount, verified: true },
        createdAt: this.clock().toISOString(),
      });
      return { destination, verified: true, restoredFiles: manifest.fileCount, sourceArchive: archive };
    } catch (error: unknown) {
      if (staging !== undefined) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      if (
        error instanceof ArchiveSecurityError ||
        error instanceof DataRootValidationError ||
        error instanceof InsufficientDiskSpaceError ||
        error instanceof StorageError
      ) {
        throw error;
      }
      throw new ArchiveSecurityError("Backup restore was not completed because the archive could not be verified.", {
        cause: error,
      });
    } finally {
      this.busy = false;
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

export function rewriteStorageManifestForBackup(manifest: StorageManifest): StorageManifest {
  return { ...manifest, dataRootLabel: LOCAL_BACKUP_ORIGIN };
}

export async function cleanupInterruptedRestoreStaging(parentDirectory: string): Promise<number> {
  const parent = normalizeAbsolutePath(parentDirectory);
  let removed = 0;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return 0;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(RESTORE_STAGING_PREFIX)) {
      await rm(join(parent, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
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
