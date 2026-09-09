import { randomUUID } from "node:crypto";

import type {
  HubFollowupSuggestion,
  HubTaskCreateInput,
  HubTaskItem,
  HubTaskSourceKind,
  HubTaskStatus,
  HubTaskUpdateInput,
} from "../domain/hub";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import type { TaskRecord } from "../storage/LocalDatabase";
import { StorageError } from "../storage/errors";

export const MAX_TASK_TEXT_LENGTH = 2000;
export const MAX_TASK_ASSIGNEE_LENGTH = 200;
export const MAX_TASK_LIST_RESULTS = 500;
export const MAX_FOLLOWUP_SUGGESTIONS = 100;
export const MAX_FOLLOWUP_ARTIFACT_BYTES = 512 * 1024;

const TASK_STATUSES: readonly HubTaskStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"];

/** Allowed transitions; reopening a finished/cancelled task is explicit. */
const TASK_STATUS_TRANSITIONS: Record<HubTaskStatus, readonly HubTaskStatus[]> = {
  OPEN: ["IN_PROGRESS", "DONE", "CANCELLED"],
  IN_PROGRESS: ["DONE", "CANCELLED", "OPEN"],
  DONE: ["OPEN"],
  CANCELLED: ["OPEN"],
};

export interface TaskListOptions {
  meetingId?: string;
  status?: HubTaskStatus;
  limit?: number;
}

/**
 * Task and follow-up management over the persisted tasks table.
 *
 * Every task keeps meeting provenance (its originating meeting). Tasks that
 * were extracted by a meeting analysis, or converted from an analysis
 * follow-up, additionally point at the persisted analysis artifact that
 * produced them, and the list view resolves that artifact back to the
 * analysis date for display. Tasks never contain absolute paths or raw
 * analysis text beyond the task copy itself.
 */
export class TaskManagementService {
  private readonly store: LocalFirstStore;
  private readonly clock: () => Date;

  public constructor(options: { store: LocalFirstStore; clock?: () => Date }) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
  }

  public listTasks(options: TaskListOptions = {}): HubTaskItem[] {
    const meetingId = options.meetingId === undefined ? undefined : validateMeeting(this.store, options.meetingId);
    const status = options.status === undefined ? undefined : parseTaskStatus(options.status);
    const limit = options.limit === undefined
      ? MAX_TASK_LIST_RESULTS
      : Math.min(Math.max(1, Math.trunc(options.limit)), MAX_TASK_LIST_RESULTS);
    const records = this.store.listAllTasks().filter((record) => {
      if (meetingId !== undefined && record.meetingId !== meetingId) return false;
      if (status !== undefined && record.status !== status) return false;
      return true;
    });
    return sortTasks(this.toTaskItems(records)).slice(0, limit);
  }

  public getTask(taskId: string): HubTaskItem | undefined {
    const record = readTaskRecord(this.store, taskId);
    return record === undefined ? undefined : this.toTaskItem(record);
  }

  public createTask(input: HubTaskCreateInput): HubTaskItem {
    const meetingId = validateMeeting(this.store, input.meetingId);
    const text = normalizeRequiredText(input.text, "task text");
    const assignee = normalizeOptionalText(input.assignee, "assignee", MAX_TASK_ASSIGNEE_LENGTH);
    const dueDate = normalizeDueDate(input.dueDate);
    const sourceArtifactId = input.sourceArtifactId === undefined ? undefined : validateSourceArtifact(this.store, meetingId, input.sourceArtifactId);
    const now = this.clock().toISOString();
    const record: TaskRecord = {
      taskId: randomUUID(),
      meetingId,
      text,
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    };
    if (assignee !== undefined) record.assignee = assignee;
    if (dueDate !== undefined) record.dueDate = dueDate;
    if (sourceArtifactId !== undefined) record.sourceArtifactId = sourceArtifactId;
    this.store.registerTaskRecord(record);
    return this.toTaskItem(record);
  }

  public updateTask(taskId: string, patch: HubTaskUpdateInput): HubTaskItem {
    requireTask(this.store, taskId);
    const update: { text?: string; assignee?: string | null; dueDate?: string | null } = {};
    if (patch.text !== undefined) {
      update.text = normalizeRequiredText(patch.text, "task text");
    }
    if (patch.assignee !== undefined) {
      update.assignee = patch.assignee === null ? null : normalizeOptionalText(patch.assignee, "assignee", MAX_TASK_ASSIGNEE_LENGTH) ?? null;
    }
    if (patch.dueDate !== undefined) {
      update.dueDate = patch.dueDate === null ? null : normalizeDueDate(patch.dueDate) ?? null;
    }
    const updated = this.store.updateTaskRecord(taskId, { ...update, updatedAt: this.clock().toISOString() });
    if (updated === undefined) {
      throw new StorageError("The task no longer exists.");
    }
    return this.toTaskItem(updated);
  }

  public setTaskStatus(taskId: string, status: HubTaskStatus): HubTaskItem {
    const record = requireTask(this.store, taskId);
    const next = parseTaskStatus(status);
    if (record.status !== next) {
      const allowed = TASK_STATUS_TRANSITIONS[record.status as HubTaskStatus] ?? [];
      if (!allowed.includes(next)) {
        throw new StorageError(`A ${record.status} task can only move to: ${allowed.join(", ")}.`);
      }
      const updated = this.store.updateTaskRecord(taskId, { status: next, updatedAt: this.clock().toISOString() });
      if (updated === undefined) {
        throw new StorageError("The task no longer exists.");
      }
      return this.toTaskItem(updated);
    }
    return this.toTaskItem(record);
  }

  /**
   * Analysis follow-ups offered for conversion. Only the newest follow-up
   * artifact of each meeting is offered, and entries already converted to a
   * task (same meeting + artifact + text) are flagged rather than duplicated.
   */
  public async listFollowupSuggestions(meetingId?: string): Promise<HubFollowupSuggestion[]> {
    const scopedMeetingId = meetingId === undefined ? undefined : validateMeeting(this.store, meetingId);
    const meetings = this.store.listMeetings()
      .filter((meeting) => scopedMeetingId === undefined || meeting.meetingId === scopedMeetingId)
      .sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || b.createdAt.localeCompare(a.createdAt));
    const artifactsById = new Map(this.store.database.listArtifacts().map((artifact) => [artifact.fileId, artifact]));
    const existingBySource = new Map<string, Set<string>>();
    for (const record of this.store.listAllTasks()) {
      if (record.sourceArtifactId === undefined) continue;
      const key = `${record.meetingId}:${record.sourceArtifactId}`;
      let texts = existingBySource.get(key);
      if (texts === undefined) {
        texts = new Set();
        existingBySource.set(key, texts);
      }
      texts.add(normalizeWhitespaceKey(record.text));
    }

    const suggestions: HubFollowupSuggestion[] = [];
    for (const meeting of meetings) {
      if (suggestions.length >= MAX_FOLLOWUP_SUGGESTIONS) break;
      const records = this.store.database.listAnalysis(meeting.meetingId)
        .filter((record) => record.kind === "FOLLOWUPS")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = records[0];
      if (latest === undefined) continue;
      const artifact = artifactsById.get(latest.artifactId);
      if (artifact === undefined || artifact.status !== "AVAILABLE" || artifact.size > MAX_FOLLOWUP_ARTIFACT_BYTES) continue;
      let followups: string[];
      try {
        followups = parseFollowupArtifact(Buffer.from(await this.store.readArtifactBytes(artifact.relativePath)).toString("utf8"));
      } catch {
        continue;
      }
      const converted = existingBySource.get(`${meeting.meetingId}:${latest.artifactId}`) ?? new Set();
      for (let index = 0; index < followups.length; index += 1) {
        if (suggestions.length >= MAX_FOLLOWUP_SUGGESTIONS) break;
        const text = followups[index]!.trim();
        if (text.length === 0) continue;
        suggestions.push({
          followupId: `${latest.artifactId}:${index}`,
          meetingId: meeting.meetingId,
          meetingTitle: meeting.title,
          meetingDate: meeting.meetingDate,
          analysisDate: latest.createdAt,
          sourceArtifactFileId: latest.artifactId,
          text,
          alreadyTask: converted.has(normalizeWhitespaceKey(text)),
        });
      }
    }
    return suggestions;
  }

  /** Converts a follow-up suggestion into a managed task with provenance. */
  public async convertFollowupToTask(followupId: string): Promise<HubTaskItem> {
    const separator = followupId.lastIndexOf(":");
    if (separator <= 0) {
      throw new StorageError("The follow-up suggestion is invalid.");
    }
    const artifactFileId = followupId.slice(0, separator);
    const indexText = followupId.slice(separator + 1);
    if (!/^\d+$/.test(indexText)) {
      throw new StorageError("The follow-up suggestion is invalid.");
    }
    const index = Number(indexText);
    const artifact = this.store.database.listArtifacts().find((candidate) => candidate.fileId === artifactFileId);
    if (artifact === undefined) {
      throw new StorageError("The follow-up suggestion no longer exists.");
    }
    const analysis = this.store.database.listAnalysis(artifact.meetingId)
      .find((candidate) => candidate.artifactId === artifactFileId && candidate.kind === "FOLLOWUPS");
    if (analysis === undefined) {
      throw new StorageError("The follow-up suggestion is no longer part of a meeting analysis.");
    }
    let text: string;
    try {
      const parsed = parseFollowupArtifact(Buffer.from(await this.store.readArtifactBytes(artifact.relativePath)).toString("utf8"));
      const value = parsed[index];
      if (value === undefined) {
        throw new StorageError("The follow-up suggestion no longer exists.");
      }
      text = value.trim();
    } catch (error: unknown) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("The follow-up suggestion could not be read.");
    }
    if (text.length === 0) {
      throw new StorageError("The follow-up suggestion is empty.");
    }
    // Idempotent: converting the same follow-up twice never duplicates it.
    const normalized = normalizeWhitespaceKey(text);
    const existing = this.store.listAllTasks().find((candidate) =>
      candidate.meetingId === artifact.meetingId &&
      candidate.sourceArtifactId === artifact.fileId &&
      normalizeWhitespaceKey(candidate.text) === normalized);
    if (existing !== undefined) {
      const prior = this.toTaskItem(existing);
      prior.analysisDate = analysis.createdAt;
      return prior;
    }
    const now = this.clock().toISOString();
    const recordTask: TaskRecord = {
      taskId: randomUUID(),
      meetingId: artifact.meetingId,
      text,
      status: "OPEN",
      sourceArtifactId: artifact.fileId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.registerTaskRecord(recordTask);
    const item = this.toTaskItem(recordTask);
    item.analysisDate = analysis.createdAt;
    return item;
  }

  /** Bulk mapping keeps list rendering at O(1) lookups per task. */
  private toTaskItems(records: TaskRecord[]): HubTaskItem[] {
    const meetings = new Map(this.store.listMeetings().map((item) => [item.meetingId, item]));
    const artifacts = new Map(this.store.database.listArtifacts().map((item) => [item.fileId, item]));
    const latestTaskAnalyses = new Map<string, string>();
    const analysisDateByArtifact = new Map<string, string>();
    for (const meeting of meetings.values()) {
      let latest = "";
      for (const analysis of this.store.database.listAnalysis(meeting.meetingId)) {
        if (analysis.kind === "TASKS" && analysis.createdAt > latest) {
          latest = analysis.createdAt;
        }
        if (analysis.kind === "TASKS" || analysis.kind === "FOLLOWUPS") {
          const existing = analysisDateByArtifact.get(analysis.artifactId);
          if (existing === undefined || analysis.createdAt > existing) {
            analysisDateByArtifact.set(analysis.artifactId, analysis.createdAt);
          }
        }
      }
      if (latest.length > 0) latestTaskAnalyses.set(meeting.meetingId, latest);
    }
    return records.map((record) => {
      const resolved = meetings.get(record.meetingId);
      const item: HubTaskItem = {
        taskId: record.taskId,
        text: record.text,
        status: (record.status ?? "OPEN") as HubTaskStatus,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        meetingId: record.meetingId,
        meetingTitle: resolved?.title ?? "Unknown meeting",
        meetingDate: resolved?.meetingDate ?? "",
        sourceKind: "MANUAL",
      };
      if (record.assignee !== undefined) item.assignee = record.assignee;
      if (record.dueDate !== undefined) item.dueDate = record.dueDate;
      if (record.sourceArtifactId !== undefined) {
        const artifact = artifacts.get(record.sourceArtifactId);
        if (artifact !== undefined) {
          item.sourceKind = (artifact.artifactType === "ANALYSIS_FOLLOWUPS" ? "ANALYSIS_FOLLOWUPS" : "ANALYSIS_TASKS") as HubTaskSourceKind;
          const analysisDate = analysisDateByArtifact.get(record.sourceArtifactId);
          if (analysisDate !== undefined) item.analysisDate = analysisDate;
        }
      } else {
        // Legacy rows were written by analysis persistence; use the meeting's
        // latest analysis date when one exists.
        const latest = latestTaskAnalyses.get(record.meetingId);
        if (latest !== undefined) {
          item.sourceKind = "ANALYSIS_TASKS";
          item.analysisDate = latest;
        }
      }
      return item;
    });
  }

  private toTaskItem(record: TaskRecord): HubTaskItem {
    return this.toTaskItems([record])[0]!;
  }
}

export function sortTasks(items: HubTaskItem[]): HubTaskItem[] {
  const activeRank = (status: HubTaskStatus): number => (status === "OPEN" || status === "IN_PROGRESS") ? 0 : 1;
  return [...items].sort((a, b) => {
    const rank = activeRank(a.status) - activeRank(b.status);
    if (rank !== 0) return rank;
    if (a.dueDate !== undefined && b.dueDate !== undefined) {
      const due = a.dueDate.localeCompare(b.dueDate);
      if (due !== 0) return due;
    } else if (a.dueDate !== undefined) {
      return -1;
    } else if (b.dueDate !== undefined) {
      return 1;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function parseFollowupArtifact(content: string): string[] {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new StorageError("The follow-up artifact is malformed.");
  }
  const values: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      throw new StorageError("The follow-up artifact is malformed.");
    }
    values.push(entry);
  }
  return values;
}

function validateMeeting(store: LocalFirstStore, meetingId: string): string {
  if (typeof meetingId !== "string" || meetingId.trim().length === 0 || meetingId.length > 128) {
    throw new StorageError("The meeting id is invalid.");
  }
  if (store.getMeeting(meetingId.trim()) === undefined) {
    throw new StorageError("The originating meeting does not exist.");
  }
  return meetingId.trim();
}

function parseTaskStatus(value: unknown): HubTaskStatus {
  if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as HubTaskStatus;
  }
  throw new StorageError("The task status is invalid.");
}

function normalizeRequiredText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new StorageError(`The ${label} is invalid.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_TASK_TEXT_LENGTH) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return text;
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
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

function normalizeDueDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new StorageError("The due date is invalid.");
  }
  const date = value.trim();
  if (date.length === 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new StorageError("The due date must be a YYYY-MM-DD date.");
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new StorageError("The due date is not a real calendar date.");
  }
  return date;
}

function validateSourceArtifact(store: LocalFirstStore, meetingId: string, artifactFileId: string): string {
  if (typeof artifactFileId !== "string" || artifactFileId.trim().length === 0 || artifactFileId.length > 200) {
    throw new StorageError("The task source artifact is invalid.");
  }
  const artifact = store.database.listArtifacts(meetingId)
    .find((candidate) => candidate.fileId === artifactFileId.trim());
  if (artifact === undefined) {
    throw new StorageError("The task source artifact does not belong to the originating meeting.");
  }
  return artifact.fileId;
}

function readTaskRecord(store: LocalFirstStore, taskId: string): TaskRecord | undefined {
  if (typeof taskId !== "string" || taskId.trim().length === 0 || taskId.length > 128) {
    throw new StorageError("The task id is invalid.");
  }
  return store.getTaskRecord(taskId.trim());
}

function requireTask(store: LocalFirstStore, taskId: string): TaskRecord {
  const record = readTaskRecord(store, taskId);
  if (record === undefined) {
    throw new StorageError("The task no longer exists.");
  }
  return record;
}

function normalizeWhitespaceKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
