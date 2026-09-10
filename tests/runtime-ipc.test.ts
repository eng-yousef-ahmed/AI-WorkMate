import assert from "node:assert/strict";
import { test } from "node:test";

import { registerRuntimeIpc, RUNTIME_IPC_CHANNELS } from "../src/desktop/runtime-ipc";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import type { LocalRuntimeSetupService, RuntimeSetupSnapshot } from "../src/runtime/LocalRuntimeSetupService";
import { StorageError, UnsafePathError } from "../src/storage/errors";

type IpcHandler = (...args: unknown[]) => unknown;

test("runtime IPC channels stay off the storage boundary and omit model URLs", () => {
  const storageNames = Object.keys(STORAGE_IPC_CHANNELS);
  const storageValues = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(storageNames.some((name) => /llama|llm|openai|model-url|helper-path/i.test(name)), false);
  assert.equal(storageValues.some((channel) => /llama|llm|openai|model-url|helper-path/i.test(channel)), false);
  const runtimeNames = Object.keys(RUNTIME_IPC_CHANNELS);
  const runtimeValues = Object.values(RUNTIME_IPC_CHANNELS);
  assert.equal(runtimeNames.some((name) => /llama|llm|openai|model-url|helper-path/i.test(name)), false);
  assert.equal(runtimeValues.some((channel) => /llama|llm|openai|model-url|helper-path|https?:/i.test(channel)), false);
  assert.equal(runtimeValues.includes("runtime:get-snapshot"), true);
});

test("runtime IPC returns sanitized DTOs and never forwards filesystem errors", async () => {
  const handlers = new Map<string, IpcHandler>();
  const snapshot: RuntimeSetupSnapshot = {
    transcription: {
      id: "transcription-tiny",
      displayName: "Local transcription model",
      helperReady: false,
      modelPresent: false,
      checksumVerified: false,
      ready: false,
      installRequired: true,
    },
    analysis: {
      id: "analysis-production",
      displayName: "Local analysis model",
      helperReady: false,
      modelPresent: false,
      checksumVerified: false,
      ready: false,
      installRequired: true,
    },
    modelsOutsideDataRoot: true,
    cloudFallbackEnabled: false,
    busy: false,
  };
  const setup = {
    getSnapshot: async () => snapshot,
    install: async () => {
      throw new UnsafePathError("C:\\\\Users\\\\ada\\\\AppData\\\\Local\\\\AI-WorkMate\\\\models");
    },
  } as unknown as LocalRuntimeSetupService;
  registerRuntimeIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    setup,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  const event = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
  assert.deepEqual(await handlers.get(RUNTIME_IPC_CHANNELS.getSnapshot)?.(event), snapshot);
  await assert.rejects(
    async () => handlers.get(RUNTIME_IPC_CHANNELS.install)?.(event, "transcription-tiny", false),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = (error as Error).message;
      assert.equal(message.includes("C:"), false);
      assert.equal(message.includes("Users"), false);
      assert.equal(message.includes("AppData"), false);
      return true;
    },
  );
  await assert.rejects(
    async () => handlers.get(RUNTIME_IPC_CHANNELS.install)?.(event, "https://evil.example/model.gguf"),
    (error: unknown) => error instanceof StorageError && error.message.includes("Unknown"),
  );
});
