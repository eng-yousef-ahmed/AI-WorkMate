import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AIProcessingPolicyEnforcer,
  CredentialBackedMicrosoftTokenCache,
  ElectronSafeStorageCredentialStore,
  LocalAIProvider,
  OpenAIProvider,
  PolicyAwareAIService,
} from "../src";
import { StorageError } from "../src/storage/errors";

test("enforces LOCAL_ONLY and ASK_EACH_TIME before cloud content transmission", async () => {
  let transmitted = false;
  const cloud = new OpenAIProvider(async () => {
    transmitted = true;
    return "cloud result";
  });
  const local = new LocalAIProvider(async () => "local result");
  const enforcer = new AIProcessingPolicyEnforcer();
  assert.throws(() => enforcer.assertAllowed("LOCAL_ONLY", cloud.descriptor), StorageError);
  const ask = new PolicyAwareAIService(cloud, "ASK_EACH_TIME");
  await assert.rejects(ask.process({ meetingId: "m1", purpose: "SUMMARY", content: "private" }), StorageError);
  assert.equal(transmitted, false);
  assert.equal((await ask.process({ meetingId: "m1", purpose: "SUMMARY", content: "private" }, true)).output, "cloud result");
  const localService = new PolicyAwareAIService(local, "LOCAL_ONLY");
  assert.equal((await localService.process({ meetingId: "m1", purpose: "SUMMARY", content: "private" })).output, "local result");
});

test("stores credentials only as OS-encrypted blobs outside DATA_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-credentials-"));
  try {
    const vaultPath = join(root, "userData", "credential-vault.json");
    const primitive = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xaa),
      decryptString: (value: Uint8Array) => Buffer.from(Array.from(value, (byte) => byte ^ 0xaa)).toString("utf8"),
    };
    const credentials = new ElectronSafeStorageCredentialStore(primitive, vaultPath);
    await credentials.set("openai", "default", "secret-api-key");
    assert.equal(await credentials.get("openai", "default"), "secret-api-key");
    const vault = await import("node:fs/promises").then(({ readFile }) => readFile(vaultPath, "utf8"));
    assert.equal(vault.includes("secret-api-key"), false);
    await credentials.delete("openai", "default");
    assert.equal(await credentials.get("openai", "default"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps Microsoft token cache behind the encrypted credential boundary outside DATA_ROOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-ms-credentials-"));
  try {
    const dataRoot = join(root, "DATA_ROOT");
    const vaultPath = join(root, "userData", "credential-vault.json");
    const primitive = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x55),
      decryptString: (value: Uint8Array) => Buffer.from(Array.from(value, (byte) => byte ^ 0x55)).toString("utf8"),
    };
    const credentials = new ElectronSafeStorageCredentialStore(primitive, vaultPath);
    const tokenCache = new CredentialBackedMicrosoftTokenCache(credentials);
    const serializedCache = JSON.stringify({ access_token: "ms-access", refresh_token: "ms-refresh" });

    await tokenCache.write(serializedCache);

    assert.equal(await tokenCache.read(), serializedCache);
    const vault = await import("node:fs/promises").then(({ readFile }) => readFile(vaultPath, "utf8"));
    assert.equal(vault.includes("ms-access"), false);
    assert.equal(vault.includes("ms-refresh"), false);
    assert.equal(vaultPath.startsWith(dataRoot), false);
    await tokenCache.clear();
    assert.equal(await tokenCache.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
