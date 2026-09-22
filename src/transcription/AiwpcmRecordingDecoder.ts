import { createHash } from "node:crypto";

import type { WindowsAudioPcmFormat } from "../capture/WindowsNativeAudioProvider";
import { TranscriptionError, type PreparedPcmAudio } from "./TranscriptionEngine";

export function decodeAiwpcmRecording(contents: Uint8Array): PreparedPcmAudio {
  if (contents.byteLength === 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_EMPTY", "Recording artifact is empty.", false);
  }
  const text = Buffer.from(contents).toString("utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_EMPTY", "Recording JSONL contains no records.", false);
  }

  let format: WindowsAudioPcmFormat | undefined;
  let source: string | undefined;
  let expectedSequence = 0;
  const pcmChunks: Buffer[] = [];

  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", `Recording JSONL is not valid JSON: ${errorMessage(error)}`, false, { cause: error });
    }
    if (typeof value !== "object" || value === null) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording JSONL record must be an object.", false);
    }
    const record = value as Record<string, unknown>;
    if (record.recordType === "error") {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording contains an error record and cannot be transcribed.", false);
    }
    if (record.recordType === "format") {
      if (format !== undefined) {
        throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording contains more than one format record.", false);
      }
      format = validateFormat(record);
      if (typeof record.source === "string") {
        source = record.source;
      }
      continue;
    }
    if (record.recordType !== "chunk") {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording JSONL record type is unknown.", false);
    }
    if (format === undefined) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording chunk arrived before format metadata.", false);
    }
    const chunk = validateChunk(record, format, expectedSequence);
    pcmChunks.push(chunk);
    expectedSequence += 1;
  }

  if (format === undefined) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording is missing PCM format metadata.", false);
  }
  if (pcmChunks.length === 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_EMPTY", "Recording contains no audio chunks.", false);
  }

  const pcm = Buffer.concat(pcmChunks);
  const frameBytes = format.blockAlign;
  if (pcm.byteLength % frameBytes !== 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_CORRUPTED", "Reconstructed PCM length is not aligned to the reported block size.", false);
  }
  const durationMs = Math.round((pcm.byteLength / format.averageBytesPerSecond) * 1000);
  const prepared: PreparedPcmAudio = {
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    pcm,
    wav: encodeWav(pcm, format),
    durationMs,
    chunkCount: pcmChunks.length,
  };
  if (source !== undefined) {
    prepared.source = source;
  }
  return prepared;
}

function validateFormat(record: Record<string, unknown>): WindowsAudioPcmFormat {
  const format = record.format;
  if (typeof format !== "object" || format === null) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording format metadata is missing.", false);
  }
  const pcm = format as WindowsAudioPcmFormat;
  if (pcm.container !== "AIWPCM_JSONL" || pcm.encoding !== "PCM") {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording format must be AIWPCM_JSONL PCM.", false);
  }
  for (const [key, value] of Object.entries({
    sampleRateHz: pcm.sampleRateHz,
    channels: pcm.channels,
    bitsPerSample: pcm.bitsPerSample,
    blockAlign: pcm.blockAlign,
    averageBytesPerSecond: pcm.averageBytesPerSecond,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", `Recording format has invalid ${key}.`, false);
    }
  }
  return pcm;
}

function validateChunk(record: Record<string, unknown>, format: WindowsAudioPcmFormat, expectedSequence: number): Buffer {
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) {
    throw new TranscriptionError("TRANSCRIPTION_SEQUENCE_INVALID", "Recording chunk sequence is invalid.", false);
  }
  if (record.sequence !== expectedSequence) {
    throw new TranscriptionError(
      "TRANSCRIPTION_SEQUENCE_INVALID",
      `Recording chunk sequence ${String(record.sequence)} did not match expected ${expectedSequence}.`,
      false,
    );
  }
  if (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording chunk timestamp is invalid.", false);
  }
  const chunkFormat = record.format as WindowsAudioPcmFormat | undefined;
  if (chunkFormat === undefined || JSON.stringify(chunkFormat) !== JSON.stringify(format)) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording chunk format changed during capture.", false);
  }
  if (typeof record.dataBase64 !== "string" || typeof record.sha256 !== "string") {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording chunk payload is missing.", false);
  }
  const bytes = Buffer.from(record.dataBase64, "base64");
  if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) <= 0 || bytes.byteLength !== record.byteLength) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_CORRUPTED", "Recording chunk byte length is invalid.", false);
  }
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (record.sha256.toLowerCase() !== actualSha) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_CORRUPTED", "Recording chunk SHA-256 did not match its PCM payload.", false);
  }
  return bytes;
}

function encodeWav(pcm: Buffer, format: WindowsAudioPcmFormat): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRateHz, 24);
  header.writeUInt32LE(format.averageBytesPerSecond, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
