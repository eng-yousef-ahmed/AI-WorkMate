import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";

/**
 * Windows-only WAV playback for the meeting-processing verifier. The fixture
 * is played through the real default output device (System.Media.SoundPlayer /
 * waveOut) so the WASAPI loopback records it as real system audio and the
 * microphone records it acoustically. The WAV path travels to PowerShell via
 * an environment variable - never on the command line - so no path or content
 * can be interpreted as PowerShell script. No cloud service is involved.
 */

export const VERIFY_WAV_ENV = "AI_WORKMATE_VERIFY_WAV";

export class VerificationPlaybackError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "VerificationPlaybackError";
    this.code = code;
  }
}

export interface SoundPlayerCommand {
  file: string;
  args: string[];
}

/**
 * The exact powershell.exe invocation used on Windows. Pure function so tests
 * can assert that no filesystem path is passed as a command-line argument.
 */
export function buildSoundPlayerCommand(): SoundPlayerCommand {
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop';",
        "try {",
        `(New-Object System.Media.SoundPlayer($env:${VERIFY_WAV_ENV})).PlaySync();`,
        "exit 0",
        "} catch {",
        "exit 3",
        "}",
      ].join(" "),
    ],
  };
}

export interface PlayWavThroughDefaultOutputOptions {
  wavPath: string;
  timeoutMs: number;
  platform?: NodeJS.Platform | string;
}

export interface WavPlaybackResult {
  playedMs: number;
}

export async function playWavThroughDefaultOutput(options: PlayWavThroughDefaultOutputOptions): Promise<WavPlaybackResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new VerificationPlaybackError(
      "MEETING_PROCESSING_VERIFY_PLAYBACK_UNSUPPORTED",
      `Deterministic fixture playback uses the Windows default output device; it is unavailable on ${platform}.`,
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new VerificationPlaybackError("MEETING_PROCESSING_VERIFY_PLAYBACK_INVALID", "Playback timeout must be a positive duration.");
  }
  try {
    await access(options.wavPath);
  } catch {
    throw new VerificationPlaybackError(
      "MEETING_PROCESSING_VERIFY_PLAYBACK_FIXTURE_MISSING",
      "The deterministic speech fixture WAV could not be read.",
    );
  }
  const command = buildSoundPlayerCommand();
  const startedAt = Date.now();
  const child = spawn(command.file, command.args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      [VERIFY_WAV_ENV]: options.wavPath,
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 2000) {
      stderr += chunk.toString("utf8");
    }
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | string | null; timedOut: boolean; spawnError?: Error }>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveExit({ code: null, signal: null, timedOut: true });
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveExit({ code: null, signal: null, timedOut: false, spawnError: error });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, timedOut: false });
    });
  });
  if (exit.spawnError !== undefined) {
    throw new VerificationPlaybackError(
      "MEETING_PROCESSING_VERIFY_PLAYBACK_FAILED",
      `Windows SoundPlayer playback could not start: ${exit.spawnError.message}`,
    );
  }
  if (exit.timedOut) {
    throw new VerificationPlaybackError(
      "MEETING_PROCESSING_VERIFY_PLAYBACK_TIMEOUT",
      `Playing the deterministic speech fixture through the default output device did not finish within ${options.timeoutMs}ms.`,
    );
  }
  if (exit.code !== 0) {
    throw new VerificationPlaybackError(
      "MEETING_PROCESSING_VERIFY_PLAYBACK_FAILED",
      `Windows SoundPlayer playback exited with code ${exit.code ?? "null"}${stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 300)}` : "."}`,
    );
  }
  return { playedMs: Date.now() - startedAt };
}

export interface WavDuration {
  durationMs: number;
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Minimal RIFF/WAVE PCM header parser used to size the capture window and the
 * playback timeout from the committed fixture. Throws on non-PCM containers.
 */
export async function readWavPcmDuration(wavPath: string): Promise<WavDuration> {
  const bytes = await readFile(wavPath);
  if (bytes.byteLength < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new VerificationPlaybackError("MEETING_PROCESSING_VERIFY_PLAYBACK_FIXTURE_INVALID", "Speech fixture is not a RIFF/WAVE file.");
  }
  let offset = 12;
  let sampleRateHz = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = bytes.readUInt16LE(offset + 8);
      channels = bytes.readUInt16LE(offset + 10);
      sampleRateHz = bytes.readUInt32LE(offset + 12);
      bitsPerSample = bytes.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataBytes = Math.min(chunkSize, bytes.byteLength - offset - 8);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  const blockAlign = (channels * bitsPerSample) / 8;
  if (audioFormat !== 1 || channels <= 0 || sampleRateHz <= 0 || bitsPerSample <= 0 || blockAlign <= 0 || dataBytes <= 0) {
    throw new VerificationPlaybackError("MEETING_PROCESSING_VERIFY_PLAYBACK_FIXTURE_INVALID", "Speech fixture is not uncompressed PCM WAV audio.");
  }
  return {
    durationMs: Math.round((dataBytes / blockAlign / sampleRateHz) * 1000),
    sampleRateHz,
    channels,
    bitsPerSample,
  };
}

/** Async pause used to keep the capture window open for a small tail. */
export async function waitForDuration(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
