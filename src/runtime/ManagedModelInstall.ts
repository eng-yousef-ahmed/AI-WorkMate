import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { assertDirectoryHasSpace, type AvailableBytesForDirectory } from "../storage/disk-space";

export type ManagedInstallInspection = "MISSING" | "VERIFIED" | "CORRUPTED";

export interface ManagedDownloadTransport {
  get(url: string): Promise<{ status: number; body: AsyncIterable<Uint8Array> }>;
}

export interface ManagedFileSpec {
  filename: string;
  sha256: string;
  bytes: number;
  url: string;
}

export interface InstallVerifiedFileOptions {
  directory: string;
  file: ManagedFileSpec;
  transport: ManagedDownloadTransport;
  replaceCorrupted?: boolean;
  availableBytesProvider?: AvailableBytesForDirectory;
}

export interface InstallVerifiedFileResult {
  filename: string;
  sha256: string;
  bytes: number;
  alreadyVerified: boolean;
}

export class ManagedInstallError extends Error {
  public readonly code: "CHECKSUM" | "INTERRUPTED" | "HTTP" | "REFUSE_VERIFIED" | "CORRUPTED" | "PATH";
  public readonly retryable: boolean;

  public constructor(
    code: ManagedInstallError["code"],
    message: string,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedInstallError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function hashFileSha256(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(absolutePath);
  for await (const chunk of input) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

export async function inspectManagedInstallTarget(
  absolutePath: string,
  sha256: string,
  bytes: number,
): Promise<ManagedInstallInspection> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return "CORRUPTED";
    }
    if (fileStat.size !== bytes) {
      return "CORRUPTED";
    }
    const actual = await hashFileSha256(absolutePath);
    return actual === sha256.toLowerCase() ? "VERIFIED" : "CORRUPTED";
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "MISSING";
    }
    throw error;
  }
}

/**
 * Downloads an allowlisted file into `directory` with SHA-256 verification,
 * atomic tmp+rename, and resume. A SHA-verified destination is never replaced.
 */
export async function installVerifiedFile(options: InstallVerifiedFileOptions): Promise<InstallVerifiedFileResult> {
  const filename = options.file.filename;
  if (filename.length === 0 || filename.includes("\0") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new ManagedInstallError("PATH", "Managed model filename is invalid.", false);
  }
  await mkdir(options.directory, { recursive: true });
  const destination = join(options.directory, filename);
  if (basename(destination) !== filename) {
    throw new ManagedInstallError("PATH", "Managed model filename escaped the destination directory.", false);
  }
  const expectedSha = options.file.sha256.toLowerCase();
  const existing = await inspectManagedInstallTarget(destination, expectedSha, options.file.bytes);
  if (existing === "VERIFIED") {
    return {
      filename,
      sha256: expectedSha,
      bytes: options.file.bytes,
      alreadyVerified: true,
    };
  }
  if (existing === "CORRUPTED" && options.replaceCorrupted !== true) {
    throw new ManagedInstallError(
      "CORRUPTED",
      "A local model file is already present but failed verification. Reinstall requires an explicit replace of the corrupted file.",
      false,
    );
  }
  if (existing === "CORRUPTED") {
    await rm(destination, { force: true }).catch(() => undefined);
  }
  await assertDirectoryHasSpace(
    options.directory,
    options.file.bytes,
    0,
    options.availableBytesProvider,
  );
  const temporary = `${destination}.tmp-download`;
  await rm(temporary, { force: true }).catch(() => undefined);
  const response = await options.transport.get(options.file.url);
  if (response.status !== 200) {
    throw new ManagedInstallError("HTTP", `Model download failed with HTTP ${response.status}.`, true);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    await pipeline(
      Readable.from(
        hashingBody(response.body, hash, (chunk) => {
          bytes += chunk.byteLength;
        }),
      ),
      output,
    );
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest("hex");
    if (bytes !== options.file.bytes || sha256 !== expectedSha) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ManagedInstallError("CHECKSUM", `Model SHA-256 or size mismatch for ${filename}.`, false);
    }
    await rename(temporary, destination);
    return { filename, sha256, bytes, alreadyVerified: false };
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof ManagedInstallError) {
      throw error;
    }
    throw new ManagedInstallError(
      "INTERRUPTED",
      `Model install was interrupted: ${error instanceof Error ? error.message : String(error)}`,
      true,
      { cause: error },
    );
  }
}

async function* hashingBody(
  body: AsyncIterable<Uint8Array>,
  hash: ReturnType<typeof createHash>,
  onChunk: (chunk: Uint8Array) => void,
): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    hash.update(chunk);
    onChunk(chunk);
    yield chunk;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
