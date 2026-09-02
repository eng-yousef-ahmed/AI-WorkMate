import { TranscriptionError, type PreparedPcmAudio } from "./TranscriptionEngine";

export const WHISPER_SAMPLE_RATE_HZ = 16_000;

/** Convert reconstructed capture PCM into 16 kHz mono 16-bit WAV for whisper.cpp. */
export function prepareWhisperWav(audio: PreparedPcmAudio): Uint8Array {
  if (audio.pcm.byteLength === 0 || audio.durationMs <= 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_EMPTY", "Prepared PCM contains no samples for speech recognition.", false);
  }
  if (![1, 2].includes(audio.channels) || ![16, 32].includes(audio.bitsPerSample) || audio.sampleRateHz < 8_000) {
    throw new TranscriptionError(
      "TRANSCRIPTION_RECORDING_INVALID",
      `Unsupported PCM format for local STT: ${audio.sampleRateHz} Hz ${audio.channels} ch ${audio.bitsPerSample}-bit.`,
      false,
    );
  }
  const mono = mixToMono(audio);
  const resampled = resampleLinear(mono, audio.sampleRateHz, WHISPER_SAMPLE_RATE_HZ);
  if (resampled.length === 0) {
    throw new TranscriptionError("TRANSCRIPTION_RECORDING_EMPTY", "Resampled PCM is empty.", false);
  }
  return encodePcm16Wav(resampled, WHISPER_SAMPLE_RATE_HZ);
}

function mixToMono(audio: PreparedPcmAudio): Float32Array {
  const view = Buffer.from(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength);
  if (audio.bitsPerSample === 16) {
    const frames = Math.floor(view.byteLength / (2 * audio.channels));
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < audio.channels; channel += 1) {
        sum += view.readInt16LE((frame * audio.channels + channel) * 2) / 32_768;
      }
      mono[frame] = sum / audio.channels;
    }
    return mono;
  }
  const frames = Math.floor(view.byteLength / (4 * audio.channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < audio.channels; channel += 1) {
      sum += view.readFloatLE((frame * audio.channels + channel) * 4);
    }
    mono[frame] = clamp(sum / audio.channels);
  }
  return mono;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    return floatToPcm16(input);
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    const sample = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
    output[index] = floatSampleToInt16(sample);
  }
  return output;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = floatSampleToInt16(input[index] ?? 0);
  }
  return output;
}

function floatSampleToInt16(sample: number): number {
  const clamped = clamp(sample);
  return Math.max(-32_768, Math.min(32_767, Math.round(clamped * 32_767)));
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function encodePcm16Wav(pcm: Int16Array, sampleRateHz: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) {
    data.writeInt16LE(pcm[index] ?? 0, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}
