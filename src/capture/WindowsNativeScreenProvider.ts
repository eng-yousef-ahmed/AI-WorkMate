import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  NATIVE_CAPTURE_KINDS,
  NativeCaptureError,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureErrorCode,
  type NativeCaptureErrorInfo,
  type NativeCaptureErrorState,
  type NativeCaptureKind,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
  unavailableCapability,
} from "./NativeCaptureAdapter";
import type { WindowsNativeCaptureProvider } from "./WindowsCaptureAdapter";

export const WINDOWS_SCREEN_CAPTURE_FORMAT = "aiwvid";
export const WINDOWS_SCREEN_CAPTURE_MIME_TYPE = "application/x-ai-workmate-video-jsonl";

const VIDEO_KINDS = new Set<NativeCaptureKind>(["SCREEN", "WINDOW"]);
const PROVIDER_ID = "windows-native-screen-provider";
const HELPER_TIMEOUT_MS = 10_000;
const DISPLAY_SOURCE_ID = /^display:[A-Za-z0-9._-]+$/;
const WINDOW_SOURCE_ID = /^hwnd:[0-9A-Fa-f]{1,16}$/;

export interface WindowsVideoFormat {
  container: "AIWVID_JSONL";
  encoding: "JPEG";
  width: number;
  height: number;
  bitsPerPixel: number;
  frameIntervalMs: number;
}

export interface WindowsVideoFormatRecord {
  recordType: "format";
  source: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">;
  sourceId?: string;
  sourceLabel?: string;
  startedAt: string;
  format: WindowsVideoFormat;
}

export interface WindowsVideoChunkRecord {
  recordType: "chunk";
  sequence: number;
  timestamp: string;
  source: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">;
  sourceId?: string;
  format: WindowsVideoFormat;
  width?: number;
  height?: number;
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

export type WindowsVideoCaptureRecord = WindowsVideoFormatRecord | WindowsVideoChunkRecord;

export interface WindowsScreenHelperExit {
  code: number | null;
  signal: NodeJS.Signals | string | null;
}

export interface WindowsScreenHelperStdin {
  write(data: string | Uint8Array): boolean;
  end(): void;
}

export interface WindowsScreenHelperProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr?: AsyncIterable<Uint8Array>;
  stdin?: WindowsScreenHelperStdin;
  exited: Promise<WindowsScreenHelperExit>;
  kill(signal?: NodeJS.Signals | string): void;
}

export type WindowsScreenHelperRunner = (args: readonly string[]) => WindowsScreenHelperProcess;

export interface WindowsNativeScreenProviderOptions {
  platform?: NodeJS.Platform | string;
  helperPath?: string;
  helperRunner?: WindowsScreenHelperRunner;
  clock?: () => Date;
  helperTimeoutMs?: number;
}

interface HelperCapabilitiesPayload {
  checkedAt?: string;
  displays?: HelperCaptureTarget[];
  windows?: HelperCaptureTarget[];
  errors?: Partial<Record<"SCREEN" | "WINDOW", HelperErrorPayload>>;
}

interface HelperCaptureTarget {
  id: string;
  label: string;
  isDefault?: boolean;
  width?: number;
  height?: number;
}

interface HelperErrorPayload {
  code: NativeCaptureErrorCode;
  message: string;
  retryable?: boolean;
}

/**
 * Real Windows screen/window provider. DXGI Desktop Duplication captures a
 * selected display. Windows Graphics Capture captures a selected HWND. The
 * provider never invents frames.
 */
export class WindowsNativeScreenProvider implements WindowsNativeCaptureProvider, NativeCaptureAdapter {
  public readonly adapterId = PROVIDER_ID;
  private readonly platform: NodeJS.Platform | string;
  private readonly helperPaths: readonly string[];
  private readonly helperRunner: WindowsScreenHelperRunner | undefined;
  private readonly clock: () => Date;
  private readonly helperTimeoutMs: number;

  public constructor(options: WindowsNativeScreenProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.helperPaths = options.helperPath === undefined ? windowsScreenHelperCandidates() : [normalizeHelperPath(options.helperPath)];
    this.helperRunner = options.helperRunner;
    this.clock = options.clock ?? (() => new Date());
    this.helperTimeoutMs = options.helperTimeoutMs ?? HELPER_TIMEOUT_MS;
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    if (this.platform !== "win32") {
      return screenProviderUnsupportedCapabilities(this.platform, this.clock());
    }
    const runner = await this.getRunnerOrUndefined();
    if (runner === undefined) {
      return screenProviderNotConfiguredCapabilities(this.platform, this.clock());
    }
    const payload = await runJsonCommand(runner, ["capabilities", "--json"], this.helperTimeoutMs, "NATIVE_WINDOWS_API_INITIALIZATION_FAILED");
    return capabilitiesFromPayload(payload as HelperCapabilitiesPayload, this.platform, this.clock());
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    if (this.platform !== "win32") {
      throw nativeError("NATIVE_PLATFORM_UNSUPPORTED", `Windows native screen capture is unsupported on platform ${this.platform}.`, request.capability, false);
    }
    if (!VIDEO_KINDS.has(request.capability)) {
      throw nativeError("NATIVE_CAPABILITY_UNAVAILABLE", `Windows native screen provider does not implement ${request.capability}.`, request.capability, false);
    }
    if (request.format !== WINDOWS_SCREEN_CAPTURE_FORMAT || request.mimeType !== WINDOWS_SCREEN_CAPTURE_MIME_TYPE) {
      throw nativeError(
        "NATIVE_CAPABILITY_UNAVAILABLE",
        `Windows native screen capture supports only ${WINDOWS_SCREEN_CAPTURE_FORMAT}/${WINDOWS_SCREEN_CAPTURE_MIME_TYPE}.`,
        request.capability,
        false,
      );
    }
    assertValidSourceId(request.capability, request.sourceId);
    const runner = await this.getRunnerOrThrow(request.capability);
    const args = [
      "capture",
      "--kind",
      request.capability === "SCREEN" ? "screen" : "window",
      "--format",
      "aiwvid-jsonl",
    ];
    if (request.sourceId !== undefined) {
      args.push("--source-id", request.sourceId);
    }
    let process: WindowsScreenHelperProcess;
    try {
      process = runner(args);
    } catch (error: unknown) {
      throw nativeError(
        "NATIVE_CAPTURE_START_FAILED",
        `Windows native screen helper failed to start: ${errorMessage(error)}`,
        request.capability,
        true,
        error,
      );
    }
    return new WindowsNativeScreenSession(request, process, this.clock);
  }

  private async getRunnerOrUndefined(): Promise<WindowsScreenHelperRunner | undefined> {
    if (this.helperRunner !== undefined) {
      return this.helperRunner;
    }
    for (const helperPath of this.helperPaths) {
      try {
        await access(helperPath);
        return createSpawnRunner(helperPath);
      } catch {
        // Try the next packaged/development helper candidate.
      }
    }
    return undefined;
  }

  private async getRunnerOrThrow(capability: NativeCaptureKind): Promise<WindowsScreenHelperRunner> {
    const runner = await this.getRunnerOrUndefined();
    if (runner === undefined) {
      throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native screen helper is not configured or was not found.", capability, false);
    }
    return runner;
  }
}

class WindowsNativeScreenSession implements NativeCaptureSession {
  public readonly nativeSessionId: string;
  public readonly capability: NativeCaptureKind;
  public readonly sourceId: string | undefined;
  public readonly format = WINDOWS_SCREEN_CAPTURE_FORMAT;
  public readonly mimeType = WINDOWS_SCREEN_CAPTURE_MIME_TYPE;
  public readonly startedAt: string;
  public readonly chunks: AsyncIterable<Uint8Array>;
  private stopped = false;
  private aborted = false;

  public constructor(
    request: NativeCaptureStartRequest,
    private readonly process: WindowsScreenHelperProcess,
    clock: () => Date,
  ) {
    this.nativeSessionId = `windows-screen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      throw nativeError("NATIVE_CAPTURE_STOP_FAILED", `Windows native screen stop failed: ${errorMessage(error)}`, this.capability, true, error);
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
      // Kill below is fail-closed.
    }
    this.process.kill("SIGTERM");
  }

  private async *readValidatedChunks(): AsyncIterable<Uint8Array> {
    let expectedSequence = 0;
    let formatLine: Uint8Array | undefined;
    let formatRecord: WindowsVideoFormatRecord | undefined;
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
          throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk arrived before format metadata.", this.capability, true);
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
  capabilities.SCREEN = videoCapability("SCREEN", payload.displays, payload.errors?.SCREEN);
  capabilities.WINDOW = videoCapability("WINDOW", payload.windows, payload.errors?.WINDOW);
  capabilities.MICROPHONE_AUDIO = unavailableCapability("MICROPHONE_AUDIO", "UNSUPPORTED", {
    code: "NATIVE_CAPABILITY_UNAVAILABLE",
    message: "WindowsNativeScreenProvider implements screen/window capture only, not audio.",
    capability: "MICROPHONE_AUDIO",
    retryable: false,
  });
  capabilities.SYSTEM_AUDIO = unavailableCapability("SYSTEM_AUDIO", "UNSUPPORTED", {
    code: "NATIVE_CAPABILITY_UNAVAILABLE",
    message: "WindowsNativeScreenProvider implements screen/window capture only, not audio.",
    capability: "SYSTEM_AUDIO",
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

function videoCapability(kind: Extract<NativeCaptureKind, "SCREEN" | "WINDOW">, targets: HelperCaptureTarget[] | undefined, error: HelperErrorPayload | undefined): NativeCaptureCapability {
  if (error !== undefined) {
    return unavailableCapability(kind, error.code === "NATIVE_PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE", {
      code: error.code,
      message: error.message,
      capability: kind,
      retryable: error.retryable ?? true,
    });
  }
  if (targets === undefined || targets.length === 0) {
    return unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_DEVICE_UNAVAILABLE",
      message: `${kind} target is unavailable.`,
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
    sources: targets.map((target) => {
      assertValidSourceId(kind, target.id);
      if (sourceIds.has(target.id)) {
        throw nativeError("NATIVE_WINDOWS_API_INITIALIZATION_FAILED", `${kind} source ID is duplicated.`, kind, false);
      }
      sourceIds.add(target.id);
      return {
        sourceId: target.id,
        label: target.label,
        kind,
        ...(target.isDefault === undefined ? {} : { isDefault: target.isDefault }),
      };
    }),
  };
}

export function assertValidSourceId(capability: NativeCaptureKind, sourceId: string | undefined): void {
  if (sourceId === undefined) {
    if (capability === "WINDOW") {
      throw nativeError("NATIVE_CAPABILITY_UNAVAILABLE", "Window capture requires a validated hwnd source ID.", capability, false);
    }
    return;
  }
  if (sourceId.includes("\0") || sourceId.includes("..") || sourceId.includes("/") || sourceId.includes("\\")) {
    throw nativeError("NATIVE_CAPABILITY_UNAVAILABLE", "Native capture source ID is invalid.", capability, false);
  }
  const pattern = capability === "WINDOW" ? WINDOW_SOURCE_ID : capability === "SCREEN" ? DISPLAY_SOURCE_ID : undefined;
  if (pattern !== undefined && !pattern.test(sourceId)) {
    throw nativeError("NATIVE_CAPABILITY_UNAVAILABLE", `Native capture source ID is not a valid ${capability} identifier.`, capability, false);
  }
}

function screenProviderUnsupportedCapabilities(platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNSUPPORTED", {
      code: "NATIVE_PLATFORM_UNSUPPORTED",
      message: `Windows native screen capture is unsupported on platform ${platform}.`,
      capability: kind,
      retryable: false,
    });
  }
  return { platform, adapterId: PROVIDER_ID, checkedAt: checkedAt.toISOString(), supported: false, capabilities };
}

function screenProviderNotConfiguredCapabilities(platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_PROVIDER_NOT_CONFIGURED",
      message: "Windows native screen helper is not configured or was not found.",
      capability: kind,
      retryable: false,
    });
  }
  return { platform, adapterId: PROVIDER_ID, checkedAt: checkedAt.toISOString(), supported: true, capabilities };
}

function parseCaptureRecord(text: string, capability: NativeCaptureKind): WindowsVideoCaptureRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native screen helper emitted invalid JSON: ${errorMessage(error)}`, capability, true, error);
  }
  if (!isRecord(value)) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen helper emitted a non-object record.", capability, true);
  }
  if (value.recordType === "error") {
    const errorState = isRecord(value.state) ? (value.state as NativeCaptureErrorState) : undefined;
    throw nativeError(
      stringValue(value.code, "NATIVE_CAPTURE_STREAM_FAILED") as NativeCaptureErrorCode,
      stringValue(value.message, "Windows native screen helper reported an error."),
      capability,
      booleanValue(value.retryable, true),
      undefined,
      errorState,
    );
  }
  if (value.recordType === "format") {
    return value as unknown as WindowsVideoFormatRecord;
  }
  if (value.recordType === "chunk") {
    return value as unknown as WindowsVideoChunkRecord;
  }
  throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen helper emitted an unknown record type.", capability, true);
}

function validateFormatRecord(record: WindowsVideoFormatRecord, capability: NativeCaptureKind): void {
  if (!VIDEO_KINDS.has(record.source) || record.source !== capability) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen format source does not match the requested capability.", capability, true);
  }
  validateIsoTimestamp(record.startedAt, capability, "format startedAt");
  validateVideoFormat(record.format, capability);
}

function validateChunkRecord(record: WindowsVideoChunkRecord, formatRecord: WindowsVideoFormatRecord, expectedSequence: number, capability: NativeCaptureKind): void {
  if (record.source !== formatRecord.source || record.source !== capability) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk source does not match the session source.", capability, true);
  }
  if (record.sourceId !== formatRecord.sourceId) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk source ID changed during capture.", capability, true);
  }
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk sequence is invalid.", capability, true);
  }
  if (record.sequence !== expectedSequence) {
    throw nativeError(
      "NATIVE_CAPTURE_CHUNK_OUT_OF_ORDER",
      `Windows native screen chunk sequence ${record.sequence} did not match expected ${expectedSequence}.`,
      capability,
      true,
    );
  }
  validateIsoTimestamp(record.timestamp, capability, "chunk timestamp");
  validateVideoFormat(record.format, capability);
  assertSameFormat(formatRecord.format, record.format, capability);
  const bytes = Buffer.from(record.dataBase64, "base64");
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength <= 0 || bytes.byteLength !== record.byteLength) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk byte length is invalid.", capability, true);
  }
  if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk is not a JPEG frame.", capability, true);
  }
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (record.sha256.toLowerCase() !== actualSha) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk SHA-256 did not match its JPEG payload.", capability, true);
  }
}

function validateVideoFormat(format: WindowsVideoFormat, capability: NativeCaptureKind): void {
  if (format.container !== "AIWVID_JSONL" || format.encoding !== "JPEG") {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen format must be AIWVID_JSONL JPEG.", capability, true);
  }
  for (const [key, value] of Object.entries({
    width: format.width,
    height: format.height,
    bitsPerPixel: format.bitsPerPixel,
    frameIntervalMs: format.frameIntervalMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native screen format has invalid ${key}.`, capability, true);
    }
  }
}

function assertSameFormat(left: WindowsVideoFormat, right: WindowsVideoFormat, capability: NativeCaptureKind): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", "Windows native screen chunk format changed during capture.", capability, true);
  }
}

function validateIsoTimestamp(value: string, capability: NativeCaptureKind, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw nativeError("NATIVE_CAPTURE_STREAM_FAILED", `Windows native screen ${label} is not a valid timestamp.`, capability, true);
  }
}

async function runJsonCommand(
  runner: WindowsScreenHelperRunner,
  args: readonly string[],
  timeoutMs: number,
  failureCode: NativeCaptureErrorCode,
): Promise<unknown> {
  let process: WindowsScreenHelperProcess;
  try {
    process = runner(args);
  } catch (error: unknown) {
    throw nativeError(failureCode, `Windows native screen helper failed to start: ${errorMessage(error)}`, undefined, true, error);
  }
  const stdout = collectText(process.stdout);
  const stderr = collectText(process.stderr);
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      process.kill("SIGTERM");
      reject(nativeError(failureCode, `Windows native screen helper timed out after ${timeoutMs}ms.`, undefined, true));
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
      throw nativeError(failureCode, `Windows native screen helper returned invalid JSON: ${errorMessage(error)}`, undefined, true, error);
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

function createSpawnRunner(helperPath: string): WindowsScreenHelperRunner {
  return (args) => {
    const child = spawn(helperPath, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      exited: new Promise<WindowsScreenHelperExit>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      kill: (signal?: NodeJS.Signals | string) => {
        child.kill(signal as NodeJS.Signals | undefined);
      },
    };
  };
}

export function windowsScreenHelperCandidates(): string[] {
  const resourcesPath = stringRecord(process).resourcesPath;
  return [
    ...(typeof resourcesPath === "string" ? [join(resourcesPath, "native", "windows-screen", "AIWorkMate.WindowsScreenCapture.exe")] : []),
    resolve(__dirname, "..", "..", "native", "windows-screen", "AIWorkMate.WindowsScreenCapture.exe"),
    resolve(__dirname, "..", "..", "..", "native", "windows-screen", "bin", "Release", "net8.0-windows10.0.19041.0", "win-x64", "publish", "AIWorkMate.WindowsScreenCapture.exe"),
  ];
}

export async function resolveWindowsScreenHelperPath(helperPath?: string): Promise<string | undefined> {
  const candidates = helperPath === undefined ? windowsScreenHelperCandidates() : [normalizeHelperPath(helperPath)];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue scanning packaged and development helper locations.
    }
  }
  return undefined;
}

function normalizeHelperPath(helperPath: string): string {
  if (!helperPath.trim() || helperPath.includes("\0")) {
    throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native screen helper path is invalid.", undefined, false);
  }
  const absolute = isAbsolute(helperPath) ? helperPath : resolve(helperPath);
  if (dirname(absolute) === absolute) {
    throw nativeError("NATIVE_PROVIDER_NOT_CONFIGURED", "Windows native screen helper path must point to an executable file.", undefined, false);
  }
  return absolute;
}

function nativeError(
  code: NativeCaptureErrorCode,
  message: string,
  capability: NativeCaptureKind | undefined,
  retryable: boolean,
  cause?: unknown,
  state?: NativeCaptureErrorState,
): NativeCaptureError {
  const info: NativeCaptureErrorInfo = { code, message, retryable };
  if (capability !== undefined) {
    info.capability = capability;
  }
  if (state !== undefined) {
    info.state = state;
  }
  return new NativeCaptureError(info, cause === undefined ? undefined : { cause });
}

function helperExitMessage(exit: WindowsScreenHelperExit, stderr: string): string {
  const details = stderr.trim();
  return details.length > 0
    ? `Windows native screen helper exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}: ${details}`
    : `Windows native screen helper exited with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}.`;
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
