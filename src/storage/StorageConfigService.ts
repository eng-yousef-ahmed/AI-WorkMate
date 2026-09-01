import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { AIProcessingPolicy } from "../domain/models";
import { DataRootValidationError } from "./errors";
import { normalizeAbsolutePath } from "./LocalStorageService";

export interface AppStorageConfig {
  configVersion: 1;
  dataRoot?: string;
  aiProcessingPolicy: AIProcessingPolicy;
  lastIntegrityCheckAt?: string;
  updatedAt: string;
}

/**
 * Stores only application configuration outside DATA_ROOT. It intentionally
 * contains no meeting data or credentials. On Windows this file lives under
 * Electron's userData directory and remains available while DATA_ROOT moves.
 */
export class StorageConfigService {
  private readonly configPath: string;
  private readonly clock: () => Date;

  public constructor(configPath: string, clock: () => Date = () => new Date()) {
    this.configPath = normalizeAbsolutePath(configPath);
    this.clock = clock;
  }

  public get path(): string {
    return this.configPath;
  }

  public async read(): Promise<AppStorageConfig> {
    try {
      const value = JSON.parse((await readFile(this.configPath, "utf8"))) as Partial<AppStorageConfig>;
      if (value.configVersion !== 1 || !isProcessingPolicy(value.aiProcessingPolicy)) {
        throw new DataRootValidationError("The application storage configuration is invalid.");
      }
      const config: AppStorageConfig = {
        configVersion: 1,
        aiProcessingPolicy: value.aiProcessingPolicy,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : this.clock().toISOString(),
      };
      if (value.dataRoot !== undefined) {
        config.dataRoot = normalizeAbsolutePath(value.dataRoot);
      }
      if (typeof value.lastIntegrityCheckAt === "string") {
        config.lastIntegrityCheckAt = value.lastIntegrityCheckAt;
      }
      return config;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return {
          configVersion: 1,
          aiProcessingPolicy: "ASK_EACH_TIME",
          updatedAt: this.clock().toISOString(),
        };
      }
      if (error instanceof SyntaxError) {
        throw new DataRootValidationError("The application storage configuration is not valid JSON.", { cause: error });
      }
      throw error;
    }
  }

  public async getDataRoot(): Promise<string | undefined> {
    return (await this.read()).dataRoot;
  }

  public async setDataRoot(dataRoot: string): Promise<AppStorageConfig> {
    const normalized = normalizeAbsolutePath(dataRoot);
    const current = await this.read();
    return this.write({ ...current, dataRoot: normalized });
  }

  public async setAiProcessingPolicy(aiProcessingPolicy: AIProcessingPolicy): Promise<AppStorageConfig> {
    if (!isProcessingPolicy(aiProcessingPolicy)) {
      throw new DataRootValidationError(`Unknown AI processing policy: ${aiProcessingPolicy}`);
    }
    const current = await this.read();
    return this.write({ ...current, aiProcessingPolicy });
  }

  public async setLastIntegrityCheckAt(lastIntegrityCheckAt: string): Promise<AppStorageConfig> {
    const current = await this.read();
    return this.write({ ...current, lastIntegrityCheckAt });
  }

  private async write(config: AppStorageConfig): Promise<AppStorageConfig> {
    const next: AppStorageConfig = {
      ...config,
      updatedAt: this.clock().toISOString(),
    };
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.configPath);
      return next;
    } catch (error: unknown) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isProcessingPolicy(value: unknown): value is AIProcessingPolicy {
  return value === "LOCAL_ONLY" || value === "CLOUD_ALLOWED" || value === "ASK_EACH_TIME";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
