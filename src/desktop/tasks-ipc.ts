import { TASKS_IPC_CHANNELS } from "./storage-api";
import type { StorageRuntime } from "../storage/StorageRuntime";
import { StorageError } from "../storage/errors";
import type { HubTaskCreateInput, HubTaskStatus, HubTaskUpdateInput } from "../domain/hub";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

export interface TasksIpcDependencies {
  ipcMain: IpcMainLike;
  runtime: StorageRuntime;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
}

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_ASSIGNEE_LENGTH = 200;
const MAX_LIST_LIMIT = 500;

const TASK_STATUSES: readonly HubTaskStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"];

/**
 * Main-process task handlers. Inputs are strictly validated here before the
 * task service; outputs are renderer-safe HubTaskItem DTOs with meeting
 * provenance only. Task edits never carry paths, artifact bytes, or analysis
 * text beyond the task copy itself.
 */
export function registerTasksIpc({
  ipcMain,
  runtime,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
}: TasksIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, secureHandler(async (...args: unknown[]) => {
      try {
        return await listener(...args);
      } catch (error: unknown) {
        throw sanitizeTasksIpcError(error);
      }
    }, getAuthorizedWebContentsId, getAuthorizedRendererUrl));
  };

  handle(TASKS_IPC_CHANNELS.listTasks, (_event: unknown, query: unknown): unknown => {
    const tasks = runtime.requireTasks();
    return tasks.listTasks(readTaskListQuery(query));
  });

  handle(TASKS_IPC_CHANNELS.getTask, (_event: unknown, taskId: unknown): unknown => {
    const id = readId(taskId, "task id");
    return runtime.requireTasks().getTask(id);
  });

  handle(TASKS_IPC_CHANNELS.createTask, (_event: unknown, input: unknown): unknown => {
    return runtime.requireTasks().createTask(readCreateInput(input));
  });

  handle(TASKS_IPC_CHANNELS.updateTask, (_event: unknown, taskId: unknown, patch: unknown): unknown => {
    return runtime.requireTasks().updateTask(readId(taskId, "task id"), readUpdatePatch(patch));
  });

  handle(TASKS_IPC_CHANNELS.setTaskStatus, (_event: unknown, taskId: unknown, status: unknown): unknown => {
    return runtime.requireTasks().setTaskStatus(readId(taskId, "task id"), readStatus(status));
  });

  handle(TASKS_IPC_CHANNELS.listFollowupSuggestions, async (_event: unknown, meetingId: unknown): Promise<unknown> => {
    const scope = meetingId === undefined || meetingId === null ? undefined : readId(meetingId, "meeting id");
    return runtime.requireTasks().listFollowupSuggestions(scope);
  });

  handle(TASKS_IPC_CHANNELS.convertFollowup, async (_event: unknown, followupId: unknown): Promise<unknown> => {
    return runtime.requireTasks().convertFollowupToTask(readId(followupId, "follow-up id"));
  });
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return value.trim();
}

function readStatus(value: unknown): HubTaskStatus {
  if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as HubTaskStatus;
  }
  throw new StorageError("The task status is invalid.");
}

function readTaskListQuery(value: unknown): { meetingId?: string; status?: HubTaskStatus; limit?: number } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("The task list query is invalid.");
  }
  const record = value as Record<string, unknown>;
  const query: { meetingId?: string; status?: HubTaskStatus; limit?: number } = {};
  if (record.meetingId !== undefined) query.meetingId = readId(record.meetingId, "meeting id");
  if (record.status !== undefined) query.status = readStatus(record.status);
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isFinite(record.limit)) {
      throw new StorageError("The task list limit is invalid.");
    }
    query.limit = Math.min(Math.max(1, Math.trunc(record.limit)), MAX_LIST_LIMIT);
  }
  return query;
}

function readCreateInput(value: unknown): HubTaskCreateInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The task input is invalid.");
  }
  const record = value as Record<string, unknown>;
  const meetingId = readId(record.meetingId, "meeting id");
  const text = readRequiredText(record.text, "task text", MAX_TEXT_LENGTH);
  const input: HubTaskCreateInput = { meetingId, text };
  if (record.assignee !== undefined) {
    input.assignee = readOptionalText(record.assignee, "assignee", MAX_ASSIGNEE_LENGTH);
  }
  if (record.dueDate !== undefined) {
    input.dueDate = readOptionalDate(record.dueDate, "due date");
  }
  if (record.sourceArtifactId !== undefined) {
    input.sourceArtifactId = readId(record.sourceArtifactId, "source artifact");
  }
  return input;
}

function readUpdatePatch(value: unknown): HubTaskUpdateInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("The task update is invalid.");
  }
  const record = value as Record<string, unknown>;
  const patch: HubTaskUpdateInput = {};
  if (record.text !== undefined) {
    patch.text = readRequiredText(record.text, "task text", MAX_TEXT_LENGTH);
  }
  if (record.assignee !== undefined) {
    patch.assignee = record.assignee === null ? null : readOptionalText(record.assignee, "assignee", MAX_ASSIGNEE_LENGTH);
  }
  if (record.dueDate !== undefined) {
    patch.dueDate = record.dueDate === null ? null : readOptionalDate(record.dueDate, "due date");
  }
  if (Object.keys(patch).length === 0) {
    throw new StorageError("The task update is empty.");
  }
  return patch;
}

function readRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new StorageError(`The ${label} is invalid.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return text;
}

function readOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    throw new StorageError(`The ${label} is invalid.`);
  }
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (text.length > maxLength) {
    throw new StorageError(`The ${label} is too long.`);
  }
  return text;
}

function readOptionalDate(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    throw new StorageError(`The ${label} is invalid.`);
  }
  const date = value.trim();
  if (date.length === 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new StorageError(`The ${label} must be a YYYY-MM-DD date.`);
  }
  return date;
}

function sanitizeTasksIpcError(error: unknown): Error {
  if (error instanceof StorageError) {
    return error;
  }
  if (error instanceof Error) {
    console.error("Tasks IPC error", error);
  }
  return new StorageError("The task action could not be completed. Please try again.");
}
