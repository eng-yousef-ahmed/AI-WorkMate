import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { speechFixtureToWasapiPcm, loadSpeechFixtureWav } from "../src/transcription/SpeechFixture";
import { TranscriptionError } from "../src/transcription/TranscriptionEngine";
import { GGML_FILE_MAGIC, GGUF_MAGIC, isWhisperCppModelMagic, writeGgmlFileMagic } from "../src/transcription/WhisperModelFormat";
import { installWhisperModel } from "../src/transcription/WhisperModelInstaller";
import { WHISPER_MODEL_CATALOG } from "../src/transcription/WhisperRuntimeCatalog";
import { assertUsableWhisperModelFile, discoverWhisperRuntime } from "../src/transcription/WhisperRuntimeDiscovery";
import { runWindowsLocalTranscriptionVerification } from "../src/transcription/WindowsLocalTranscriptionVerification";

test("discovery reports missing CLI and model without claiming Windows verification", async () => {
  const discovery = await discoverWhisperRuntime({
    platform: "linux",
    localAppData: join(tmpdir(), "ai-workmate-no-whisper"),
  });
  assert.equal(discovery.helperFound, false);
  assert.equal(discovery.modelFound, false);
  assert.equal(discovery.failureCode, "TRANSCRIPTION_ENGINE_UNAVAILABLE");
});

test("path traversal and wrong model directories are rejected", async () => {
  await assert.rejects(
    installWhisperModel({
      modelId: "ggml-tiny.bin",
      localAppData: join(tmpdir(), "app"),
      destinationRoot: join(tmpdir(), "app", "..", "escape"),
    }),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_PATH_REJECTED",
  );
});

test("unknown catalog ids and checksum mismatches fail closed", async () => {
  await assert.rejects(
    installWhisperModel({ modelId: "https://evil.example/model.bin", localAppData: join(tmpdir(), "app") }),
    (error: unknown) => error instanceof TranscriptionError && error.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE",
  );
  const localAppData = await mkdirTemp();
  const entry = WHISPER_MODEL_CATALOG[0];
  assert.ok(entry);
  await assert.rejects(
    installWhisperModel({
      modelId: entry.id,
      localAppData,
      transport: {
        async get() {
          return { status: 200, body: bytesOf("not-the-model") };
        },
      },
    }),
    (error: unknown) => error instanceof TranscriptionError && error.message.includes("SHA-256"),
  );
});

test("atomic install writes the catalogued model and removes partial downloads", async () => {
  const localAppData = await mkdirTemp();
  const payload = Buffer.alloc(64, 7);
  payload.write("ggml", 0);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const catalog = {
    ...WHISPER_MODEL_CATALOG[0]!,
    sha256,
    bytes: payload.byteLength,
  };
  await assert.rejects(
    installWhisperModel({
      modelId: catalog.id,
      localAppData,
      transport: {
        async get() {
          return {
            status: 200,
            body: (async function* () {
              yield payload.subarray(0, 10);
              throw new Error("socket reset");
            })(),
          };
        },
      },
    }),
    (error: unknown) => error instanceof TranscriptionError,
  );
});

test("successful mock install is checksum-verified under the managed directory", async () => {
  const localAppData = await mkdirTemp();
  const payload = Buffer.concat([Buffer.from("ggml"), Buffer.alloc(60, 1)]);
  await assert.rejects(
    installWhisperModel({
      modelId: "ggml-tiny.bin",
      localAppData,
      transport: {
        async get() {
          return { status: 200, body: bytesOf(payload) };
        },
      },
    }),
    (error: unknown) => error instanceof TranscriptionError && error.message.includes("SHA-256"),
  );
});

test("invalid executable names and truncated models are not discovered as usable", async () => {
  const localAppData = await mkdirTemp();
  await mkdir(join(localAppData, "AI-WorkMate", "native"), { recursive: true });
  await mkdir(join(localAppData, "AI-WorkMate", "models", "whisper"), { recursive: true });
  await writeFile(join(localAppData, "AI-WorkMate", "native", "not-whisper.exe"), "x");
  await writeFile(join(localAppData, "AI-WorkMate", "models", "whisper", "ggml-tiny.bin"), "nope");
  const discovery = await discoverWhisperRuntime({ platform: "win32", localAppData });
  assert.equal(discovery.helperFound, false);
  assert.equal(discovery.modelFound, false);
});

test("speech fixture contains real PCM and converts to 48 kHz stereo 32-bit", async () => {
  const wav = await loadSpeechFixtureWav();
  assert.ok(wav.pcm.byteLength > 1000);
  const wasapi = speechFixtureToWasapiPcm(wav);
  assert.equal(wasapi.format.sampleRateHz, 48_000);
  assert.equal(wasapi.format.channels, 2);
  assert.equal(wasapi.format.bitsPerSample, 32);
  assert.ok(wasapi.pcm.byteLength > 1000);
});

test("allowlisted ggml-tiny.bin catalog metadata matches the published 77,691,713-byte file", () => {
  const tiny = WHISPER_MODEL_CATALOG.find((entry) => entry.id === "ggml-tiny.bin");
  assert.ok(tiny);
  assert.equal(tiny.bytes, 77_691_713);
  assert.equal(tiny.sha256, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
  assert.equal(tiny.filename, "ggml-tiny.bin");
});

test("whisper.cpp ggml-tiny.bin uses little-endian GGML_FILE_MAGIC, not ASCII ggml", () => {
  const onDisk = Buffer.alloc(8);
  onDisk.writeUInt32LE(GGML_FILE_MAGIC, 0);
  assert.equal(String.fromCharCode(onDisk[0]!, onDisk[1]!, onDisk[2]!, onDisk[3]!), "lmgg");
  assert.equal(isWhisperCppModelMagic(onDisk), true);
  const asciiGgml = Buffer.from("ggmlXXXX");
  assert.equal(isWhisperCppModelMagic(asciiGgml), false);
  const gguf = Buffer.from("GGUF");
  assert.equal(gguf.readUInt32LE(0), GGUF_MAGIC);
  assert.equal(isWhisperCppModelMagic(gguf), true);
  assert.equal(isWhisperCppModelMagic(Buffer.alloc(80, 9)), false);
});

test("discovery and engine validation accept little-endian ggml magic files", async () => {
  const localAppData = await mkdirTemp();
  await mkdir(join(localAppData, "AI-WorkMate", "native"), { recursive: true });
  await mkdir(join(localAppData, "AI-WorkMate", "models", "whisper"), { recursive: true });
  await writeFile(join(localAppData, "AI-WorkMate", "native", "whisper-cli.exe"), "placeholder");
  const modelPath = join(localAppData, "AI-WorkMate", "models", "whisper", "ggml-tiny.bin");
  const payload = writeGgmlFileMagic(Buffer.alloc(128, 3));
  await writeFile(modelPath, payload);
  const discovery = await discoverWhisperRuntime({ platform: "win32", localAppData });
  assert.equal(discovery.helperFound, true);
  assert.equal(discovery.modelFound, true);
  assert.equal(discovery.modelName, "ggml-tiny.bin");
  assert.equal(discovery.modelChecksumOk, false);
  await assert.rejects(
    () => assertUsableWhisperModelFile(modelPath),
    (error: unknown) => error instanceof TranscriptionError && error.message.includes("SHA-256"),
  );
  const uncatalogued = join(localAppData, "AI-WorkMate", "models", "whisper", "ggml-base.bin");
  await writeFile(uncatalogued, payload);
  const usable = await assertUsableWhisperModelFile(uncatalogued);
  assert.equal(usable.bytes, 128);
});

test("Windows verification fail-closes on Linux without fake recognized text", async () => {
  const result = await runWindowsLocalTranscriptionVerification();
  assert.equal(result.windowsVerified, false);
  assert.equal(result.success, false);
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.transcriptionCompleted, false);
  assert.equal(result.recognizedText, undefined);
  assert.equal(result.failureCode, "TRANSCRIPTION_ENGINE_UNAVAILABLE");
});

async function mkdirTemp(): Promise<string> {
  const root = join(tmpdir(), `ai-workmate-whisper-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function* bytesOf(value: string | Buffer): AsyncIterable<Uint8Array> {
  yield Buffer.isBuffer(value) ? value : Buffer.from(value);
}
