import { GGUF_MAGIC, readU32LE } from "../transcription/WhisperModelFormat";

export { GGUF_MAGIC };

export function isGgufModelMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  return readU32LE(bytes, 0) === GGUF_MAGIC;
}

export function writeGgufFileMagic(target: Buffer): Buffer {
  target.writeUInt32LE(GGUF_MAGIC, 0);
  return target;
}
