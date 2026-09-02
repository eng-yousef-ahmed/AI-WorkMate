import assert from "node:assert/strict";
import { test } from "node:test";

import { runWindowsRuntimeCaptureVerification } from "../src/capture/WindowsRuntimeCaptureVerification";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";

test("Windows runtime capture verification fail-closes off Windows without fake media", async () => {
  if (process.platform === "win32") {
    return;
  }
  const result = await runWindowsRuntimeCaptureVerification({ durationMs: 1 });
  assert.equal(result.success, false);
  assert.equal(result.windowsVerified, false);
  assert.equal(result.platform, "linux");
  assert.equal(result.helperFound, false);
  assert.equal(result.isolatedWorkspace, true);
  assert.equal(result.userDataUntouched, true);
  assert.equal(result.failureCode, "NATIVE_PLATFORM_UNSUPPORTED");
  assert.equal(result.captures.length, 0);
  assert.equal(JSON.stringify(result).includes("C:\\"), false);
});

test("Windows runtime capture verification is not exposed as renderer IPC", () => {
  const names = Object.keys(STORAGE_IPC_CHANNELS);
  const values = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(names.some((name) => /nativeCapture|windowsNative|helperProcess/i.test(name)), false);
  assert.equal(values.some((channel) => /native-capture|windows-native|output-path|source-path|helper-path/i.test(channel)), false);
});
