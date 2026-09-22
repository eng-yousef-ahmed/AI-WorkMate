import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const WHISPER_SPEECH_FIXTURE_RELATIVE = "tests/fixtures/whisper-speech.wav";
export const WHISPER_SPEECH_FIXTURE_PROMPT = "AI WorkMate records meetings locally.";

export interface SpeechWav {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

export async function loadSpeechFixtureWav(repoRoot = process.cwd()): Promise<SpeechWav> {
  const bytes = await readFile(join(repoRoot, WHISPER_SPEECH_FIXTURE_RELATIVE));
  return parseWav(bytes);
}

/** Rebuild the spoken fixture as 48 kHz / 2 ch / 32-bit float PCM matching WASAPI capture. */
export function speechFixtureToWasapiPcm(wav: SpeechWav): { pcm: Buffer; format: WasapiPcmFormat } {
  const mono = wavToMonoFloat(wav);
  const resampled = resample(mono, wav.sampleRateHz, 48_000);
  const stereo = Buffer.alloc(resampled.length * 8);
  for (let index = 0; index < resampled.length; index += 1) {
    const sample = resampled[index] ?? 0;
    stereo.writeFloatLE(sample, index * 8);
    stereo.writeFloatLE(sample, index * 8 + 4);
  }
  return {
    pcm: stereo,
    format: {
      container: "AIWPCM_JSONL",
      encoding: "PCM",
      sampleRateHz: 48_000,
      channels: 2,
      bitsPerSample: 32,
      blockAlign: 8,
      averageBytesPerSecond: 384_000,
    },
  };
}

export function encodeAiwpcm(pcm: Buffer, format: WasapiPcmFormat): Buffer {
  const lines = [
    JSON.stringify({
      recordType: "format",
      source: "MICROPHONE_AUDIO",
      startedAt: "2026-09-02T10:00:00.000Z",
      format,
    }),
    JSON.stringify({
      recordType: "chunk",
      sequence: 0,
      timestamp: "2026-09-02T10:00:01.000Z",
      source: "MICROPHONE_AUDIO",
      format,
      byteLength: pcm.byteLength,
      sha256: createHash("sha256").update(pcm).digest("hex"),
      dataBase64: pcm.toString("base64"),
    }),
  ];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export interface WasapiPcmFormat {
  container: "AIWPCM_JSONL";
  encoding: "PCM";
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  averageBytesPerSecond: number;
}

function parseWav(bytes: Buffer): SpeechWav {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Speech fixture is not a RIFF/WAVE file.");
  }
  let offset = 12;
  let sampleRateHz = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm = Buffer.alloc(0);
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(start + 2);
      sampleRateHz = bytes.readUInt32LE(start + 4);
      bitsPerSample = bytes.readUInt16LE(start + 14);
    } else if (id === "data") {
      pcm = Buffer.from(bytes.subarray(start, start + size));
      break;
    }
    offset = start + size + (size % 2);
  }
  if (sampleRateHz <= 0 || channels <= 0 || pcm.byteLength === 0) {
    throw new Error("Speech fixture WAVE payload is incomplete.");
  }
  return { sampleRateHz, channels, bitsPerSample, pcm };
}

function wavToMonoFloat(wav: SpeechWav): Float32Array {
  if (wav.bitsPerSample === 16) {
    const frames = Math.floor(wav.pcm.byteLength / (2 * wav.channels));
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < wav.channels; channel += 1) {
        sum += wav.pcm.readInt16LE((frame * wav.channels + channel) * 2) / 32_768;
      }
      mono[frame] = sum / wav.channels;
    }
    return mono;
  }
  throw new Error(`Unsupported speech fixture sample format: ${wav.bitsPerSample}-bit.`);
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) {
    return input;
  }
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}
