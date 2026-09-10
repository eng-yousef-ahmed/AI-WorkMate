import assert from "node:assert/strict";
import { test } from "node:test";

import { rendererErrorContainsFilesystemLeak, sanitizeRendererIpcError } from "../src/desktop/ipc-sanitize";
import { MeetingHubError } from "../src/meetings/MeetingHubService";
import {
  ArchiveSecurityError,
  InsufficientDiskSpaceError,
  StorageError,
  UnsafePathError,
} from "../src/storage/errors";

test("IPC sanitizer withholds filesystem paths and unsafe-path details", () => {
  assert.equal(rendererErrorContainsFilesystemLeak("Unsafe path rejected: /secret/data"), true);
  assert.equal(rendererErrorContainsFilesystemLeak("C:\\Users\\ada\\AI-WorkMate"), true);
  assert.equal(rendererErrorContainsFilesystemLeak("The restore destination must be empty."), false);

  const unsafe = sanitizeRendererIpcError(new UnsafePathError("/secret/data"), "fallback");
  assert.equal(unsafe.message.includes("/secret"), false);
  assert.match(unsafe.message, /not allowed/);

  const space = sanitizeRendererIpcError(new InsufficientDiskSpaceError(0, 100), "fallback");
  assert.match(space.message, /not enough free disk space/i);

  const archive = sanitizeRendererIpcError(
    new ArchiveSecurityError("Unsafe archive entry rejected: C:\\Windows\\system32\\evil.dll"),
    "fallback",
  );
  assert.equal(archive.message.includes("Windows"), false);

  const kept = sanitizeRendererIpcError(new StorageError("The restore destination must be empty."), "fallback");
  assert.equal(kept.message, "The restore destination must be empty.");

  const hub = sanitizeRendererIpcError(
    new MeetingHubError("MEETING_NOT_FOUND", "Meeting not found: meeting-1"),
    "fallback",
    { isAllowed: (error) => error instanceof MeetingHubError },
  );
  assert.equal(hub instanceof MeetingHubError, true);

  const unexpected = sanitizeRendererIpcError(new Error("ENOENT: /tmp/db"), "The storage action could not be completed. Please try again.");
  assert.equal(unexpected.message.includes("/tmp"), false);

  const httpsSignIn = sanitizeRendererIpcError(
    new StorageError("Open this address in your browser: https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc"),
    "fallback",
  );
  assert.match(httpsSignIn.message, /login\.microsoftonline\.com/);
});
