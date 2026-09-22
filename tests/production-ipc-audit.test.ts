import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTOMATION_IPC_CHANNELS, CALENDAR_IPC_CHANNELS, MEETINGS_IPC_CHANNELS, NOTIFICATIONS_IPC_CHANNELS, STORAGE_IPC_CHANNELS, TASKS_IPC_CHANNELS } from "../src/desktop/storage-api";
import { RUNTIME_IPC_CHANNELS } from "../src/desktop/runtime-ipc";

const FORBIDDEN = /llama|llm|openai|model-url|helper-path|access.token|refresh.token|client.secret|data-root|absolute-path/i;

test("every renderer IPC channel name stays free of runtime paths, tokens, and model URLs", () => {
  const channels = [
    ...Object.values(STORAGE_IPC_CHANNELS),
    ...Object.values(MEETINGS_IPC_CHANNELS),
    ...Object.values(CALENDAR_IPC_CHANNELS),
    ...Object.values(TASKS_IPC_CHANNELS),
    ...Object.values(NOTIFICATIONS_IPC_CHANNELS),
    ...Object.values(AUTOMATION_IPC_CHANNELS),
    ...Object.values(RUNTIME_IPC_CHANNELS),
  ];
  assert.ok(channels.length >= 40);
  for (const channel of channels) {
    assert.equal(FORBIDDEN.test(channel), false, channel);
    assert.equal(channel.includes("\\"), false, channel);
    assert.equal(channel.includes("/home/"), false, channel);
  }
  assert.equal(channels.includes("runtime:get-snapshot"), true);
  assert.equal(channels.includes("storage:get-lifecycle"), true);
  assert.equal(channels.some((channel) => channel.startsWith("calendar:")), true);
});
