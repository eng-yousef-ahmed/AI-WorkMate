import { isAbsolute, join, resolve } from "node:path";

import { installVerifiedFile, ManagedInstallError } from "../runtime/ManagedModelInstall";
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
  replaceCorrupted?: boolean;
}

export interface WhisperModelInstallResult {
  installed: true;
  filename: string;
  sha256: string;
  bytes: number;
  relativeLocation: string;
  alreadyVerified?: boolean;
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
  const transport = options.transport ?? httpsTransport();
  try {
    const installed = await installVerifiedFile({
      directory,
      file: { filename: entry.filename, sha256: entry.sha256, bytes: entry.bytes, url: entry.url },
      transport,
      ...(options.replaceCorrupted === true ? { replaceCorrupted: true } : {}),
    });
    return {
      installed: true,
      filename: installed.filename,
      sha256: installed.sha256,
      bytes: installed.bytes,
      relativeLocation: `%LOCALAPPDATA%\\\\AI-WorkMate\\\\models\\\\whisper\\\\${installed.filename}`,
      alreadyVerified: installed.alreadyVerified,
    };
  } catch (error: unknown) {
    throw wrapWhisperInstallError(error, entry.filename);
  }
}

function wrapWhisperInstallError(error: unknown, filename: string): TranscriptionError {
  if (error instanceof TranscriptionError) {
    return error;
  }
  if (error instanceof ManagedInstallError) {
    if (error.code === "PATH") {
      return new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", error.message, false, { cause: error });
    }
    if (error.code === "CHECKSUM") {
      return new TranscriptionError(
        "TRANSCRIPTION_ENGINE_UNAVAILABLE",
        `Whisper model SHA-256 or size mismatch for ${filename}.`,
        false,
        { cause: error },
      );
    }
    if (error.code === "HTTP") {
      return new TranscriptionError(
        "TRANSCRIPTION_ENGINE_UNAVAILABLE",
        error.message.replace("Model download", "Whisper model download"),
        true,
        { cause: error },
      );
    }
    if (error.code === "INTERRUPTED") {
      return new TranscriptionError(
        "TRANSCRIPTION_ENGINE_UNAVAILABLE",
        `Whisper model install was interrupted: ${error.message.replace(/^Model install was interrupted: /, "")}`,
        true,
        { cause: error },
      );
    }
    return new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", error.message, error.retryable, { cause: error });
  }
  return new TranscriptionError(
    "TRANSCRIPTION_ENGINE_UNAVAILABLE",
    `Whisper model install was interrupted: ${error instanceof Error ? error.message : String(error)}`,
    true,
    { cause: error },
  );
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
