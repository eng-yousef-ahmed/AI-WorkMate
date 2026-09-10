import assert from "node:assert/strict";
import { test } from "node:test";

import { runWindowsRuntimeWindowCaptureVerification, selectDeterministicWindowSource } from "../src/capture/WindowsRuntimeWindowCaptureVerification";

const NON_WINDOWS_PLATFORM = process.platform === "win32" ? "linux" : process.platform;

test("Windows window capture verification is fail-closed off Windows and does not claim WINDOWS-VERIFIED", async () => {
  const result = await runWindowsRuntimeWindowCaptureVerification({ durationMs: 10, platform: NON_WINDOWS_PLATFORM });
  assert.equal(result.success, false);
  assert.equal(result.windowsVerified, false);
  assert.equal(result.isolatedWorkspace, true);
  assert.equal(result.userDataUntouched, true);
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.failureCode, "NATIVE_PLATFORM_UNSUPPORTED");
});

test("window source selection is deterministic and prefers ordinary windows over the shell desktop", () => {
  const sources = [
    { sourceId: "hwnd:000000000000FFFF", label: "Program Manager", kind: "WINDOW" as const },
    { sourceId: "hwnd:000000000000ABCD", label: "Notepad", kind: "WINDOW" as const },
    { sourceId: "hwnd:0000000000001234", label: "Terminal", kind: "WINDOW" as const },
  ];
  const first = selectDeterministicWindowSource(sources);
  const second = selectDeterministicWindowSource([...sources].reverse());
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  assert.equal(first.sourceId, second.sourceId);
  assert.equal(first.sourceId, "hwnd:0000000000001234");
  assert.equal(first.label, "Terminal");
  assert.equal(selectDeterministicWindowSource(undefined), undefined);
  assert.equal(selectDeterministicWindowSource([]), undefined);
});

test("window source selection falls back to the shell desktop when it is the only window", () => {
  const only = [{ sourceId: "hwnd:000000000000FFFF", label: "Program Manager", kind: "WINDOW" as const }];
  const selected = selectDeterministicWindowSource(only);
  assert.ok(selected !== undefined);
  assert.equal(selected.sourceId, "hwnd:000000000000FFFF");
});
