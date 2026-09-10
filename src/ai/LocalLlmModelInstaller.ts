import { isAbsolute, join, resolve } from "node:path";

import { installVerifiedFile, ManagedInstallError } from "../runtime/ManagedModelInstall";
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
  replaceCorrupted?: boolean;
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
  alreadyVerified?: boolean;
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
  const transport = options.transport ?? httpsTransport();
  const installed: InstalledLocalLlmModelFile[] = [];
  let alreadyVerified = true;
  for (const file of entry.files) {
    const result = await installCatalogFile(directory, file, transport, options.replaceCorrupted === true);
    installed.push({ filename: result.filename, sha256: result.sha256, bytes: result.bytes });
    if (result.alreadyVerified !== true) {
      alreadyVerified = false;
    }
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
    relativeLocation: `%LOCALAPPDATA%\\\\AI-WorkMate\\\\models\\\\llm\\\\${primary.filename}`,
    splitGguf: entry.splitGguf,
    alreadyVerified,
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
  replaceCorrupted: boolean,
): Promise<InstalledLocalLlmModelFile & { alreadyVerified: boolean }> {
  try {
    return await installVerifiedFile({
      directory,
      file: { filename: file.filename, sha256: file.sha256, bytes: file.bytes, url: file.url },
      transport,
      ...(replaceCorrupted ? { replaceCorrupted: true } : {}),
    });
  } catch (error: unknown) {
    throw wrapLocalLlmInstallError(error, file.filename);
  }
}

function wrapLocalLlmInstallError(error: unknown, filename: string): LocalLlmError {
  if (error instanceof LocalLlmError) {
    return error;
  }
  if (error instanceof ManagedInstallError) {
    if (error.code === "PATH") {
      return new LocalLlmError("ANALYSIS_PATH_REJECTED", error.message, false, { cause: error });
    }
    if (error.code === "CHECKSUM") {
      return new LocalLlmError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        `Local LLM model SHA-256 or size mismatch for ${filename}.`,
        false,
        { cause: error },
      );
    }
    if (error.code === "HTTP") {
      return new LocalLlmError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        error.message.replace("Model download", "Local LLM model download"),
        true,
        { cause: error },
      );
    }
    if (error.code === "INTERRUPTED") {
      return new LocalLlmError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        `Local LLM model install was interrupted: ${error.message.replace(/^Model install was interrupted: /, "")}`,
        true,
        { cause: error },
      );
    }
    return new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", error.message, error.retryable, { cause: error });
  }
  return new LocalLlmError(
    "ANALYSIS_ENGINE_UNAVAILABLE",
    `Local LLM model install was interrupted: ${error instanceof Error ? error.message : String(error)}`,
    true,
    { cause: error },
  );
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
