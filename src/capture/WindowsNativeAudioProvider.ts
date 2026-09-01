import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  NATIVE_CAPTURE_KINDS,
  NativeCaptureError,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureErrorCode,
  type NativeCaptureErrorInfo,
  type NativeCaptureKind,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
  unavailableCapability,
} from "./NativeCaptureAdapter";
import type { WindowsNativeCaptureProvider } from "./WindowsCaptureAdapter";

export const WINDOWS_AUDIO_CAPTURE_FORMAT = "aiwpcm";
export const WINDOWS_AUDIO_CAPTURE_MIME_TYPE = "application/x-ai-workmate-pcm-jsonl";

const AUDIO_KINDS = new Set<NativeCaptureKind>(["MICROPHONE_AUDIO", "SYSTEM_AUDIO"]);
const PROVIDER_ID = "windows-native-audio-provider";
const HELPER_TIMEOUT_MS = 10_000;

export interface WindowsAudioPcmFormat {
  container: "AIWPCM_JSONL";
  encoding: "PCM";
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  averageBytesPerSecond: number;
}

export interface WindowsAudioFormatRecord {
  recordType: "format";
  source: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">;
  sourceId?: string;
  sourceLabel?: string;
  startedAt: string;
  format: WindowsAudioPcmFormat;
}

export interface WindowsAudioChunkRecord {
  recordType: "chunk";
  sequence: number;
  timestamp: string;
  source: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">;
  sourceId?: string;
  format: WindowsAudioPcmFormat;
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

export type WindowsAudioCaptureRecord = WindowsAudioFormatRecord | WindowsAudioChunkRecord;

export interface WindowsAudioHelperExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface WindowsAudioHelperStdin {
  write(data: string | Uint8Array): boolean;
  end(): void;
}

export interface WindowsAudioHelperProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  stdin?: WindowsAudioHelperStdin;
  exited: Promise<WindowsAudioHelperExit>;
  kill(signal?: NodeJS.Signals | string): void;
}

export type WindowsAudioHelperRunner = (args: readonly string[]) => WindowsAudioHelperProcess;

export interface WindowsNativeAudioProviderOptions {
  platform?: NodeJS.Platform | string;
  helperPath?: string;
  helperRunner?: WindowsAudioHelperRunner;
  clock?: () => Date;
  helperTimeoutMs?: number;
}

interface HelperCapabilitiesPayload {
  checkedAt?: string;
  microphone?: HelperAudioDevice[];
  systemAudio?: HelperAudioDevice[];
  errors?: Partial<Record<"MICROPHONE_AUDIO" | "SYSTEM_AUDIO", HelperErrorPayload>>;
}

interface HelperAudioDevice {
  id: string;
  label: string;
  isDefault?: boolean;
}

interface HelperErrorPayload {
  code: NativeCaptureErrorCode;
  message: string;
  retryable?: boolean;
}

/**
 * Real Windows audio provider boundary. It shells out to the packaged Windows
 * audio helper, which uses WASAPI through NAudio/CoreAudio. The provider never
 * creates media bytes itself and requires actual helper output for media records.
 */
export class WindowsNativeAudioProvider implements WindowsNativeCaptureProvider {
  public readonly adapterId = PROVIDER_ID;
  private readonly platform: NodeJS.Platform | string;
  private readonly helperPaths: readonly string[];
  private readonly helperRunner: WindowsAudioHelperRunner | undefined;
  private readonly clock: () => Date;
  private readonly helperTimeoutMs: number;

  public constructor(options: WindowsNativeAudioProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.helperPaths = options.helperPath === undefined ? defaultHelperCandidates() : [normalizeHelperPath(options.helperPath)];
    this.helperRunner = options.helperRunner;
    this.clock = options.clock ?? (() => new Date());
    this.helperTimeoutMs = options.helperTimeoutMs ?? HELPER_TIMEOUT_MS;
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    if (this.platform !== "win32") {
      return audioProviderUnsupportedCapabilities(this.platform, this.clock());
    }
    const runner = await this.getRunnerOrUndefined();
    if (runner === undefined) {
      return audioProviderNotConfiguredCapabilities(this.platform, this.clock());
    }
    const payload = await runJsonCommand(runner, ["capabilities", "--json"], this.helperTimeoutMs, "NATIVE_WINDOWS_API_INITIALIZATION_FAILED");
    return capabilitiesFromPayload(payload as HelperCapabilitiesPayload, this.platform, this.clock());
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    if (this.platform !== "win32") {
      throw nativeError("NATIVE_PLATFORM_UNSUPPORTED", `Windows native audio capture is unsupported on platform ${this.platform}.`, request.capability, false);
    }
    if (!AUDIO_KINDS.has(request.capability)) {
      throw nativeError("NATIVE_CAPABILITY_UNAVAILABLE", `Windows native audio provider does not implement ${request.capability}.`, request.capability, false);
    }
    if (request.format !== WINDOWS_AUDIO_CAPTURE_FORMAT || request.mimeType !== WINDOWS_AUDIO_CAPTURE_MIME_TYPE) {
      throw nativeError(
        "NATIVE_CAPABILITY_UNAVAILABLE",
        `Windows native audio capture supports only ${WINDOWS_AUDIO_CAPTURE_FORMAT}/${WINDOWS_AUDIO_CAPTURE_MIME_TYPE}.`,
        request.capability,
        false,
      );
    }
    const runner = await this.getRunnerOrThrow(request.capability);
    const args = [
      "capture",
      "--kind",
      request.capability === "MICROPHONE_AUDIO" ? "microphone" : "loopback",
      "--format",
      "aiwpcm-jsonl",
    ];
    if (request.sourceId !== undefined) {
      args.push("--source-id", request.sourceId);
    }
    let process: WindowsAudioHelperProcess;
    try {
      process = runner(args);
    } catch (error: unknown) {
      throw nativeError(
        "NATIVE_CAPTURE_START_FAILED",
        `Windows native audio helper failed to start: ${errorMessage(error)}`,
        request.capability,
        true,
        error,
      );
    }
    return new WindowsNativeAudioSession(request, process, this.clock);
  }

  private async getRunnerOrUndefined(): Promise<WindowsAudioHelperRunner | undefined> {
    if (this.helperRunner !== undefined) {
      return this.helperRunner;
    }
    for (const helperPath of this.helperPaths) {
      try {
        await access(helperPath);
        return createSpawnRunner(helperPath);
      } catch {
        // Try the next packaged/development helper candidate. If none exists,
        // capability discovery reports NATIVE_PROVIDER_NOT_CONFIGURED.
      }
    }
    return undefined;
  }

  private async getRunnerOrThrow(capability: NativeCaptureKind): Promise<WindowsAudioHelperRunner> {
    const runner = await this.getRunnerOrUndefined();
    if (runner === undefined) {
      throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native audio helper is not configured or was not found.", capability, false);
    }
    return runner;
  }
}

class WindowsNativeAudioSession implements NativeCaptureSession {
  public readonly nativeSessionId: string;
  public readonly capability: NativeCaptureKind;
  public readonly sourceId: string | undefined;
  public readonly format = WINDOWS_AUDIO_CAPTURE_FORMAT;
  public readonly mimeType = WINDOWS_AUDIO_CAPTURE_MIME_TYPE;
  public readonly startedAt: string;
  public readonly chunks: AsyncIterable<Uint8Array>;
  private stopped = false;
  private aborted = false;

  public constructor(
    request: NativeCaptureStartRequest,
    private readonly process: WindowsAudioHelperProcess,
    clock: () => Date,
  ) {
    this.nativeSessionId = `windows-audio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.capability = request.capability;
    this.sourceId = request.sourceId;
    this.startedAt = clock().toISOString();
    this.chunks = this.readValidatedChunks();
  }

  public async stop(): Promise<void> {
    if (this.aborted || this.stopped) {
      return;
    }
    this.stopped = true;
    try {
      this.process.stdin?.write("stop\n");
      this.process.stdin?.end();
    } catch (error: unknown) {
      throw nativeError("NATIVE_CAPTURE_STOP_FAILED", `Windows native audio stop failed: ${errorMessage(error)}`, this.capability, true, error);
    }
  }

  public async abort(reason: string): Promise<void> {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    try {
      this.process.stdin?.write(`abort ${reason.replaceAll("\n", " ")}\n`);
      this.process.stdin?.end();
    } catch {
      // Termination below is the fail-closed action; a broken control pipe must
      // not keep a native capture running.
    }
    this.process.kill("SIGTERM");
  }

  private async *readValidatedChunks(): AsyncIterable<Uint8Array> {
    let expectedSequence = 0;
    let formatLine: Uint8Array | undefined;
    let formatRecord: WindowsAudioFormatRecord | undefined;
    const stderr = collectText(this.process.stderr);
    try {
      for await (const line of readUtf8Lines(this.process.stdout)) {
        const record = parseCaptureRecord(line.text, this.capability);
        if (record.recordType === "format") {
          validateFormatRecord(record, this.capability);
          formatRecord = record;
          formatLine = line.bytes;
          continue;
        }
        if (formatRecord === undefined || formatLine === undefined) {
          throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk arrived before format metadata.", this.capability, true);
        }
        validateChunkRecord(record, formatRecord, expectedSequence, this.capability);
        if (expectedSequence === 0) {
          yield formatLine;
        }
        yield line.bytes;
        expectedSequence += 1;
      }
      const exit = await this.process.exited;
      const stderrText = await stderr;
      if (!this.aborted && exit.code !== 0) {
        throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", helperExitMessage(exit, stderrText), this.capability, true);
      }
    } catch (error: unknown) {
      if (error instanceof NativeCaptureError) {
        throw error;
      }
      throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", errorMessage(error), this.capability, true, error);
    }
  }
}

function capabilitiesFromPayload(payload: HelperCapabilitiesPayload, platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  capabilities.MICROPHONE_AUDIO = audioCapability("MICROPHONE_AUDIO", payload.microphone, payload.errors?.MICROPHONE_AUDIO);
  capabilities.SYSTEM_AUDIO = audioCapability("SYSTEM_AUDIO", payload.systemAudio, payload.errors?.SYSTEM_AUDIO);
  capabilities.SCREEN = unavailableCapability("SCREEN", "UNSUPPORTED", {
    code: "NATIVE_CAPABILITY_UNAVAILABLE",
    message: "WindowsNativeAudioProvider implements audio capture only, not screen capture.",
    capability: "SCREEN",
    retryable: false,
  });
  capabilities.WINDOW = unavailableCapability("WINDOW", "UNSUPPORTED", {
    code: "NATIVE_CAPABILITY_UNAVAILABLE",
    message: "WindowsNativeAudioProvider implements audio capture only, not window capture.",
    capability: "WINDOW",
    retryable: false,
  });
  return {
    platform,
    adapterId: PROVIDER_ID,
    checkedAt: payload.checkedAt ?? checkedAt.toISOString(),
    supported: true,
    capabilities,
  };
}

function audioCapability(kind: Extract<NativeCaptureKind, "MICROPHONE_AUDIO" | "SYSTEM_AUDIO">, devices: HelperAudioDevice[] | undefined, error: HelperErrorPayload | undefined): NativeCaptureCapability {
  if (error !== undefined) {
    return unavailableCapability(kind, error.code === "NATIVE_PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE", {
      code: error.code,
      message: error.message,
      capability: kind,
      retryable: error.retryable ?? true,
    });
  }
  if (devices === undefined || devices.length === 0) {
    return unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_DEVICE_UNAVAILABLE",
      message: `${kind} device is unavailable.`,
      capability: kind,
      retryable: true,
    });
  }
  const sourceIds = new Set<string>();
  return {
    kind,
    status: "AVAILABLE",
    available: true,
    canListSources: true,
    requiresPermission: true,
    sources: devices.map((device) => {
      if (!device.id.trim()) {
        throw nativeError("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", `${kind} device ID cannot be empty.`, kind, false);
      }
      if (sourceIds.has(device.id)) {
        throw nativeError("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", `${kind} device ID is duplicated.`, kind, false);
      }
      sourceIds.add(device.id);
      return {
        sourceId: device.id,
        label: device.label,
        kind,
        ...(device.isDefault === undefined ? {} : { isDefault: device.isDefault }),
      };
    }),
  };
}

function audioProviderUnsupportedCapabilities(platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNSUPPORTED", {
      code: "NATIVE_PLATFORM_UNSUPPORTED",
      message: `Windows native audio capture is unsupported on platform ${platform}.`,
      capability: kind,
      retryable: false,
    });
  }
  return { platform, adapterId: PROVIDER_ID, checkedAt: checkedAt.toISOString(), supported: false, capabilities };
}

function audioProviderNotConfiguredCapabilities(platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_PROVIDER_NOT_CONFIGURED",
      message: "Windows native audio helper is not configured or was not found.",
      capability: kind,
      retryable: false,
    });
  }
  return { platform, adapterId: PROVIDER_ID, checkedAt: checkedAt.toISOString(), supported: true, capabilities };
}

function parseCaptureRecord(text: string, capability: NativeCaptureKind): WindowsAudioCaptureRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native audio helper emitted invalid JSON: ${errorMessage(error)}`, capability, true, error);
  }
  if (!isRecord(value)) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio helper emitted a non-object record.", capability, true);
  }
  if (value.recordType === "error") {
    throw nativeError(
      stringValue(value.code, "NATIVE_CAPTURE_STREAM_FAILED") as NativeCaptureErrorCode,
      stringValue(value.message, "Windows native audio helper reported an error."),
      capability,
      booleanValue(value.retryable, true),
    );
  }
  if (value.recordType === "format") {
    return value as unknown as WindowsAudioFormatRecord;
  }
  if (value.recordType === "chunk") {
    return value as unknown as WindowsAudioChunkRecord;
  }
  throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio helper emitted an unknown record type.", capability, true);
}

function validateFormatRecord(record: WindowsAudioFormatRecord, capability: NativeCaptureKind): void {
  if (!AUDIO_KINDS.has(record.source) || record.source !== capability) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio format source does not match the requested capability.", capability, true);
  }
  validateIsoTimestamp(record.startedAt, capability, "format startedAt");
  validatePcmFormat(record.format, capability);
}

function validateChunkRecord(record: WindowsAudioChunkRecord, formatRecord: WindowsAudioFormatRecord, expectedSequence: number, capability: NativeCaptureKind): void {
  if (record.source !== formatRecord.source || record.source !== capability) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk source does not match the session source.", capability, true);
  }
  if (record.sourceId !== formatRecord.sourceId) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk source ID changed during capture.", capability, true);
  }
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk sequence is invalid.", capability, true);
  }
  if (record.sequence !== expectedSequence) {
    throw nativeError(
      "NATIVE_CAPTURE_CHUNK_OUT_OF_ORDER",
      `Windows native audio chunk sequence ${record.sequence} did not match expected ${expectedSequence}.`,
      capability,
      true,
    );
  }
  validateIsoTimestamp(record.timestamp, capability, "chunk timestamp");
  validatePcmFormat(record.format, capability);
  assertSameFormat(formatRecord.format, record.format, capability);
  const bytes = Buffer.from(record.dataBase64, "base64");
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength <= 0 || bytes.byteLength !== record.byteLength) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk byte length is invalid.", capability, true);
  }
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (record.sha256.toLowerCase() !== actualSha) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk SHA-256 did not match its PCM payload.", capability, true);
  }
}

function validatePcmFormat(format: WindowsAudioPcmFormat, capability: NativeCaptureKind): void {
  if (format.container !== "AIWPCM_JSONL" || format.encoding !== "PCM") {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio format must be AIWPCM_JSONL PCM.", capability, true);
  }
  for (const [key, value] of Object.entries({
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    blockAlign: format.blockAlign,
    averageBytesPerSecond: format.averageBytesPerSecond,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native audio format has invalid ${key}.`, capability, true);
    }
  }
}

function assertSameFormat(left: WindowsAudioPcmFormat, right: WindowsAudioPcmFormat, capability: NativeCaptureKind): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native audio chunk format changed during capture.", capability, true);
  }
}

function validateIsoTimestamp(value: string, capability: NativeCaptureKind, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native audio ${label} is not a valid timestamp.`, capability, true);
  }
}

async function runJsonCommand(
  runner: WindowsAudioHelperRunner,
  args: readonly string[],
  timeoutMs: number,
  failureCode: NativeCaptureErrorCode,
): Promise<unknown> {
  let process: WindowsAudioHelperProcess;
  try {
    process = runner(args);
  } catch (error: unknown) {
    throw nativeError(failureCode, `Windows native audio helper failed to start: ${errorMessage(error)}`, undefined, true, error);
  }
  const stdout = collectText(process.stdout);
  const stderr = collectText(process.stderr);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      process.kill("SIGTERM");
      reject(nativeError(failureCode, `Windows native audio helper timed out after ${timeoutMs}ms.`, undefined, true));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    const exit = await Promise.race([process.exited, timeoutPromise]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
    if (exit.code !== 0) {
      throw nativeError(failureCode, helperExitMessage(exit, stderrText), undefined, true);
    }
    try {
      return JSON.parse(stdoutText) as unknown;
    } catch (error: unknown) {
      throw nativeError(failureCode, `Windows native audio helper returned invalid JSON: ${errorMessage(error)}`, undefined, true, error);
    }
  } catch (error: unknown) {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (error instanceof NativeCaptureError) {
      throw error;
    }
    throw nativeError(failureCode, errorMessage(error), undefined, true, error);
  }
}

async function* readUtf8Lines(source: AsyncIterable<Uint8Array>): AsyncIterable<{ text: string; bytes: Uint8Array }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const text = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (text.length > 0) {
        yield { text, bytes: Buffer.from(`${text}\n`, "utf8") };
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const text = buffer.replace(/\r$/, "");
  if (text.length > 0) {
    yield { text, bytes: Buffer.from(`${text}\n`, "utf8") };
  }
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

function createSpawnRunner(helperPath: string): WindowsAudioHelperRunner {
  return (args) => {
    const child = spawn(helperPath, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      exited: new Promise<WindowsAudioHelperExit>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      kill: (signal?: NodeJS.Signals | string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
  };
}

function defaultHelperCandidates(): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  return [
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-audio", "AIWorkMate.WindowsAudioCapture.exe")] : []),
    resolve(__dirname, "..", "..", "native", "windows-audio", "AIWorkMate.WindowsAudioCapture.exe"),
    resolve(__dirname, "..", "..", "..", "native", "windows-audio", "bin", "Release", "net8.0-windows", "win-x64", "publish", "AIWorkMate.WindowsAudioCapture.exe"),
  ];
}

function normalizeHelperPath(helperPath: string): string {
  if (!helperPath.trim() || helperPath.includes("\0")) {
    throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native audio helper path is invalid.", undefined, false);
  }
  const absolute = isAbsolute(helperPath) ? helperPath : resolve(helperPath);
  if (dirname(absolute) === absolute) {
    throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native audio helper path must point to an executable file.", undefined, false);
  }
  return absolute;
}

function nativeError(
  code: NativeCaptureErrorCode,
  message: string,
  capability: NativeCaptureKind | undefined,
  retryable: boolean,
  cause?: unknown,
): NativeCaptureError {
  const info: NativeCaptureErrorInfo = { code, message, retryable };
  if (capability !== undefined) {
    info.capability = capability;
  }
  return new NativeCaptureError(info, cause === undefined ? undefined : { cause });
}

function helperExitMessage(exit: WindowsAudioHelperExit, stderr: string): string {
  const details = stderr.trim();
  return details.length > 0
    ? `Windows native audio helper exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}: ${details}`
    : `Windows native audio helper exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
