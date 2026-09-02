import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { getLocalLlmModelCatalogEntry, isAllowlistedLocalLlmModelUrl, type LocalLlmModelCatalogEntry, type LocalLlmModelFile } from "./LocalLlmRuntimeCatalog";
import { LocalLlmError } from "./LocalLlmErrors";

export interface LocalLlmDownloadTransport {
  get(url: string): Promise<{ status: number; body: AsyncIterable<Uint8Array> }>;
}

export interface LocalLlmModelInstallOptions {
  modelId: string;
  localAppData?: string;
  transport?: LocalLlmDownloadTransport;
  destinationRoot?: string;
}

export interface InstalledLocalLlmModelFile {
  filename: string;
  sha256: string;
  bytes: number;
}

export interface LocalLlmModelInstallResult {
  installed: true;
  filename: string;
  sha256: string;
  bytes: number;
  files: InstalledLocalLlmModelFile[];
  relativeLocation: string;
  splitGguf: boolean;
}

const RELATIVE_MODEL_DIR = join("AI-WorkMate", "models", "llm");

export function localLlmManagedModelDirectory(localAppData: string): string {
  if (!localAppData.trim() || localAppData.includes("\0") || localAppData.includes("..") || !isAbsolute(localAppData)) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "LOCALAPPDATA for local LLM models must be an absolute path.", false);
  }
  return join(resolve(localAppData), RELATIVE_MODEL_DIR);
}

export async function installLocalLlmModel(options: LocalLlmModelInstallOptions): Promise<LocalLlmModelInstallResult> {
  const entry = getLocalLlmModelCatalogEntry(options.modelId);
  if (entry === undefined) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", `Local LLM model ${options.modelId} is not on the HTTPS allowlist.`, false);
  }
  if (!isAllowlistedLocalLlmModelUrl(entry.url) || entry.files.some((file) => !isAllowlistedLocalLlmModelUrl(file.url))) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model URL is not allowlisted.", false);
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "LOCALAPPDATA is required to install a local LLM model.", false);
  }
  const directory = options.destinationRoot === undefined
    ? localLlmManagedModelDirectory(localAppData)
    : assertManagedLocalLlmDestination(options.destinationRoot, localAppData);
  await mkdir(directory, { recursive: true });
  const transport = options.transport ?? httpsTransport();
  const installed: InstalledLocalLlmModelFile[] = [];
  for (const file of entry.files) {
    installed.push(await installCatalogFile(directory, file, transport));
  }
  const primary = installed[0];
  if (primary === undefined) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM catalog entry has no files.", false);
  }
  return {
    installed: true,
    filename: primary.filename,
    sha256: primary.sha256,
    bytes: primary.bytes,
    files: installed,
    relativeLocation: `%LOCALAPPDATA%\\AI-WorkMate\\models\\llm\\${primary.filename}`,
    splitGguf: entry.splitGguf,
  };
}

export function assertManagedLocalLlmDestination(destinationRoot: string, localAppData: string): string {
  if (destinationRoot.includes("\0") || destinationRoot.includes("..")) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM model destination is invalid.", false);
  }
  const expected = localLlmManagedModelDirectory(localAppData);
  const resolved = resolve(destinationRoot);
  if (resolved !== expected) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM models must be installed under the managed LocalAppData directory.", false);
  }
  return resolved;
}

export function catalogLocalLlmChecksumMatches(entry: LocalLlmModelCatalogEntry, sha256: string, bytes: number): boolean {
  return entry.sha256 === sha256.toLowerCase() && entry.bytes === bytes;
}

async function installCatalogFile(
  directory: string,
  file: LocalLlmModelFile,
  transport: LocalLlmDownloadTransport,
): Promise<InstalledLocalLlmModelFile> {
  const destination = join(directory, file.filename);
  if (basename(destination) !== file.filename) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM model filename escaped the managed directory.", false);
  }
  const temporary = `${destination}.tmp-download`;
  await rm(temporary, { force: true }).catch(() => undefined);
  const response = await transport.get(file.url);
  if (response.status !== 200) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", `Local LLM model download failed with HTTP ${response.status}.`, true);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    await pipeline(Readable.from(hashingBody(response.body, hash, (chunk) => {
      bytes += chunk.byteLength;
    })), output);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest("hex");
    if (bytes !== file.bytes || sha256 !== file.sha256) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new LocalLlmError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        `Local LLM model SHA-256 or size mismatch for ${file.filename}.`,
        false,
      );
    }
    await rename(temporary, destination);
    return { filename: file.filename, sha256, bytes };
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof LocalLlmError) {
      throw error;
    }
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_UNAVAILABLE",
      `Local LLM model install was interrupted: ${error instanceof Error ? error.message : String(error)}`,
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

function httpsTransport(): LocalLlmDownloadTransport {
  return {
    async get(url: string) {
      const response = await fetch(url, { redirect: "follow" });
      if (response.body === null) {
        return { status: response.status, body: (async function* () {})() };
      }
      return { status: response.status, body: readableWebToAsync(response.body) };
    },
  };
}

async function* readableWebToAsync(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}
