import { STORAGE_VERSION } from "../domain/models";
import type {
  AIProcessingPolicy,
  IntegrityReport,
  MigrationPlan,
  MigrationResult,
  StorageSnapshot,
} from "../domain/models";
import type { CredentialStore } from "../security/CredentialStore";
import { LocalFirstStore } from "./LocalFirstStore";
import type { StorageConfigService } from "./StorageConfigService";
import { DataRootValidationError, StorageError } from "./errors";
import { LocalStorageService, normalizeAbsolutePath } from "./LocalStorageService";

export interface ChangeDataRootResult {
  migrated: boolean;
  plan: MigrationPlan;
  result?: MigrationResult;
}

/** Application lifecycle boundary for first-run setup and location changes. */
export class StorageRuntime {
  public store: LocalFirstStore | undefined;
  public readonly credentialStore: CredentialStore | undefined;
  private readonly config: StorageConfigService;

  public constructor(
    config: StorageConfigService,
    private readonly clock: () => Date = () => new Date(),
    credentialStore?: CredentialStore,
  ) {
    this.config = config;
    this.credentialStore = credentialStore;
  }

  public async initialize(): Promise<boolean> {
    const dataRoot = await this.config.getDataRoot();
    if (dataRoot === undefined) {
      return false;
    }
    const store = new LocalFirstStore(dataRoot, { clock: this.clock });
    await store.initialize();
    this.store = store;
    return true;
  }

  public async configureFirstRun(dataRoot: string): Promise<void> {
    if (this.store !== undefined) {
      throw new StorageError("DATA_ROOT is already configured.");
    }
    const normalized = normalizeAbsolutePath(dataRoot);
    const probe = new LocalStorageService(normalized);
    const validation = await probe.validateDataRoot(normalized);
    if (!validation.valid) {
      throw new DataRootValidationError(validation.errors.join(" "));
    }
    const store = new LocalFirstStore(normalized, { clock: this.clock });
    await store.initialize();
    await this.config.setDataRoot(normalized);
    this.store = store;
  }

  public async prepareDataRootChange(destination: string): Promise<MigrationPlan> {
    return this.requireStore().storage.createMigrationPlan(destination);
  }

  public async changeDataRoot(destination: string, migrateExistingData: boolean): Promise<ChangeDataRootResult> {
    const store = this.requireStore();
    const plan = await store.storage.createMigrationPlan(destination);
    if (!migrateExistingData) {
      return { migrated: false, plan };
    }
    const result = await store.migrateDataRoot(plan.destination);
    await this.config.setDataRoot(result.destination);
    return { migrated: true, plan: result.plan, result };
  }

  public async getSnapshot(): Promise<StorageSnapshot> {
    const store = this.requireStore();
    const config = await this.config.read();
    const snapshot: StorageSnapshot = {
      dataLocation: store.storage.dataRoot,
      stats: await store.getStorageStats(),
      storageVersion: STORAGE_VERSION,
      aiProcessingPolicy: config.aiProcessingPolicy,
    };
    const lastIntegrityCheckAt = store.database.getLastIntegrityCheckAt() ?? config.lastIntegrityCheckAt;
    if (lastIntegrityCheckAt !== undefined) {
      snapshot.lastIntegrityCheckAt = lastIntegrityCheckAt;
    }
    return snapshot;
  }

  public async verifyStorage(): Promise<IntegrityReport> {
    const report = await this.requireStore().verifyStorage();
    await this.config.setLastIntegrityCheckAt(report.checkedAt);
    return report;
  }

  public async repairStorage(): Promise<IntegrityReport> {
    const report = await this.requireStore().repairStorageIndex();
    await this.config.setLastIntegrityCheckAt(report.checkedAt);
    return report;
  }

  public async setAiProcessingPolicy(policy: AIProcessingPolicy): Promise<void> {
    await this.config.setAiProcessingPolicy(policy);
  }

  public getDataRoot(): string {
    return this.requireStore().storage.dataRoot;
  }

  private requireStore(): LocalFirstStore {
    if (this.store === undefined) {
      throw new StorageError("Choose a local data location before using AI WorkMate.");
    }
    return this.store;
  }
}
