import assert from "node:assert/strict";
import { test } from "node:test";

import { runWindowsRuntimeScreenCaptureVerification } from "../src/capture/WindowsRuntimeScreenCaptureVerification";

const NON_WINDOWS_PLATFORM = process.platform === "win32" ? "linux" : process.platform;

test("Windows screen capture verification is fail-closed off Windows and does not claim WINDOWS-VERIFIED", async () => {
  const result = await runWindowsRuntimeScreenCaptureVerification({ durationMs: 10, platform: NON_WINDOWS_PLATFORM });
  assert.equal(result.success, false);
  assert.equal(result.windowsVerified, false);
  assert.equal(result.isolatedWorkspace, true);
  assert.equal(result.userDataUntouched, true);
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.failureCode, "NATIVE_PLATFORM_UNSUPPORTED");
});
