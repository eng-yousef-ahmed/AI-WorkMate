import type { StorageManifest } from "../domain/models";
import { STORAGE_VERSION } from "../domain/models";
import { DataRootValidationError } from "./errors";
import type { LocalStorageService } from "./LocalStorageService";

export interface StorageLayoutMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate(storage: LocalStorageService, manifest: StorageManifest): Promise<void>;
}

/**
 * Explicit registry for future folder-layout migrations. A layout is never
 * changed implicitly at startup: each step must be registered, ordered, and
 * complete before the storage manifest is advanced.
 */
export class StorageLayoutMigrator {
  private readonly migrations = new Map<number, StorageLayoutMigration>();

  public constructor(migrations: StorageLayoutMigration[] = []) {
    for (const migration of migrations) {
      this.register(migration);
    }
  }

  public register(migration: StorageLayoutMigration): void {
    if (!Number.isInteger(migration.fromVersion) || !Number.isInteger(migration.toVersion) || migration.toVersion <= migration.fromVersion) {
      throw new DataRootValidationError("A storage migration must increase an integer storage version.");
    }
    if (this.migrations.has(migration.fromVersion)) {
      throw new DataRootValidationError(`A storage migration from version ${migration.fromVersion} is already registered.`);
    }
    this.migrations.set(migration.fromVersion, migration);
  }

  public async migrate(storage: LocalStorageService, manifest: StorageManifest): Promise<StorageManifest> {
    let current = manifest;
    while (current.storageVersion < STORAGE_VERSION) {
      const migration = this.migrations.get(current.storageVersion);
      if (migration === undefined || migration.toVersion > STORAGE_VERSION) {
        throw new DataRootValidationError(
          `No safe storage migration is registered from version ${current.storageVersion} to ${STORAGE_VERSION}.`,
        );
      }
      await migration.migrate(storage, current);
      current = await storage.updateManifest({ storageVersion: migration.toVersion });
    }
    return current;
  }
}
