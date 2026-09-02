import type { ActionItem, AnalysisDocument, Decision } from "../domain/models";
import { DataRootValidationError, StorageError } from "../storage/errors";

const TASK_STATUSES = new Set(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]);

export function parseAnalysisDocument(output: string, expectedMeetingId: string): AnalysisDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error: unknown) {
    throw new StorageError("AI provider returned invalid analysis JSON; nothing was persisted.", { cause: error });
  }
  const document = validateAnalysisDocument(parsed);
  if (document.meetingId !== expectedMeetingId) {
    throw new StorageError("AI provider returned analysis for the wrong meeting.");
  }
  return document;
}

export function validateAnalysisDocument(value: unknown): AnalysisDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DataRootValidationError("Analysis must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.meetingId !== "string" || record.meetingId.trim().length === 0) {
    throw new DataRootValidationError("Analysis must include meetingId.");
  }
  if (typeof record.createdAt !== "string" || record.createdAt.trim().length === 0) {
    throw new DataRootValidationError("Analysis must include createdAt.");
  }
  if (typeof record.summary !== "string") {
    throw new DataRootValidationError("Analysis must include a summary string.");
  }
  const document: AnalysisDocument = {
    meetingId: record.meetingId,
    createdAt: record.createdAt,
    summary: record.summary,
    decisions: parseDecisions(record.decisions),
    tasks: parseTasks(record.tasks),
    risks: parseStringList(record.risks, "risks"),
    questions: parseStringList(record.questions, "questions"),
    followups: parseStringList(record.followups, "followups"),
  };
  return document;
}

function parseDecisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) {
    throw new DataRootValidationError("Analysis decisions must be an array.");
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DataRootValidationError(`Invalid decision at index ${index}.`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.decisionId !== "string" || row.decisionId.trim().length === 0 || typeof row.text !== "string" || row.text.trim().length === 0) {
      throw new DataRootValidationError(`Invalid decision at index ${index}.`);
    }
    const decision: Decision = { decisionId: row.decisionId, text: row.text };
    if (row.owner !== undefined) {
      if (typeof row.owner !== "string") {
        throw new DataRootValidationError(`Invalid decision owner at index ${index}.`);
      }
      decision.owner = row.owner;
    }
    if (row.decidedAt !== undefined) {
      if (typeof row.decidedAt !== "string") {
        throw new DataRootValidationError(`Invalid decision decidedAt at index ${index}.`);
      }
      decision.decidedAt = row.decidedAt;
    }
    return decision;
  });
}

function parseTasks(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) {
    throw new DataRootValidationError("Analysis tasks must be an array.");
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DataRootValidationError(`Invalid task at index ${index}.`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.taskId !== "string" || row.taskId.trim().length === 0 || typeof row.text !== "string" || row.text.trim().length === 0) {
      throw new DataRootValidationError(`Invalid task at index ${index}.`);
    }
    const task: ActionItem = { taskId: row.taskId, text: row.text };
    if (row.assignee !== undefined) {
      if (typeof row.assignee !== "string") {
        throw new DataRootValidationError(`Invalid task assignee at index ${index}.`);
      }
      task.assignee = row.assignee;
    }
    if (row.dueDate !== undefined) {
      if (typeof row.dueDate !== "string") {
        throw new DataRootValidationError(`Invalid task dueDate at index ${index}.`);
      }
      task.dueDate = row.dueDate;
    }
    if (row.status !== undefined) {
      if (typeof row.status !== "string" || !TASK_STATUSES.has(row.status)) {
        throw new DataRootValidationError(`Invalid task status at index ${index}.`);
      }
      task.status = row.status as ActionItem["status"];
    }
    return task;
  });
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DataRootValidationError(`Analysis ${field} must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new DataRootValidationError(`Analysis ${field}[${index}] must be a string.`);
    }
    return item;
  });
}
