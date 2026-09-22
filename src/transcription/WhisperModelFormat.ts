/**
 * whisper.cpp model on-disk magics.
 *
 * convert-pt-to-ggml.py / whisper.cpp write `uint32_t` GGML_FILE_MAGIC
 * `0x67676d6c` ("ggml" as a C fourcc). On little-endian hosts that is the
 * bytes `6c 6d 67 67` ("lmgg"), not the ASCII string "ggml".
 * GGUF files use the ASCII fourcc "GGUF".
 *
 * @see https://github.com/ggml-org/whisper.cpp models/convert-pt-to-ggml.py
 */
export const GGML_FILE_MAGIC = 0x67676d6c;
export const GGML_FILE_MAGIC_GGMF = 0x67676d66;
export const GGML_FILE_MAGIC_GGJT = 0x67676a74;
export const GGUF_MAGIC = 0x46554747;

export function readU32LE(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

export function isWhisperCppModelMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }
  const magic = readU32LE(bytes, 0);
  return magic === GGML_FILE_MAGIC || magic === GGML_FILE_MAGIC_GGMF || magic === GGML_FILE_MAGIC_GGJT || magic === GGUF_MAGIC;
}

export function writeGgmlFileMagic(target: Buffer): Buffer {
  target.writeUInt32LE(GGML_FILE_MAGIC, 0);
  return target;
}
