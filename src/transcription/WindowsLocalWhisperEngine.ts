import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { TranscriptSegment } from "../domain/models";
import { prepareWhisperWav } from "./PrepareWhisperAudio";
import {
  TranscriptionError,
  type TranscriptionEngine,
  type TranscriptionEngineDescriptor,
  type TranscriptionEngineResult,
  type TranscriptionRequest,
} from "./TranscriptionEngine";

const ENGINE_ID = "windows-local-whisper";
const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_CLI_NAMES = new Set(["whisper-cli.exe", "whisper.exe", "main.exe"]);
const MODEL_NAMES = ["ggml-tiny.bin", "ggml-tiny.en.bin", "ggml-base.bin", "ggml-base.en.bin", "ggml-small.bin"];

export interface WhisperHelperExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface WhisperHelperProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  exited: Promise<WhisperHelperExit>;
  kill(signal?: NodeJS.Signals | string): void;
}

export type WhisperHelperRunner = (args: readonly string[]) => WhisperHelperProcess;

export interface WindowsLocalWhisperEngineOptions {
  platform?: NodeJS.Platform | string;
  helperPath?: string;
  modelPath?: string;
  helperRunner?: WhisperHelperRunner;
  timeoutMs?: number;
  localAppData?: string;
}

/**
 * Production local STT: whisper.cpp CLI on the user's machine. Audio never
 * leaves the process. Missing CLI/model fail closed. No speaker diarization.
 */
export class WindowsLocalWhisperEngine implements TranscriptionEngine {
  public readonly descriptor: TranscriptionEngineDescriptor = {
    id: ENGINE_ID,
    displayName: "Windows local whisper.cpp",
    kind: "LOCAL",
  };

  private readonly platform: NodeJS.Platform | string;
  private readonly helperPathOverride: string | undefined;
  private readonly modelPathOverride: string | undefined;
  private readonly helperRunner: WhisperHelperRunner | undefined;
  private readonly timeoutMs: number;
  private readonly localAppData: string | undefined;

  public constructor(options: WindowsLocalWhisperEngineOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.helperPathOverride = options.helperPath;
    this.modelPathOverride = options.modelPath;
    this.helperRunner = options.helperRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  }

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    if (request.signal !== undefined && request.signal.aborted) {
      throw new TranscriptionError("TRANSCRIPTION_CANCELLED", "Transcription was cancelled before the local engine started.", true);
    }
    if (this.platform !== "win32" && this.helperRunner === undefined) {
      throw new TranscriptionError(
        "TRANSCRIPTION_ENGINE_UNAVAILABLE",
        `Local whisper.cpp speech-to-text is unavailable on platform ${this.platform}.`,
        false,
      );
    }
    const wav = prepareWhisperWav(request.audio);
    const cliPath = await this.resolveCliPath();
    const modelPath = await this.resolveModelPath();
    const workDir = await mkdtemp(join(tmpdir(), "ai-workmate-whisper-"));
    const wavPath = join(workDir, "audio.wav");
    const outputBase = join(workDir, "audio");
    await writeFile(wavPath, wav);
    const args = ["-m", modelPath, "-f", wavPath, "-oj", "-of", outputBase, "-l", request.language ?? "auto", "--no-prints"];
    const runner = this.helperRunner ?? createSpawnRunner(cliPath);
    const child = runner(args);
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal !== undefined && request.signal.aborted) {
      child.kill("SIGTERM");
    }
    try {
      const stdout = collectText(child.stdout);
      const stderr = collectText(child.stderr);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new TranscriptionError("TRANSCRIPTION_ENGINE_TIMEOUT", `Local whisper.cpp timed out after ${this.timeoutMs}ms.`, true));
        }, this.timeoutMs);
      });
      const exit = await Promise.race([child.exited, timeoutPromise]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
      if (request.signal !== undefined && request.signal.aborted) {
        throw new TranscriptionError("TRANSCRIPTION_CANCELLED", "Transcription was cancelled.", true);
      }
      if (exit.code !== 0) {
        throw new TranscriptionError(
          "TRANSCRIPTION_ENGINE_CRASHED",
          `Local whisper.cpp exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}${stderrText.trim() ? `: ${stderrText.trim()}` : "."}`,
          true,
        );
      }
      const parsed = await parseWhisperOutput(stdoutText, `${outputBase}.json`);
      if (parsed.segments.length === 0 || parsed.segments.every((segment) => segment.text.trim().length === 0)) {
        throw new TranscriptionError("TRANSCRIPTION_ENGINE_INVALID_OUTPUT", "Local whisper.cpp returned no transcript text.", false);
      }
      const result: TranscriptionEngineResult = {
        meetingId: request.meetingId,
        recordingId: request.recordingId,
        language: parsed.language,
        speakers: [],
        timestamps: true,
        segments: parsed.segments,
        engine: {
          ...this.descriptor,
          model: basename(modelPath),
        },
      };
      if (request.sourceRecordingSha256 !== undefined) {
        result.sourceRecordingSha256 = request.sourceRecordingSha256;
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof TranscriptionError) {
        throw error;
      }
      throw new TranscriptionError("TRANSCRIPTION_ENGINE_FAILED", error instanceof Error ? error.message : String(error), true, { cause: error });
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async resolveCliPath(): Promise<string> {
    if (this.helperRunner !== undefined) {
      return "injected-whisper-helper";
    }
    const candidates = this.helperPathOverride === undefined ? whisperCliCandidates(this.localAppData) : [assertSafeHelperPath(this.helperPathOverride)];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next packaged or user-installed whisper.cpp location.
      }
    }
    throw new TranscriptionError(
      "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      "whisper.cpp CLI was not found. Install whisper-cli.exe under %LOCALAPPDATA%\\AI-WorkMate\\native\\ or as an Electron extra resource.",
      false,
    );
  }

  private async resolveModelPath(): Promise<string> {
    if (this.helperRunner !== undefined && this.modelPathOverride === undefined) {
      return "injected-whisper-model.bin";
    }
    const candidates = this.modelPathOverride === undefined ? whisperModelCandidates(this.localAppData) : [assertSafeModelPath(this.modelPathOverride)];
    for (const candidate of candidates) {
      try {
        const bytes = await readFile(candidate);
        if (bytes.byteLength < 64) {
          throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", `Whisper model is empty or truncated: ${basename(candidate)}.`, false);
        }
        const magic = bytes.subarray(0, 4).toString("ascii");
        if (magic !== "ggml" && magic !== "gguf") {
          throw new TranscriptionError("TRANSCRIPTION_ENGINE_UNAVAILABLE", `Whisper model is not a ggml/gguf file: ${basename(candidate)}.`, false);
        }
        return candidate;
      } catch (error: unknown) {
        if (error instanceof TranscriptionError) {
          throw error;
        }
      }
    }
    throw new TranscriptionError(
      "TRANSCRIPTION_ENGINE_UNAVAILABLE",
      "No local Whisper ggml/gguf model was found. Place ggml-tiny.bin in %LOCALAPPDATA%\\AI-WorkMate\\models\\whisper\\.",
      false,
    );
  }
}

export function whisperCliCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const names = ["whisper-cli.exe", "whisper.exe"];
  const roots = [
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-transcription")] : []),
    resolve(__dirname, "..", "..", "native", "windows-transcription"),
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "native")] : []),
  ];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

export function whisperModelCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const roots = [
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "models", "whisper")] : []),
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-transcription", "models")] : []),
  ];
  return roots.flatMap((root) => MODEL_NAMES.map((name) => join(root, name)));
}

export async function resolveWindowsWhisperCliPath(helperPath?: string, localAppData = process.env.LOCALAPPDATA): Promise<string | undefined> {
  const candidates = helperPath === undefined ? whisperCliCandidates(localAppData) : [assertSafeHelperPath(helperPath)];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return undefined;
}

export async function resolveWindowsWhisperModelPath(modelPath?: string, localAppData = process.env.LOCALAPPDATA): Promise<string | undefined> {
  const candidates = modelPath === undefined ? whisperModelCandidates(localAppData) : [assertSafeModelPath(modelPath)];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate);
      if (bytes.byteLength >= 64) {
        return candidate;
      }
    } catch {
      // Continue.
    }
  }
  return undefined;
}

function assertSafeHelperPath(helperPath: string): string {
  if (!helperPath.trim() || helperPath.includes("\0") || helperPath.includes("..")) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Local whisper.cpp path is invalid.", false);
  }
  const absolute = isAbsolute(helperPath) ? resolve(helperPath) : resolve(helperPath);
  if (!ALLOWED_CLI_NAMES.has(basename(absolute).toLowerCase())) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Local STT helper must be whisper-cli.exe or whisper.exe.", false);
  }
  if (dirname(absolute) === absolute) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Local whisper.cpp path must point to an executable file.", false);
  }
  return absolute;
}

function assertSafeModelPath(modelPath: string): string {
  if (!modelPath.trim() || modelPath.includes("\0") || modelPath.includes("..")) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Local Whisper model path is invalid.", false);
  }
  const absolute = isAbsolute(modelPath) ? resolve(modelPath) : resolve(modelPath);
  const name = basename(absolute).toLowerCase();
  if (!name.endsWith(".bin") && !name.endsWith(".gguf")) {
    throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Local Whisper model must be a .bin or .gguf file.", false);
  }
  return absolute;
}

function createSpawnRunner(helperPath: string): WhisperHelperRunner {
  return (args) => {
    const child = spawn(helperPath, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise<WhisperHelperExit>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      kill: (signal?: NodeJS.Signals | string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
  };
}

async function parseWhisperOutput(stdout: string, jsonPath: string): Promise<{ language: string; segments: TranscriptSegment[] }> {
  const candidates: unknown[] = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      candidates.push(JSON.parse(trimmed) as unknown);
    } catch (error: unknown) {
      throw new TranscriptionError("TRANSCRIPTION_ENGINE_INVALID_OUTPUT", `Local whisper.cpp stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, false, { cause: error });
    }
  }
  try {
    candidates.push(JSON.parse((await readFile(jsonPath)).toString("utf8")) as unknown);
  } catch {
    // stdout-only helpers (including tests) need not write a sidecar JSON file.
  }
  if (candidates.length === 0) {
    throw new TranscriptionError("TRANSCRIPTION_ENGINE_INVALID_OUTPUT", "Local whisper.cpp produced no JSON transcript.", false);
  }
  for (const candidate of candidates) {
    const mapped = mapWhisperJson(candidate);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  throw new TranscriptionError("TRANSCRIPTION_ENGINE_INVALID_OUTPUT", "Local whisper.cpp JSON did not contain transcript segments.", false);
}

function mapWhisperJson(value: unknown): { language: string; segments: TranscriptSegment[] } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.recordType === "error") {
    throw new TranscriptionError(
      typeof record.code === "string" ? mapHelperCode(record.code) : "TRANSCRIPTION_ENGINE_FAILED",
      typeof record.message === "string" ? record.message : "Local whisper helper reported an error.",
      record.retryable === true,
    );
  }
  const language = readLanguage(record);
  const rawSegments = Array.isArray(record.segments)
    ? record.segments
    : Array.isArray(record.transcription)
      ? record.transcription
      : undefined;
  if (rawSegments === undefined) {
    return undefined;
  }
  const segments: TranscriptSegment[] = [];
  rawSegments.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      return;
    }
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text.length === 0) {
      return;
    }
    const offsets = row.offsets as { from?: unknown; to?: unknown } | undefined;
    const startMs = numberOr(row.startMs, numberOr(offsets?.from, index * 1_000));
    const endMs = numberOr(row.endMs, numberOr(offsets?.to, startMs + 1_000));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || startMs < 0) {
      throw new TranscriptionError("TRANSCRIPTION_ENGINE_INVALID_OUTPUT", "Local whisper.cpp segment timestamps are invalid.", false);
    }
    const segment: TranscriptSegment = {
      segmentId: typeof row.segmentId === "string" ? row.segmentId : `whisper-${index + 1}`,
      startMs,
      endMs,
      text,
    };
    segments.push(segment);
  });
  return { language, segments };
}

function readLanguage(record: Record<string, unknown>): string {
  if (typeof record.language === "string" && record.language.trim()) {
    return record.language;
  }
  const result = record.result;
  if (typeof result === "object" && result !== null) {
    const language = (result as { language?: unknown }).language;
    if (typeof language === "string" && language.trim()) {
      return language;
    }
  }
  return "en";
}

function mapHelperCode(code: string): TranscriptionError["code"] {
  if (
    code === "TRANSCRIPTION_ENGINE_UNAVAILABLE" ||
    code === "TRANSCRIPTION_ENGINE_TIMEOUT" ||
    code === "TRANSCRIPTION_ENGINE_CRASHED" ||
    code === "TRANSCRIPTION_ENGINE_INVALID_OUTPUT" ||
    code === "TRANSCRIPTION_CANCELLED" ||
    code === "TRANSCRIPTION_PATH_REJECTED"
  ) {
    return code;
  }
  return "TRANSCRIPTION_ENGINE_FAILED";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function collectText(source: AsyncIterable<Uint8Array> | undefined): Promise<string> {
  if (source === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function stringRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

