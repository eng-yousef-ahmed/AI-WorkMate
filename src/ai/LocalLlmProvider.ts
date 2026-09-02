import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { TranscriptDocument } from "../domain/models";
import type { AIProcessRequest, AIProcessResult, AIProvider, AIProviderDescriptor } from "./AIProvider";
import { LocalLlmError } from "./LocalLlmErrors";
import { isGgufModelMagic } from "./LocalLlmModelFormat";
import { getLocalLlmModelCatalogEntry } from "./LocalLlmRuntimeCatalog";

const PROVIDER_ID = "local-llama-cpp";
const DEFAULT_TIMEOUT_MS = 180_000;
const ALLOWED_CLI_NAMES = new Set(["llama-cli.exe", "llama-cli", "main.exe"]);
const MODEL_NAMES = ["qwen2.5-0.5b-instruct-q4_k_m.gguf"];

export interface LocalLlmHelperExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface LocalLlmHelperProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  exited: Promise<LocalLlmHelperExit>;
  kill(signal?: NodeJS.Signals | string): void;
}

export type LocalLlmHelperRunner = (args: readonly string[]) => LocalLlmHelperProcess;

export interface LocalLlmProviderOptions {
  platform?: NodeJS.Platform | string;
  helperPath?: string;
  modelPath?: string;
  helperRunner?: LocalLlmHelperRunner;
  timeoutMs?: number;
  localAppData?: string;
  clock?: () => Date;
  signal?: AbortSignal;
}

/**
 * Production local AI: llama.cpp CLI on the user's machine. Transcript content
 * never leaves the process. Missing CLI/model fail closed. No invented text.
 */
export class LocalLlmProvider implements AIProvider {
  public readonly descriptor: AIProviderDescriptor = {
    id: PROVIDER_ID,
    displayName: "Local llama.cpp",
    kind: "LOCAL",
    dataTransmission: "Transcript content stays in the desktop process. No cloud AI is used.",
  };

  private readonly platform: NodeJS.Platform | string;
  private readonly helperPathOverride: string | undefined;
  private readonly modelPathOverride: string | undefined;
  private readonly helperRunner: LocalLlmHelperRunner | undefined;
  private readonly timeoutMs: number;
  private readonly localAppData: string | undefined;
  private readonly clock: () => Date;
  private readonly abortSignal: AbortSignal | undefined;

  public constructor(options: LocalLlmProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.helperPathOverride = options.helperPath;
    this.modelPathOverride = options.modelPath;
    this.helperRunner = options.helperRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    this.clock = options.clock ?? (() => new Date());
    this.abortSignal = options.signal;
  }

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    const abortSignal = this.abortSignal;
    if (abortSignal !== undefined && abortSignal.aborted) {
      throw new LocalLlmError("ANALYSIS_CANCELLED", "Local LLM analysis was cancelled before the runtime started.", true);
    }
    if (this.platform !== "win32" && this.helperRunner === undefined) {
      throw new LocalLlmError(
        "ANALYSIS_ENGINE_UNAVAILABLE",
        `Local llama.cpp analysis is unavailable on platform ${this.platform}.`,
        false,
      );
    }
    const transcriptJson = typeof request.content === "string" ? request.content : Buffer.from(request.content).toString("utf8");
    const transcript = parseTranscriptJson(transcriptJson, request.meetingId);
    const cliPath = await this.resolveCliPath();
    const modelPath = await this.resolveModelPath();
    const prompt = buildAnalysisPrompt(transcript, this.clock().toISOString());
    const args = buildLlamaCliArgs(modelPath, prompt);
    const runner = this.helperRunner ?? createSpawnRunner(cliPath);
    const child = runner(args);
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal !== undefined && abortSignal.aborted) {
      child.kill("SIGTERM");
    }
    try {
      const stdout = collectText(child.stdout);
      const stderr = collectText(child.stderr);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new LocalLlmError("ANALYSIS_ENGINE_TIMEOUT", `Local llama.cpp timed out after ${this.timeoutMs}ms.`, true));
        }, this.timeoutMs);
      });
      const exit = await Promise.race([child.exited, timeoutPromise]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
      if (abortSignal !== undefined && abortSignal.aborted) {
        throw new LocalLlmError("ANALYSIS_CANCELLED", "Local LLM analysis was cancelled.", true);
      }
      if (exit.code !== 0) {
        throw new LocalLlmError(
          "ANALYSIS_ENGINE_CRASHED",
          `Local llama.cpp exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}${stderrText.trim() ? `: ${stderrText.trim()}` : "."}`,
          true,
        );
      }
      const output = extractJsonObject(stdoutText);
      return {
        providerId: this.descriptor.id,
        output,
        processedAt: this.clock().toISOString(),
        persistedByProvider: false,
      };
    } catch (error: unknown) {
      if (error instanceof LocalLlmError) {
        throw error;
      }
      throw new LocalLlmError("ANALYSIS_ENGINE_FAILED", error instanceof Error ? error.message : String(error), true, { cause: error });
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async resolveCliPath(): Promise<string> {
    if (this.helperRunner !== undefined) {
      return "injected-llama-helper";
    }
    const candidates = this.helperPathOverride === undefined
      ? llamaCliCandidates(this.localAppData)
      : [assertSafeHelperPath(this.helperPathOverride)];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next packaged or user-installed llama.cpp location.
      }
    }
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_UNAVAILABLE",
      "llama.cpp CLI was not found. Install llama-cli.exe under %LOCALAPPDATA%\\AI-WorkMate\\native\\.",
      false,
    );
  }

  private async resolveModelPath(): Promise<string> {
    if (this.helperRunner !== undefined && this.modelPathOverride === undefined) {
      return "injected-llama-model.gguf";
    }
    const candidates = this.modelPathOverride === undefined
      ? llamaModelCandidates(this.localAppData)
      : [assertSafeModelPath(this.modelPathOverride)];
    for (const candidate of candidates) {
      try {
        await assertUsableLocalLlmModelFile(candidate);
        return candidate;
      } catch (error: unknown) {
        if (error instanceof LocalLlmError && error.code === "ANALYSIS_PATH_REJECTED") {
          throw error;
        }
        if (this.modelPathOverride !== undefined && error instanceof LocalLlmError) {
          throw error;
        }
      }
    }
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_UNAVAILABLE",
      "No local GGUF instruct model was found. Place qwen2.5-0.5b-instruct-q4_k_m.gguf in %LOCALAPPDATA%\\AI-WorkMate\\models\\llm\\.",
      false,
    );
  }
}

export function llamaCliCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const names = ["llama-cli.exe", "llama-cli"];
  const roots = [
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-llm")] : []),
    resolve(__dirname, "..", "..", "native", "windows-llm"),
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "native")] : []),
  ];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

export function llamaModelCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const roots = [
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "models", "llm")] : []),
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-llm", "models")] : []),
  ];
  return roots.flatMap((root) => MODEL_NAMES.map((name) => join(root, name)));
}

export async function resolveWindowsLlamaCliPath(helperPath?: string, localAppData = process.env.LOCALAPPDATA): Promise<string | undefined> {
  const candidates = helperPath === undefined ? llamaCliCandidates(localAppData) : [assertSafeHelperPath(helperPath)];
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

export async function resolveWindowsLlamaModelPath(modelPath?: string, localAppData = process.env.LOCALAPPDATA): Promise<string | undefined> {
  const candidates = modelPath === undefined ? llamaModelCandidates(localAppData) : [assertSafeModelPath(modelPath)];
  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile() && fileStat.size >= 64) {
        return candidate;
      }
    } catch {
      // Continue.
    }
  }
  return undefined;
}

export async function assertUsableLocalLlmModelFile(modelPath: string): Promise<{ sha256: string; bytes: number }> {
  const fileStat = await stat(modelPath);
  if (!fileStat.isFile() || fileStat.size < 64) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model file is missing or truncated.", false);
  }
  const header = Buffer.alloc(4);
  const handle = await import("node:fs/promises").then((fs) => fs.open(modelPath, "r"));
  try {
    await handle.read(header, 0, 4, 0);
  } finally {
    await handle.close();
  }
  if (!isGgufModelMagic(header)) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model is not a GGUF file.", false);
  }
  const contents = await readFile(modelPath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const catalog = getLocalLlmModelCatalogEntry(basename(modelPath));
  if (catalog !== undefined && (catalog.sha256 !== sha256 || catalog.bytes !== contents.byteLength)) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model SHA-256 does not match the allowlisted catalog.", false);
  }
  return { sha256, bytes: contents.byteLength };
}

/**
 * llama.cpp b10621+ removed `-no-cnv` (ggml-org/llama.cpp#27542). One-shot
 * completion uses `-p` without conversation flags.
 */
export function buildLlamaCliArgs(modelPath: string, prompt: string): readonly string[] {
  return [
    "-m",
    modelPath,
    "-n",
    "768",
    "--temp",
    "0",
    "--top-k",
    "1",
    "-ngl",
    "0",
    "--no-display-prompt",
    "-p",
    prompt,
  ];
}

export function buildAnalysisPrompt(transcript: TranscriptDocument, createdAt: string): string {
  const transcriptJson = JSON.stringify({
    meetingId: transcript.meetingId,
    language: transcript.language,
    segments: transcript.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text })),
  });
  return [
    "You analyze a committed meeting transcript locally.",
    "Use only this transcript. Do not invent attendees, decisions, or tasks that are not stated.",
    "If a field is unknown, use an empty array.",
    "Reply with a single JSON object and no other text.",
    "Required keys: meetingId, createdAt, summary, decisions, tasks, risks, questions, followups.",
    `meetingId must be exactly ${transcript.meetingId}.`,
    `createdAt must be ${createdAt}.`,
    "summary is a string. decisions is [{decisionId, text}]. tasks is [{taskId, text, status}].",
    "risks, questions, and followups are string arrays.",
    "Transcript JSON:",
    transcriptJson,
  ].join(" ");
}

function parseTranscriptJson(content: string, expectedMeetingId: string): TranscriptDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error: unknown) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Committed transcript JSON is malformed.", false, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Committed transcript JSON is not an object.", false);
  }
  const document = parsed as TranscriptDocument;
  if (document.meetingId !== expectedMeetingId) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Transcript meeting ID does not match the analysis request.", false);
  }
  if (!Array.isArray(document.segments) || document.segments.length === 0) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Committed transcript has no segments.", false);
  }
  return document;
}

export function extractJsonObject(stdout: string): string {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Local llama.cpp produced no JSON object.", false);
  }
  const candidate = stdout.slice(start, end + 1);
  try {
    JSON.parse(candidate);
  } catch (error: unknown) {
    throw new LocalLlmError("ANALYSIS_ENGINE_INVALID_OUTPUT", "Local llama.cpp stdout is not valid JSON.", false, { cause: error });
  }
  return candidate;
}

function assertSafeHelperPath(helperPath: string): string {
  if (!helperPath.trim() || helperPath.includes("\0") || helperPath.includes("..")) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local llama.cpp path is invalid.", false);
  }
  const absolute = isAbsolute(helperPath) ? resolve(helperPath) : resolve(helperPath);
  if (!ALLOWED_CLI_NAMES.has(basename(absolute).toLowerCase())) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM helper must be llama-cli.exe or llama-cli.", false);
  }
  if (dirname(absolute) === absolute) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local llama.cpp path must point to an executable file.", false);
  }
  return absolute;
}

function assertSafeModelPath(modelPath: string): string {
  if (!modelPath.trim() || modelPath.includes("\0") || modelPath.includes("..")) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM model path is invalid.", false);
  }
  const absolute = isAbsolute(modelPath) ? resolve(modelPath) : resolve(modelPath);
  if (!basename(absolute).toLowerCase().endsWith(".gguf")) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM model must be a .gguf file.", false);
  }
  return absolute;
}

function createSpawnRunner(helperPath: string): LocalLlmHelperRunner {
  return (args) => {
    const child = spawn(helperPath, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise<LocalLlmHelperExit>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      kill: (signal?: NodeJS.Signals | string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
  };
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
