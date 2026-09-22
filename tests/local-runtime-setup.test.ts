import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalRuntimeSetupService } from "../src/runtime/LocalRuntimeSetupService";
import { StorageError } from "../src/storage/errors";

test("runtime setup snapshot is renderer-safe and never enables cloud fallback", async () => {
  const localAppData = join(tmpdir(), `ai-workmate-runtime-setup-${Date.now()}`);
  await mkdir(localAppData, { recursive: true });
  const setup = new LocalRuntimeSetupService({ localAppData, platform: "linux" });
  const snapshot = await setup.getSnapshot();
  assert.equal(snapshot.modelsOutsideDataRoot, true);
  assert.equal(snapshot.cloudFallbackEnabled, false);
  assert.equal(snapshot.transcription.id, "transcription-tiny");
  assert.equal(snapshot.analysis.id, "analysis-production");
  assert.equal(snapshot.transcription.ready, false);
  assert.equal(snapshot.analysis.installRequired, true);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(localAppData), false);
  assert.equal(/llama|openai|model-url|helper-path/i.test(serialized), false);
  assert.equal(/[A-Za-z]:\\|\/home\/|\/tmp\//.test(serialized), false);
});

test("runtime install maps catalog ids only and skips a second verified install", async () => {
  const localAppData = join(tmpdir(), `ai-workmate-runtime-install-${Date.now()}`);
  let whisperCalls = 0;
  const setup = new LocalRuntimeSetupService({
    localAppData,
    platform: "linux",
    installWhisper: async () => {
      whisperCalls += 1;
      return {
        installed: true,
        filename: "ggml-tiny.bin",
        sha256: "abc",
        bytes: 1,
        relativeLocation: "%LOCALAPPDATA%\\\\AI-WorkMate\\\\models\\\\whisper\\\\ggml-tiny.bin",
        alreadyVerified: whisperCalls > 1,
      };
    },
    installLlm: async () => {
      throw new Error("analysis should not run");
    },
  });
  const first = await setup.install({ component: "transcription-tiny" });
  assert.equal(first.alreadyVerified, false);
  assert.equal(first.checksumVerified, true);
  const second = await setup.install({ component: "transcription-tiny" });
  assert.equal(second.alreadyVerified, true);
  assert.equal(whisperCalls, 2);
});

test("runtime install rejects unknown components and concurrent installs", async () => {
  const localAppData = join(tmpdir(), `ai-workmate-runtime-busy-${Date.now()}`);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = new LocalRuntimeSetupService({
    localAppData,
    installWhisper: async () => {
      await gate;
      return {
        installed: true,
        filename: "ggml-tiny.bin",
        sha256: "abc",
        bytes: 1,
        relativeLocation: "hidden",
      };
    },
  });
  const pending = setup.install({ component: "transcription-tiny" });
  await assert.rejects(
    setup.install({ component: "transcription-tiny" }),
    (error: unknown) => error instanceof StorageError && error.message.includes("already running"),
  );
  await assert.rejects(
    setup.install({ component: "not-a-component" as "transcription-tiny" }),
    (error: unknown) => error instanceof StorageError && error.message.includes("Unknown"),
  );
  release?.();
  await pending;
});
