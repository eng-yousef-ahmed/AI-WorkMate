import assert from "node:assert/strict";
import { test } from "node:test";

import type { StorageRuntime } from "../src/storage/StorageRuntime";
import { StorageError } from "../src/storage/errors";
import { TASKS_IPC_CHANNELS } from "../src/desktop/storage-api";
import { registerTasksIpc } from "../src/desktop/tasks-ipc";
import type { HubTaskItem } from "../src/domain/hub";

type IpcHandler = (...args: unknown[]) => unknown;

const AUTHORIZED_EVENT = { sender: { id: 77 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };
const UNAUTHORIZED_EVENT = { sender: { id: 76 }, senderFrame: { url: "file:///AI-WorkMate/storage-settings.html" } };

async function invoke(handlers: Map<string, IpcHandler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return await handler(...args);
}

function taskStub(overrides: Partial<HubTaskItem> = {}): HubTaskItem {
  return {
    taskId: "task-1",
    text: "Verify the backup restore flow",
    status: "OPEN",
    createdAt: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    meetingId: "meeting-1",
    meetingTitle: "Planning sync",
    meetingDate: "2026-09-07",
    sourceKind: "ANALYSIS_TASKS",
    analysisDate: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

interface TasksStubOptions {
  listError?: unknown;
  createError?: unknown;
  task?: HubTaskItem;
  suggestions?: unknown;
}

function createStubs(options: TasksStubOptions = {}): {
  calls: string[];
  runtime: StorageRuntime;
} {
  const calls: string[] = [];
  const task = options.task ?? taskStub();
  const tasks = {
    listTasks: (query: unknown) => {
      calls.push(`listTasks:${JSON.stringify(query ?? {})}`);
      if (options.listError !== undefined) throw options.listError;
      return [task];
    },
    getTask: (id: string) => { calls.push(`getTask:${id}`); return options.task ?? taskStub({ taskId: id }); },
    createTask: (input: unknown) => {
      const record = input as { text: string };
      calls.push(`createTask:${record.text}`);
      if (options.createError !== undefined) throw options.createError;
      return { ...task, text: record.text };
    },
    updateTask: (id: string) => { calls.push(`updateTask:${id}`); return task; },
    setTaskStatus: (id: string, status: string) => { calls.push(`setTaskStatus:${id}:${status}`); return { ...task, status }; },
    listFollowupSuggestions: (meetingId: unknown) => { calls.push(`listFollowups:${String(meetingId ?? "all")}`); return options.suggestions ?? []; },
    convertFollowupToTask: async (followupId: string) => { calls.push(`convertFollowup:${followupId}`); return task; },
  } as unknown as StorageRuntime["tasks"];

  const runtime = {
    requireTasks: () => tasks,
  } as unknown as StorageRuntime;
  return { calls, runtime };
}

function register(runtime: StorageRuntime): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerTasksIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  return handlers;
}

test("tasks IPC routes listing and follow-ups only from the authorized renderer", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);

  const listed = await invoke(handlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT, { status: "OPEN" }) as HubTaskItem[];
  assert.equal(listed[0]?.taskId, "task-1");
  assert.deepEqual(calls, [`listTasks:${JSON.stringify({ status: "OPEN" })}`]);

  await invoke(handlers, TASKS_IPC_CHANNELS.listFollowupSuggestions, AUTHORIZED_EVENT);
  assert.deepEqual(calls, [`listTasks:${JSON.stringify({ status: "OPEN" })}`, "listFollowups:all"]);

  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.listTasks, UNAUTHORIZED_EVENT),
    /unauthorized renderer/,
  );
  assert.equal(calls.length, 2);
});

test("tasks IPC validates ids, statuses, inputs and list queries before the service", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);

  for (const bad of [undefined, "", "  ", 42, null, "x".repeat(300)]) {
    await assert.rejects(
      invoke(handlers, TASKS_IPC_CHANNELS.getTask, AUTHORIZED_EVENT, bad),
      /invalid/i,
    );
  }
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.setTaskStatus, AUTHORIZED_EVENT, "task-1", "PAUSED"),
    /invalid/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.setTaskStatus, AUTHORIZED_EVENT, "task-1", 3),
    /invalid/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT, { status: "NOPE" }),
    /invalid/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT, { meetingId: "" }),
    /invalid/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT, { limit: Number.NaN }),
    /invalid/i,
  );
  assert.deepEqual(calls, []);
});

test("tasks IPC create and update validate text, assignee and due date", async () => {
  const { calls, runtime } = createStubs();
  const handlers = register(runtime);

  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, { meetingId: "m-1", text: "" }),
    /task text is invalid/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, { meetingId: "m-1", text: "ok", dueDate: "2026-2-1" }),
    /YYYY-MM-DD/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, { meetingId: "m-1", text: "ok", assignee: "a".repeat(300) }),
    /too long/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.updateTask, AUTHORIZED_EVENT, "task-1", {}),
    /update is empty/i,
  );
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, "not-an-object"),
    /invalid/i,
  );
  assert.deepEqual(calls, []);

  const created = await invoke(handlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, {
    meetingId: "meeting-1",
    text: "  Verify restore  ",
    assignee: "Ada",
    dueDate: "2026-10-01",
  });
  assert.equal((created as HubTaskItem).text, "Verify restore");
  assert.deepEqual(calls, ["createTask:Verify restore"]);

  await invoke(handlers, TASKS_IPC_CHANNELS.updateTask, AUTHORIZED_EVENT, "task-1", { assignee: null });
  await invoke(handlers, TASKS_IPC_CHANNELS.setTaskStatus, AUTHORIZED_EVENT, "task-1", "DONE");
  assert.deepEqual(calls, ["createTask:Verify restore", "updateTask:task-1", "setTaskStatus:task-1:DONE"]);
});

test("tasks IPC sanitizes service failures", async () => {
  const failing = createStubs({ listError: new Error("C:\\Users\\ada\\secret task internals") });
  const failingHandlers = register(failing.runtime);
  await assert.rejects(
    invoke(failingHandlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT),
    /could not be completed/,
  );

  const storageError = createStubs({ createError: new StorageError("The originating meeting does not exist.") });
  const storageHandlers = register(storageError.runtime);
  await assert.rejects(
    invoke(storageHandlers, TASKS_IPC_CHANNELS.createTask, AUTHORIZED_EVENT, { meetingId: "ghost", text: "x" }),
    /originating meeting does not exist/,
  );
});

test("tasks IPC requires a data location before use", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerTasksIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    runtime: {
      requireTasks: () => {
        throw new StorageError("Choose a local data location before using tasks.");
      },
    } as unknown as StorageRuntime,
    getAuthorizedWebContentsId: () => 77,
    getAuthorizedRendererUrl: () => "file:///AI-WorkMate/storage-settings.html",
  });
  await assert.rejects(
    invoke(handlers, TASKS_IPC_CHANNELS.listTasks, AUTHORIZED_EVENT),
    /Choose a local data location before using tasks/,
  );
});
