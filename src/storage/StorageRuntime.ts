import { randomUUID } from "node:crypto";

import { STORAGE_VERSION } from "../domain/models";
import { CalendarSyncService } from "../calendar/CalendarSyncService";
import type {
  AIProcessingPolicy,
  IntegrityReport,
  MigrationJournal,
  MigrationPlan,
  MigrationResult,
  StorageSnapshot,
} from "../domain/models";
import type { CalendarEventProvider, CalendarSyncRange, CalendarSyncResult } from "../calendar/CalendarModels";
import {
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCapturePolicy,
  type NativeCaptureStateSnapshot,
  type NativeMeetingCaptureAbortRequest,
  type NativeMeetingCaptureStartRequest,
  type NativeMeetingCaptureStopRequest,
} from "../capture/NativeCaptureAdapter";
import { LocalRecordingCaptureEngine } from "../capture/LocalRecordingCaptureEngine";
import { NativeCaptureCoordinator } from "../capture/NativeCaptureCoordinator";
import { createNativeCaptureAdapter } from "../capture/WindowsCaptureAdapter";
import type { CredentialStore } from "../security/CredentialStore";
import { LocalDatabase } from "./LocalDatabase";
import { LocalFirstStore } from "./LocalFirstStore";
import { LocalTranscriptionService, type TranscriptionPersistResult } from "../transcription/LocalTranscriptionService";
import { WindowsLocalWhisperEngine } from "../transcription/WindowsLocalWhisperEngine";
import type { TranscriptionEngine } from "../transcription/TranscriptionEngine";
import type { AIProvider } from "../ai/AIProvider";
import {
  LocalAnalysisService,
  type AnalysisPersistResult,
  unconfiguredLocalAIProvider,
} from "../ai/LocalAnalysisService";
import type { StorageConfigService } from "./StorageConfigService";
import { DataRootValidationError, StorageError } from "./errors";
import {
  LocalStorageService,
  normalizeAbsolutePath,
  type LocalStorageServiceOptions,
} from "./LocalStorageService";

export interface ChangeDataRootResult {
  migrated: boolean;
  plan: MigrationPlan;
  result?: MigrationResult;
}

export interface StorageRuntimeIntegrations {
  microsoftCalendarProvider?: CalendarEventProvider;
  nativeCaptureAdapter?: NativeCaptureAdapter;
  nativeCapturePolicy?: Partial<NativeCapturePolicy>;
  transcriptionEngine?: TranscriptionEngine;
  analysisProvider?: AIProvider;
}

/** Application lifecycle boundary for first-run setup and location changes. */
export class StorageRuntime {
  public store: LocalFirstStore | undefined;
  public nativeCapture: NativeCaptureCoordinator | undefined;
  public transcription: LocalTranscriptionService | undefined;
  public analysis: LocalAnalysisService | undefined;
  public readonly credentialStore: CredentialStore | undefined;
  private readonly config: StorageConfigService;
  private readonly storageOptions: LocalStorageServiceOptions;
  private readonly nativeAdapter: NativeCaptureAdapter;

  public constructor(
    config: StorageConfigService,
    private readonly clock: () => Date = () => new Date(),
    credentialStore?: CredentialStore,
    storageOptions: LocalStorageServiceOptions = {},
    private readonly integrations: StorageRuntimeIntegrations = {},
  ) {
    this.config = config;
    this.credentialStore = credentialStore;
    this.storageOptions = storageOptions;
    this.nativeAdapter = integrations.nativeCaptureAdapter ?? createNativeCaptureAdapter({ clock: this.clock });
  }

  public async initialize(): Promise<boolean> {
    const initialConfig = await this.config.read();
    await this.recoverPendingMigration(initialConfig.pendingMigration);
    const dataRoot = await this.config.getDataRoot();
    if (dataRoot === undefined) {
      return false;
    }
    const store = new LocalFirstStore(dataRoot, { ...this.storageOptions, clock: this.clock });
    await store.initialize();
    this.attachStore(store);
    return true;
  }

  public async configureFirstRun(dataRoot: string): Promise<void> {
    if (this.store !== undefined) {
      throw new StorageError("DATA_ROOT is already configured.");
    }
    const normalized = normalizeAbsolutePath(dataRoot);
    const probe = new LocalStorageService(normalized, this.storageOptions);
    const validation = await probe.validateDataRoot(normalized);
    if (!validation.valid) {
      throw new DataRootValidationError(validation.errors.join(" "));
    }
    const store = new LocalFirstStore(normalized, { ...this.storageOptions, clock: this.clock });
    await store.initialize();
    await this.config.setDataRoot(normalized);
    this.attachStore(store);
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

    const operationId = randomUUID();
    const journal: MigrationJournal = {
      operationId,
      source: plan.source,
      destination: plan.destination,
      state: "STARTED",
      updatedAt: this.clock().toISOString(),
    };
    await this.config.setMigrationJournal(journal);
    try {
      await this.config.setMigrationJournal({ ...journal, state: "COPYING", updatedAt: this.clock().toISOString() });
      const result = await store.migrateDataRoot(plan.destination, async (phase) => {
        await this.config.setMigrationJournal({
          ...journal,
          state: phase,
          updatedAt: this.clock().toISOString(),
        });
      });
      const switchedJournal: MigrationJournal = {
        ...journal,
        state: "RUNTIME_SWITCHED",
        updatedAt: this.clock().toISOString(),
      };
      await this.config.setMigrationJournal(switchedJournal);
      await this.config.setDataRoot(result.destination);
      await this.config.setMigrationJournal({
        ...switchedJournal,
        state: "CONFIGURATION_UPDATED",
        updatedAt: this.clock().toISOString(),
      });
      await this.config.clearMigrationJournal();
      return { migrated: true, plan: result.plan, result };
    } catch (error: unknown) {
      try {
        const current = await this.config.read();
        if (current.pendingMigration?.operationId === operationId) {
          await this.config.setMigrationJournal({
            ...current.pendingMigration,
            state: "INCOMPLETE",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: this.clock().toISOString(),
          });
        }
      } catch {
        // Preserve the original migration error if the configuration journal
        // itself cannot be updated.
      }
      if (this.store !== undefined && !samePath(this.store.storage.dataRoot, plan.source)) {
        await this.detachStore("DATA_ROOT migration failed; aborting native capture.");
        const sourceStore = new LocalFirstStore(plan.source, { ...this.storageOptions, clock: this.clock });
        await sourceStore.initialize();
        this.attachStore(sourceStore);
      }
      throw error;
    }
  }

  public async getSnapshot(): Promise<StorageSnapshot> {
    const store = this.requireStore();
    const config = await this.config.read();
    const snapshot: StorageSnapshot = {
      dataLocation: { type: "LOCAL", label: "Local workspace (path hidden)", pathExposed: false },
      stats: await store.getStorageStats(),
      storageVersion: STORAGE_VERSION,
      aiProcessingPolicy: config.aiProcessingPolicy,
    };
    if (config.pendingMigration !== undefined) {
      snapshot.migrationRecoveryRequired = config.pendingMigration.state === "INCOMPLETE" || config.pendingMigration.state === "FAILED";
    }
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

  public async syncMicrosoftCalendar(range: CalendarSyncRange): Promise<CalendarSyncResult> {
    const provider = this.integrations.microsoftCalendarProvider;
    if (provider === undefined) {
      throw new StorageError(
        "Microsoft 365 calendar synchronization is not configured. Connect a Microsoft OAuth/MSAL provider before syncing.",
      );
    }
    return new CalendarSyncService(provider, this.requireStore(), "MICROSOFT_GRAPH").syncRange(range);
  }

  public async setAiProcessingPolicy(policy: AIProcessingPolicy): Promise<void> {
    await this.config.setAiProcessingPolicy(policy);
  }

  public getDataRoot(): string {
    return this.requireStore().storage.dataRoot;
  }

  public discoverNativeCaptureCapabilities(): Promise<NativeCaptureCapabilities> {
    return this.requireNativeCapture().discoverCapabilities();
  }

  public startNativeCapture(request: NativeMeetingCaptureStartRequest): Promise<NativeCaptureStateSnapshot> {
    return this.requireNativeCapture().startCapture(request);
  }

  public stopNativeCapture(request: NativeMeetingCaptureStopRequest): Promise<NativeCaptureStateSnapshot> {
    return this.requireNativeCapture().stopCapture(request);
  }

  public abortNativeCapture(request: NativeMeetingCaptureAbortRequest): Promise<NativeCaptureStateSnapshot> {
    return this.requireNativeCapture().abortCapture(request);
  }

  public getNativeCaptureState(captureId: string): NativeCaptureStateSnapshot {
    return this.requireNativeCapture().getCaptureState(captureId);
  }

  public transcribeRecording(meetingId: string, recordingId: string): Promise<TranscriptionPersistResult> {
    if (this.transcription === undefined) {
      throw new StorageError("Choose a local data location before using transcription.");
    }
    return this.transcription.transcribeRecording(meetingId, recordingId);
  }

  public async analyzeCommittedTranscript(
    meetingId: string,
    recordingId: string,
    options: { userApprovedForThisRequest?: boolean } = {},
  ): Promise<AnalysisPersistResult> {
    if (this.analysis === undefined || this.store === undefined) {
      throw new StorageError("Choose a local data location before using analysis.");
    }
    const policy = (await this.config.read()).aiProcessingPolicy;
    return this.analysis.analyzeCommittedTranscript({
      meetingId,
      recordingId,
      policy,
      ...(options.userApprovedForThisRequest === undefined ? {} : { userApprovedForThisRequest: options.userApprovedForThisRequest }),
    });
  }

  public async close(): Promise<void> {
    await this.detachStore("Storage runtime closed.");
  }

  private async recoverPendingMigration(journal: MigrationJournal | undefined): Promise<void> {
    if (journal === undefined || journal.state === "FAILED" || journal.state === "INCOMPLETE") {
      return;
    }

    const configuredRoot = await this.config.getDataRoot();
    const destinationReady = await this.isMigrationDestinationReady(journal.destination, journal.source);
    const configuredDestination = configuredRoot !== undefined && samePath(configuredRoot, journal.destination);
    const canActivateDestination = journal.state === "ACTIVATING" || journal.state === "ACTIVATED" || journal.state === "RUNTIME_SWITCHED" || journal.state === "CONFIGURATION_UPDATED";

    if (destinationReady && (configuredDestination || canActivateDestination)) {
      if (!configuredDestination) {
        await this.config.setDataRoot(journal.destination);
      }
      await this.config.clearMigrationJournal();
      return;
    }

    if (configuredDestination && !destinationReady) {
      const sourceReady = await this.isMigrationDestinationReady(journal.source);
      if (!sourceReady) {
        throw new StorageError("The interrupted DATA_ROOT migration has neither a verified source nor a verified destination.");
      }
      await this.config.setDataRoot(journal.source);
    }
    await this.config.setMigrationJournal({
      ...journal,
      state: "INCOMPLETE",
      error: "The migration was interrupted before a verified destination could be activated; the source remains the active location.",
      updatedAt: this.clock().toISOString(),
    });
  }

  private async isMigrationDestinationReady(destination: string, sourceRoot?: string): Promise<boolean> {
    try {
      const storage = new LocalStorageService(destination, this.storageOptions);
      if (!(await storage.exists("storage.json")) || !(await storage.exists("Database/ai-workmate.sqlite"))) {
        return false;
      }
      const manifest = await storage.readJson<{ storageVersion?: unknown }>("storage.json");
      if (manifest.storageVersion !== STORAGE_VERSION) {
        return false;
      }
      if (sourceRoot === undefined) {
        const database = new LocalDatabase(storage.databasePath, this.clock);
        database.close();
        return true;
      }

      const sourceStorage = new LocalStorageService(sourceRoot, this.storageOptions);
      if (
        !(await sourceStorage.exists("storage.json")) ||
        !(await sourceStorage.exists("Database/ai-workmate.sqlite"))
      ) {
        return false;
      }
      const [sourceFiles, destinationFiles] = await Promise.all([
        sourceStorage.listFiles(),
        storage.listFiles(),
      ]);
      // The migration updates storage.json after activation so its label names
      // the destination. Runtime switching also appends one audit record to the
      // destination database, so database relationships are compared through a
      // stable fingerprint instead of a raw database-file hash.
      const isDatabaseFile = (relativePath: string): boolean =>
        relativePath === "Database/ai-workmate.sqlite" ||
        relativePath === "Database/ai-workmate.sqlite-wal" ||
        relativePath === "Database/ai-workmate.sqlite-shm";
      const sourceFilesToCompare = sourceFiles.filter(
        (file) => file.relativePath !== "storage.json" && !isDatabaseFile(file.relativePath),
      );
      const destinationFilesToCompare = destinationFiles.filter(
        (file) => file.relativePath !== "storage.json" && !isDatabaseFile(file.relativePath),
      );
      if (sourceFilesToCompare.length !== destinationFilesToCompare.length) {
        return false;
      }
      const destinationByRelativePath = new Map(
        destinationFilesToCompare.map((file) => [file.relativePath, file]),
      );
      for (const sourceFile of sourceFilesToCompare) {
        const destinationFile = destinationByRelativePath.get(sourceFile.relativePath);
        if (
          destinationFile === undefined ||
          destinationFile.size !== sourceFile.size ||
          (await sourceStorage.hashFile(sourceFile.absolutePath)) !==
            (await storage.hashFile(destinationFile.absolutePath))
        ) {
          return false;
        }
      }

      const sourceDatabase = new LocalDatabase(sourceStorage.databasePath, this.clock);
      try {
        const destinationDatabase = new LocalDatabase(storage.databasePath, this.clock);
        try {
          return sourceDatabase.getMigrationFingerprint() === destinationDatabase.getMigrationFingerprint();
        } finally {
          destinationDatabase.close();
        }
      } finally {
        sourceDatabase.close();
      }
    } catch {
      return false;
    }
  }

  private requireStore(): LocalFirstStore {
    if (this.store === undefined) {
      throw new StorageError("Choose a local data location before using AI WorkMate.");
    }
    return this.store;
  }

  private requireNativeCapture(): NativeCaptureCoordinator {
    if (this.nativeCapture === undefined) {
      throw new StorageError("Choose a local data location before using native capture.");
    }
    return this.nativeCapture;
  }

  private attachStore(store: LocalFirstStore): void {
    this.store = store;
    this.nativeCapture = new NativeCaptureCoordinator(
      this.nativeAdapter,
      new LocalRecordingCaptureEngine(store, this.clock),
      { policy: productionNativeCapturePolicy(this.integrations.nativeCapturePolicy) },
    );
    this.transcription = new LocalTranscriptionService({
      store,
      engine: this.integrations.transcriptionEngine ?? new WindowsLocalWhisperEngine(),
    });
    this.analysis = new LocalAnalysisService({
      store,
      provider: this.integrations.analysisProvider ?? unconfiguredLocalAIProvider(),
    });
  }

  private async detachStore(reason: string): Promise<void> {
    await this.nativeCapture?.abortAllActive(reason);
    this.nativeCapture = undefined;
    this.transcription = undefined;
    this.analysis = undefined;
    this.store?.close();
    this.store = undefined;
  }
}

function productionNativeCapturePolicy(overrides: Partial<NativeCapturePolicy> | undefined): Partial<NativeCapturePolicy> {
  return {
    MICROPHONE_AUDIO: "ALLOW",
    SYSTEM_AUDIO: "ALLOW",
    SCREEN: "DENY",
    WINDOW: "DENY",
    ...overrides,
  };
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
