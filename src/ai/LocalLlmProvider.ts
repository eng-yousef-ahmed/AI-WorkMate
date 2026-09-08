import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { TranscriptDocument } from "../domain/models";
import type { AIProcessRequest, AIProcessResult, AIProvider, AIProviderDescriptor } from "./AIProvider";
import { ANALYSIS_DOCUMENT_JSON_SCHEMA } from "./AnalysisDocument";
import { LocalLlmError } from "./LocalLlmErrors";
import { isGgufModelMagic } from "./LocalLlmModelFormat";
import {
  catalogLocalLlmPrimaryFilenames,
  getLocalLlmModelCatalogEntry,
  getSelectedLocalLlmModelCatalogEntry,
} from "./LocalLlmRuntimeCatalog";

const PROVIDER_ID = "local-llama-cpp";
/** Fail-closed wall clock. 7B CPU JSON decode should finish well under this once we cap `-n` and skip re-hashing 4.7GB on spawn. */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 900_000;
/**
 * Quality-valid minified AnalysisDocument is ~1056 bytes (~333 Qwen tokens at
 * the Windows 3.18 bytes/token rate). Pretty JSON is ~1339 bytes (~422 tokens).
 * 480 is ~44% over minified and ~14% over pretty. The 1528-byte truncated 7B
 * run was unbounded string fields, not a missing schema member.
 */
export const LOCAL_LLM_MAX_PREDICT_TOKENS = 480;
const CONTEXT_TOKENS = 2048;
const CPU_BATCH_SIZE = 256;
const MAX_CPU_THREADS = 8;
const ALLOWED_CLI_NAMES = new Set([
  "llama-completion.exe",
  "llama-completion",
  "llama-cli.exe",
  "llama-cli",
  "main.exe",
]);


export interface LocalLlmHelperExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface LocalLlmHelperProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  exited: Promise<LocalLlmHelperExit>;
  kill(signal?: NodeJS.Signals | string): void;
  closeStdin?(): void;
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
    this.timeoutMs = resolveLocalLlmTimeoutMs(options.timeoutMs);
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
    const helperName = basename(cliPath);
    const args = buildLlamaCliArgs(modelPath, prompt, helperName);
    const runner = this.helperRunner ?? createSpawnRunner(cliPath);
    const child = runner(args);
    child.closeStdin?.();
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
          reject(
            new LocalLlmError(
              "ANALYSIS_ENGINE_TIMEOUT",
              `Local llama.cpp (${helperName}) timed out after ${this.timeoutMs}ms without exiting one-shot generation.`,
              true,
            ),
          );
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
      const output = extractJsonObject(stdoutText, stderrText);
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
      "llama.cpp CLI was not found. Install llama-completion.exe or llama-cli.exe under %LOCALAPPDATA%\\AI-WorkMate\\native\\.",
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
        await assertReadyLocalLlmModelFile(candidate);
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
      "No local GGUF instruct model was found. Install the catalogued Qwen2.5-7B-Instruct Q4_K_M shards under %LOCALAPPDATA%\\AI-WorkMate\\models\\llm\\.",
      false,
    );
  }
}

export function llamaCliCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const names = ["llama-completion.exe", "llama-completion", "llama-cli.exe", "llama-cli"];
  const roots = [
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-llm")] : []),
    resolve(__dirname, "..", "..", "native", "windows-llm"),
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "native")] : []),
  ];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
}

export function llamaModelCandidates(localAppData = process.env.LOCALAPPDATA): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  const selected = getSelectedLocalLlmModelCatalogEntry();
  const names = [selected.filename, ...catalogLocalLlmPrimaryFilenames().filter((name) => name !== selected.filename)];
  const roots = [
    ...(typeof localAppData === "string" && localAppData.length > 0 ? [join(localAppData, "AI-WorkMate", "models", "llm")] : []),
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-llm", "models")] : []),
  ];
  return roots.flatMap((root) => names.map((name) => join(root, name)));
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
      if (!fileStat.isFile() || fileStat.size < 64) {
        continue;
      }
      const catalog = getLocalLlmModelCatalogEntry(basename(candidate));
      if (catalog !== undefined) {
        const directory = dirname(candidate);
        let complete = true;
        for (const file of catalog.files) {
          try {
            const shard = await stat(join(directory, file.filename));
            if (!shard.isFile() || shard.size < 64) {
              complete = false;
              break;
            }
          } catch {
            complete = false;
            break;
          }
        }
        if (!complete) {
          continue;
        }
      }
      return candidate;
    } catch {
      // Continue.
    }
  }
  return undefined;
}

export async function assertReadyLocalLlmModelFile(modelPath: string): Promise<void> {
  const catalog = getLocalLlmModelCatalogEntry(basename(modelPath));
  const files = catalog?.files ?? [{ filename: basename(modelPath), bytes: 64, sha256: "", url: "" }];
  const directory = dirname(modelPath);
  for (const file of files) {
    const shardPath = join(directory, file.filename);
    const fileStat = await stat(shardPath);
    if (!fileStat.isFile() || fileStat.size < 64) {
      throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model file is missing or truncated.", false);
    }
    if (catalog !== undefined && fileStat.size !== file.bytes) {
      throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model size does not match the allowlisted catalog.", false);
    }
    const header = Buffer.alloc(4);
    const handle = await open(shardPath, "r");
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (!isGgufModelMagic(header)) {
      throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model is not a GGUF file.", false);
    }
  }
}

export async function assertUsableLocalLlmModelFile(modelPath: string): Promise<{ sha256: string; bytes: number }> {
  await assertReadyLocalLlmModelFile(modelPath);
  const catalog = getLocalLlmModelCatalogEntry(basename(modelPath));
  const directory = dirname(modelPath);
  if (catalog !== undefined) {
    let primarySha256 = "";
    let primaryBytes = 0;
    for (const file of catalog.files) {
      const hashed = await hashLocalLlmFile(join(directory, file.filename));
      if (hashed.sha256 !== file.sha256 || hashed.bytes !== file.bytes) {
        throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model SHA-256 does not match the allowlisted catalog.", false);
      }
      if (file.filename === catalog.filename) {
        primarySha256 = hashed.sha256;
        primaryBytes = hashed.bytes;
      }
    }
    return { sha256: primarySha256, bytes: primaryBytes };
  }
  const hashed = await hashLocalLlmFile(modelPath);
  return { sha256: hashed.sha256, bytes: hashed.bytes };
}

export async function hashLocalLlmFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "Local LLM model file is missing or truncated.", false);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      bytes += buffer.byteLength;
    });
    stream.on("error", reject);
    stream.on("end", () => resolveHash());
  });
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * b10621 one-shot: `llama-completion -m MODEL --single-turn -p PROMPT`.
 * Chat is the default without `--single-turn`. Leaving stdin open then waits
 * for the next turn until our timeout. Prompt is `-p` (not stdin). Do not use
 * `-no-cnv` (removed from llama-cli; avoid it on both binaries).
 */
export function localLlmCpuThreadCount(available = availableParallelism()): number {
  if (!Number.isFinite(available) || available < 1) {
    return 1;
  }
  return Math.min(MAX_CPU_THREADS, Math.floor(available));
}

/**
 * b10621 one-shot: `llama-completion -m MODEL --single-turn -p PROMPT`.
 * `-m` is the first split shard; llama.cpp loads `00002-of-00002` beside it.
 * `-n` is capped so 7B CPU constrained JSON cannot spend the whole timeout
 * generating filler. Threads/batch/ctx are explicit CPU settings.
 * Do not use `-no-cnv`.
 */
export function buildLlamaCliArgs(modelPath: string, prompt: string, _helperName = "llama-cli.exe"): readonly string[] {
  const threads = String(localLlmCpuThreadCount());
  return [
    "-m",
    modelPath,
    "-n",
    String(LOCAL_LLM_MAX_PREDICT_TOKENS),
    "-c",
    String(CONTEXT_TOKENS),
    "-t",
    threads,
    "-tb",
    threads,
    "-b",
    String(CPU_BATCH_SIZE),
    "--temp",
    "0",
    "--top-k",
    "1",
    "-ngl",
    "0",
    "--no-display-prompt",
    "--single-turn",
    "--json-schema",
    JSON.stringify(ANALYSIS_DOCUMENT_JSON_SCHEMA),
    "-p",
    prompt,
  ];
}

export function resolveLocalLlmTimeoutMs(requested?: number, envValue = process.env.AI_WORKMATE_LOCAL_LLM_TIMEOUT_MS): number {
  const fromEnv = envValue === undefined || envValue.trim() === "" ? undefined : Number(envValue);
  const candidate = requested ?? (fromEnv !== undefined && Number.isFinite(fromEnv) ? fromEnv : DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(candidate), MAX_TIMEOUT_MS);
}

export function buildAnalysisPrompt(transcript: TranscriptDocument, createdAt: string): string {
  const names = new Map(transcript.speakers.map((speaker) => [speaker.speakerId, speaker.displayName ?? speaker.speakerId]));
  const dialogue = transcript.segments.map((segment) => {
    if (segment.speakerId === undefined) {
      // Speaker-less segments (e.g. local Whisper output) carry no speaker
      // identity; render them as bare transcript lines so no phantom
      // participant name is introduced into the dialogue.
      return segment.text;
    }
    const speaker = names.get(segment.speakerId) ?? segment.speakerId;
    return `${speaker}: ${segment.text}`;
  }).join("\n");
  return [
    "Return minified JSON only: one object, no extra spaces or newlines, no markdown, no commentary.",
    "Do not invent people, dates, decisions, or tasks. Do not paste the full transcript into any field.",
    "Lines without a name prefix have no speaker label; never treat a line prefix or a bracketed source tag such as [Microphone] or [System Audio] as a person.",
    "Use an owner or assignee only when that name is actually spoken/present in the transcript; otherwise omit the owner/assignee field.",
    "Every numbered decision in the transcript (Decision 1, Decision 2, Decision 3, ...) becomes its own separate decision object; never merge multiple decisions into one decision.",
    "Each owner or assignee contains at most one person; if no single owner is clearly stated, omit the owner/assignee field. Preserve important decision and task wording from the transcript.",
    "If the transcript contains Decision 1, Decision 2, Decision 3, create one separate decisions[] object for EACH numbered decision; never combine two numbered decisions into one object. The number of decision objects must match the numbered decisions in the transcript; preserve each numbered decision's important wording instead of summarizing several decisions into one sentence.",
    "owner and assignee are optional: NEVER output \"N/A\", \"NA\", \"n/a\", \"unknown\", \"none\", \"null\", \"not specified\", or similar placeholder text as an owner or assignee; omit the field when no single person is clearly assigned. Never combine multiple people into one owner/assignee string; a comma-separated list of people is invalid for owner/assignee. Keep each task's own wording and set a single assignee only when the transcript clearly assigns that task to one person.",
    "Summary: one sentence that names this meeting, states its main decision, and mentions the product or system the meeting is about, using the names as they appear in the transcript.",
    "Short ids d1/t1. One short sentence per decision and task, using the speakers' words for systems, owners, and dates.",
    "Questions are not decisions. Omit optional keys or use [] when unstated.",
    `meetingId=${transcript.meetingId}`,
    `createdAt=${createdAt}`,
    "Fields: summary, decisions[{decisionId,text,owner?}], tasks[{taskId,text,assignee?,dueDate?,status?}], risks[], questions[], followups[].",
    "Transcript:",
    dialogue,
  ].join("\n");
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

export function extractJsonObject(stdout: string, stderr = ""): string {
  const text = stripBomAndAnsi(stdout);
  const fenced = unwrapSingleMarkdownFence(text);
  const start = fenced.indexOf("{");
  if (start < 0) {
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_INVALID_OUTPUT",
      `Local llama.cpp produced no JSON object (${describeLlamaStdout(text, stderr)}).`,
      false,
    );
  }
  const extracted = extractBalancedJsonObject(fenced, start);
  if (extracted === undefined) {
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_INVALID_OUTPUT",
      `Local llama.cpp JSON object is truncated or unbalanced (${describeLlamaStdout(text, stderr)}).`,
      false,
    );
  }
  try {
    JSON.parse(extracted);
  } catch (error: unknown) {
    throw new LocalLlmError(
      "ANALYSIS_ENGINE_INVALID_OUTPUT",
      `Local llama.cpp stdout is not valid JSON (${describeLlamaStdout(text, stderr)}).`,
      false,
      { cause: error },
    );
  }
  return extracted;
}

export function describeLlamaStdout(stdout: string, stderr = ""): string {
  const text = stripBomAndAnsi(stdout);
  const logs = stripBomAndAnsi(stderr);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const kinds: string[] = [];
  if (/```/.test(text)) {
    kinds.push("markdown-fence");
  }
  if (/(?:^|\s)(?:llama_|ggml_|print_info|load_tensors|system_info)/i.test(`${text}\n${logs}`)) {
    kinds.push("runtime-log");
  }
  if (looksLikePredictLimit(`${text}\n${logs}`)) {
    kinds.push("hit-n-limit");
  }
  if (start < 0) {
    kinds.push("no-object");
  } else if (extractBalancedJsonObject(text, start) === undefined) {
    kinds.push("truncated-object");
  } else {
    kinds.push("complete-object");
  }
  const cursor = describeJsonCursor(text);
  return `nPredict=${LOCAL_LLM_MAX_PREDICT_TOKENS} bytes=${Buffer.byteLength(text, "utf8")} firstBrace=${start} lastBrace=${end} cursor=${cursor} ${kinds.join(",") || "empty"}`;
}

/**
 * Path into a truncated JSON object (keys/indexes only — never string values).
 */
export function describeJsonCursor(stdout: string): string {
  const start = stdout.indexOf("{");
  if (start < 0) {
    return "none";
  }
  const path: string[] = ["$"];
  let depth = 0;
  let inString = false;
  let escape = false;
  let expectingKey = false;
  let currentKey = "";
  let collectingKey = false;
  const arrayIndex: number[] = [];
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index] ?? "";
    if (inString) {
      if (escape) {
        escape = false;
        if (collectingKey) {
          currentKey += char;
        }
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
        if (collectingKey) {
          collectingKey = false;
          path.push(currentKey);
          expectingKey = false;
        }
      } else if (collectingKey && currentKey.length < 40) {
        currentKey += char;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      if (expectingKey) {
        collectingKey = true;
        currentKey = "";
      }
      continue;
    }
    if (char === "{") {
      depth += 1;
      expectingKey = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      arrayIndex.push(0);
      path.push("0");
      expectingKey = false;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (path.length > 1 && !/^\d+$/.test(path[path.length - 1] ?? "")) {
        path.pop();
      }
      expectingKey = false;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      arrayIndex.pop();
      if (path.length > 1 && /^\d+$/.test(path[path.length - 1] ?? "")) {
        path.pop();
      }
      expectingKey = false;
      continue;
    }
    if (char === ",") {
      if (arrayIndex.length > 0 && path[path.length - 1] !== undefined && /^\d+$/.test(path[path.length - 1] ?? "")) {
        const next = (arrayIndex[arrayIndex.length - 1] ?? 0) + 1;
        arrayIndex[arrayIndex.length - 1] = next;
        path[path.length - 1] = String(next);
        expectingKey = false;
      } else {
        if (path.length > 1 && !/^\d+$/.test(path[path.length - 1] ?? "")) {
          path.pop();
        }
        expectingKey = true;
      }
      continue;
    }
    if (char === ":") {
      expectingKey = false;
    }
  }
  return `${path.join(".")} depth=${depth} inString=${inString ? "1" : "0"}`;
}

function looksLikePredictLimit(logs: string): boolean {
  return /n_remain\s*=\s*0|stopped by limit|hit.*n_predict|n_predict.*reached/i.test(logs);
}

function stripBomAndAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(/^\uFEFF/, "").split(escape).map((part, index) => {
    if (index === 0) {
      return part;
    }
    const end = part.search(/[A-Za-z]/);
    return end >= 0 ? part.slice(end + 1) : part;
  }).join("");
}

function unwrapSingleMarkdownFence(value: string): string {
  const match = value.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  return match?.[1] ?? value;
}

function extractBalancedJsonObject(value: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}

function assertSafeHelperPath(helperPath: string): string {
  if (!helperPath.trim() || helperPath.includes("\0") || helperPath.includes("..")) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local llama.cpp path is invalid.", false);
  }
  const absolute = isAbsolute(helperPath) ? resolve(helperPath) : resolve(helperPath);
  if (!ALLOWED_CLI_NAMES.has(basename(absolute).toLowerCase())) {
    throw new LocalLlmError("ANALYSIS_PATH_REJECTED", "Local LLM helper must be llama-completion.exe or llama-cli.exe.", false);
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
      stdio: ["pipe", "pipe", "pipe"],
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
        child.kill(signal === "SIGINT" ? "SIGTERM" : (signal as NodeJS.Signals | undefined));
      },
      closeStdin: () => {
        child.stdin?.end();
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
