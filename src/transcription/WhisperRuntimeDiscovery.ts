import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { isWhisperCppModelMagic } from "./WhisperModelFormat";
import { getWhisperModelCatalogEntry } from "./WhisperRuntimeCatalog";
import {
  resolveWindowsWhisperCliPath,
  resolveWindowsWhisperModelPath,
} from "./WindowsLocalWhisperEngine";
import { TranscriptionError } from "./TranscriptionEngine";

export interface WhisperRuntimeDiscovery {
  platform: NodeJS.Platform | string;
  helperFound: boolean;
  helperName?: string;
  modelFound: boolean;
  modelName?: string;
  modelSha256?: string;
  modelBytes?: number;
  modelChecksumOk?: boolean;
  engineVersion?: string;
  relativeHelperLocation?: string;
  relativeModelLocation?: string;
  failureCode?: string;
  failureMessage?: string;
}

export async function discoverWhisperRuntime(options: {
  platform?: NodeJS.Platform | string;
  localAppData?: string;
} = {}): Promise<WhisperRuntimeDiscovery> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      platform,
      helperFound: false,
      modelFound: false,
      failureCode: "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      failureMessage: `Local whisper.cpp verification requires win32, not ${platform}.`,
    };
  }
  const helperPath = await resolveWindowsWhisperCliPath(undefined, options.localAppData);
  const modelPath = await resolveWindowsWhisperModelPath(undefined, options.localAppData);
  const discovery: WhisperRuntimeDiscovery = {
    platform,
    helperFound: helperPath !== undefined,
    modelFound: false,
  };
  if (helperPath !== undefined) {
    discovery.helperName = basename(helperPath);
    discovery.relativeHelperLocation = `%LOCALAPPDATA%\\AI-WorkMate\\native\\${basename(helperPath)}`;
    if (platform === "win32") {
      discovery.engineVersion = await readWhisperVersion(helperPath);
    }
  }
  if (modelPath !== undefined) {
    const fileStat = await stat(modelPath);
    const header = Buffer.alloc(4);
    const handle = await open(modelPath, "r");
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    const catalog = getWhisperModelCatalogEntry(basename(modelPath));
    discovery.modelFound = true;
    discovery.modelName = basename(modelPath);
    discovery.modelBytes = fileStat.size;
    discovery.relativeModelLocation = `%LOCALAPPDATA%\\AI-WorkMate\\models\\whisper\\${basename(modelPath)}`;
    // Snapshot status uses size + magic only. SHA-256 of ggml-tiny (~78 MB)
    // is enforced at install; Settings must not re-hash the file on every
    // refresh. Engine use still fail-closes on a catalog mismatch.
    if (catalog !== undefined) {
      discovery.modelChecksumOk = catalog.bytes === fileStat.size && isWhisperCppModelMagic(header);
    }
    if (!isWhisperCppModelMagic(header)) {
      discovery.modelFound = false;
      discovery.failureCode = "TRANSCRIPTION_ENGINE_UNAVAILABLE";
      discovery.failureMessage = "Located model is not a whisper.cpp ggml/gguf file (little-endian GGML_FILE_MAGIC or GGUF).";
    }
  }
  if (platform !== "win32") {
    discovery.failureCode = "TRANSCRIPTION_ENGINE_UNAVAILABLE";
    discovery.failureMessage = `Local whisper.cpp verification requires win32, not ${platform}.`;
  } else if (!discovery.helperFound || !discovery.modelFound) {
    discovery.failureCode = "TRANSCRIPTION_ENGINE_UNAVAILABLE";
    discovery.failureMessage = "whisper-cli.exe or a ggml/gguf model was not found under the managed LocalAppData locations.";
  }
  return discovery;
}

export async function assertUsableWhisperModelFile(modelPath: string): Promise<{ sha256: string; bytes: number }> {
  const fileStat = await stat(modelPath);
  if (!fileStat.isFile() || fileStat.size < 64) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", "Whisper model file is missing or truncated.", false);
  }
  const contents = await readFile(modelPath);
  if (!isWhisperCppModelMagic(contents)) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", "Whisper model is not a whisper.cpp ggml/gguf file.", false);
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const catalog = getWhisperModelCatalogEntry(basename(modelPath));
  if (catalog !== undefined && (catalog.sha256 !== sha256 || catalog.bytes !== contents.byteLength)) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", "Whisper model SHA-256 does not match the allowlisted catalog.", false);
  }
  return { sha256, bytes: contents.byteLength };
}

async function readWhisperVersion(helperPath: string): Promise<string | undefined> {
  try {
    const child = spawn(helperPath, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("exit", (exitCode) => resolveExit(exitCode));
      child.once("error", () => resolveExit(null));
    });
    if (code !== 0) {
      return undefined;
    }
    const text = Buffer.concat(stdout).toString("utf8").trim();
    return text.length > 0 ? text.split(/\r?\n/)[0] : undefined;
  } catch {
    return undefined;
  }
}
