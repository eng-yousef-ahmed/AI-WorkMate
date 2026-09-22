import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { StorageError } from "../storage/errors";

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

/** OS-backed secret primitive. Electron safeStorage uses Windows DPAPI on Windows. */
export interface OSSecretPrimitive {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

/**
 * Stores encrypted blobs under the Electron userData directory, never under a
 * meeting folder and never in DATA_ROOT. The encryption key remains owned by
 * the OS credential facility.
 */
export class ElectronSafeStorageCredentialStore implements CredentialStore {
  public constructor(
    private readonly primitive: OSSecretPrimitive,
    private readonly vaultPath: string,
  ) {}

  public async get(service: string, account: string): Promise<string | null> {
    const vault = await this.readVault();
    const encoded = vault[key(service, account)];
    if (encoded === undefined) {
      return null;
    }
    if (!this.primitive.isEncryptionAvailable()) {
      throw new StorageError("The operating system secure credential store is unavailable.");
    }
    return this.primitive.decryptString(Buffer.from(encoded, "base64"));
  }

  public async set(service: string, account: string, secret: string): Promise<void> {
    if (!this.primitive.isEncryptionAvailable()) {
      throw new StorageError("The operating system secure credential store is unavailable.");
    }
    const vault = await this.readVault();
    vault[key(service, account)] = Buffer.from(this.primitive.encryptString(secret)).toString("base64");
    await this.writeVault(vault);
  }

  public async delete(service: string, account: string): Promise<void> {
    const vault = await this.readVault();
    delete vault[key(service, account)];
    await this.writeVault(vault);
  }

  private async readVault(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.vaultPath, "utf8")) as unknown;
      if (!isStringRecord(value)) {
        throw new StorageError("The encrypted credential vault is invalid.");
      }
      return value;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
  }

  private async writeVault(vault: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.vaultPath), { recursive: true });
    const temporary = `${this.vaultPath}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(vault, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.vaultPath);
    } catch (error: unknown) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function key(service: string, account: string): string {
  return `${service}:${account}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
