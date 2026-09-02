import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { getWhisperModelCatalogEntry, type WhisperModelCatalogEntry } from "./WhisperRuntimeCatalog";
import { TranscriptionError } from "./TranscriptionEngine";

export interface WhisperDownloadTransport {
  get(url: string): Promise<{ status: number; body: AsyncIterable<Uint8Array> }>;
}

export interface WhisperModelInstallOptions {
  modelId: string;
  localAppData?: string;
  transport?: WhisperDownloadTransport;
  destinationRoot?: string;
}

export interface WhisperModelInstallResult {
  installed: true;
  filename: string;
  sha256: string;
  bytes: number;
  relativeLocation: string;
}

const RELATIVE_MODEL_DIR = join("AI-WorkMate", "models", "whisper");

export function whisperManagedModelDirectory(localAppData: string): string {
  if (!localAppData.trim() || localAppData.includes("\0") || localAppData.includes("..") || !isAbsolute(localAppData)) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "LOCALAPPDATA for Whisper models must be an absolute path.", false);
  }
  return join(resolve(localAppData), RELATIVE_MODEL_DIR);
}

export async function installWhisperModel(options: WhisperModelInstallOptions): Promise<WhisperModelInstallResult> {
  const entry = getWhisperModelCatalogEntry(options.modelId);
  if (entry === undefined) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", `Whisper model ${options.modelId} is not on the HTTPS allowlist.`, false);
  }
  if (!entry.url.startsWith("https://huggingface.co/ggerganov/whisper.cpp/")) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", "Whisper model URL is not allowlisted.", false);
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", "LOCALAPPDATA is required to install a Whisper model.", false);
  }
  const directory = options.destinationRoot === undefined
    ? whisperManagedModelDirectory(localAppData)
    : assertManagedDestination(options.destinationRoot, localAppData);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, entry.filename);
  if (basename(destination) !== entry.filename) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Whisper model filename escaped the managed directory.", false);
  }
  const temporary = `${destination}.tmp-download`;
  await rm(temporary, { force: true }).catch(() => undefined);
  const transport = options.transport ?? httpsTransport();
  const response = await transport.get(entry.url);
  if (response.status !== 200) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", `Whisper model download failed with HTTP ${response.status}.`, true);
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
    if (bytes !== entry.bytes || sha256 !== entry.sha256) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TranscriptionError(
        "TRANSCRIPTION_ENGINE_UNAVAILABLE",
        `Whisper model SHA-256 or size mismatch for ${entry.filename}.`,
        false,
      );
    }
    await rename(temporary, destination);
    return {
      installed: true,
      filename: entry.filename,
      sha256,
      bytes,
      relativeLocation: `%LOCALAPPDATA%\\AI-WorkMate\\models\\whisper\\${entry.filename}`,
    };
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof TranscriptionError) {
      throw error;
    }
    throw new TranscriptionError(
      "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      `Whisper model install was interrupted: ${error instanceof Error ? error.message : String(error)}`,
      true,
      { cause: error },
    );
  }
}

export function assertManagedDestination(destinationRoot: string, localAppData: string): string {
  if (destinationRoot.includes("\0") || destinationRoot.includes("..")) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Whisper model destination is invalid.", false);
  }
  const expected = whisperManagedModelDirectory(localAppData);
  const resolved = isAbsolute(destinationRoot) ? resolve(destinationRoot) : resolve(destinationRoot);
  if (resolved !== expected) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Whisper models must be installed under the managed LocalAppData directory.", false);
  }
  return resolved;
}

export function catalogChecksumMatches(entry: WhisperModelCatalogEntry, sha256: string, bytes: number): boolean {
  return entry.sha256 === sha256.toLowerCase() && entry.bytes === bytes;
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

function httpsTransport(): WhisperDownloadTransport {
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

