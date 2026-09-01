import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";

import { ArchiveSecurityError, DataRootValidationError } from "./errors";

const nodeRequire = createRequire(__filename);
interface ArchiveLike {
  once(event: "close", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
  append(source: string | Buffer | Readable, data: { name: string }): this;
  finalize(): Promise<void>;
}
interface ArchiverModule {
  ZipArchive: new (options: { zlib: { level: number }; forceZip64: boolean }) => ArchiveLike;
}

export interface ArchiveEntry {
  name: string;
  source?: Readable;
  contents?: Uint8Array | string;
}

export interface CreatedArchive {
  path: string;
  size: number;
}

/**
 * Creates standard ZIP archives without transcoding media. Entries are streamed
 * into the archive and the final archive is atomically renamed into place.
 */
export class ArchiveService {
  public async createZip(destinationPath: string, entries: ArchiveEntry[]): Promise<CreatedArchive> {
    const destination = normalizeAbsolutePath(destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    if (await exists(destination)) {
      throw new DataRootValidationError(`Refusing to overwrite an existing archive: ${destination}`);
    }
    validateEntries(entries);

    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await createArchiveFile(temporary, entries);
      const outputStat = await stat(temporary);
      await rename(temporary, destination);
      return { path: destination, size: outputStat.size };
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function createArchiveFile(path: string, entries: ArchiveEntry[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const archiverModule = nodeRequire("archiver") as ArchiverModule;
    const archive = new archiverModule.ZipArchive({ zlib: { level: 0 }, forceZip64: true });
    let settled = false;
    const resolveOnce = (): void => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    };
    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };

    output.once("close", resolveOnce);
    output.once("error", rejectOnce);
    archive.once("error", rejectOnce);
    archive.pipe(output);
    for (const entry of entries) {
      if (entry.source !== undefined) {
        archive.append(entry.source, { name: entry.name });
      } else {
        const contents = entry.contents ?? "";
        archive.append(typeof contents === "string" ? contents : Buffer.from(contents), { name: entry.name });
      }
    }
    void archive.finalize().catch(rejectOnce);
  });
}

function validateEntries(entries: ArchiveEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeArchiveEntryName(entry.name);
    if (normalized !== entry.name) {
      throw new ArchiveSecurityError(`Archive entry names must use normalized relative paths: ${entry.name}`);
    }
    if (names.has(normalized)) {
      throw new ArchiveSecurityError(`Archive contains duplicate entry: ${normalized}`);
    }
    names.add(normalized);
    if (entry.source === undefined && entry.contents === undefined) {
      throw new ArchiveSecurityError(`Archive entry has no content: ${normalized}`);
    }
    if (entry.source !== undefined && entry.contents !== undefined) {
      throw new ArchiveSecurityError(`Archive entry has multiple content sources: ${normalized}`);
    }
  }
}

export function normalizeArchiveEntryName(name: string): string {
  if (!name || name.includes("\0")) {
    throw new ArchiveSecurityError("Archive entry name is empty or contains a null byte.");
  }
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new ArchiveSecurityError(`Absolute archive entry rejected: ${name}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw new ArchiveSecurityError(`Unsafe archive entry rejected: ${name}`);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(value: string): string {
  if (!value || !isAbsolute(value)) {
    throw new DataRootValidationError("Archive paths must be absolute.");
  }
  return resolve(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await open(path, "r").then(async (handle) => handle.close());
    return true;
  } catch (error: unknown) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  }
}
