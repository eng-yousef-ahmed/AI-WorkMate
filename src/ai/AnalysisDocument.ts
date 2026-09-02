import type { ActionItem, AnalysisDocument, Decision } from "../domain/models";
import { DataRootValidationError, StorageError } from "../storage/errors";

const TASK_STATUSES = new Set(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]);

export const ANALYSIS_DOCUMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["meetingId", "createdAt", "summary", "decisions", "tasks", "risks", "questions", "followups"],
  properties: {
    meetingId: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    summary: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decisionId", "text"],
        properties: {
          decisionId: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          owner: { type: "string" },
          decidedAt: { type: "string" },
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "text"],
        properties: {
          taskId: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          assignee: { type: "string" },
          dueDate: { type: "string" },
          status: { type: "string", enum: ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    followups: { type: "array", items: { type: "string" } },
  },
} as const;

export function parseAnalysisDocument(output: string, expectedMeetingId: string): AnalysisDocument {
  const jsonText = unwrapJsonObjectText(output);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
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

export function unwrapJsonObjectText(stdout: string): string {
  const fenced = stdout.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? stdout;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return candidate.trim();
  }
  return candidate.slice(start, end + 1);
}

export function describeJsonValueShape(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  if (type !== "object") {
    return type;
  }
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 12);
  const fields = keys.map((key) => `${key}:${typeof (value as Record<string, unknown>)[key]}`);
  return `object{${fields.join(",")}}`;
}

function parseDecisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) {
    throw new DataRootValidationError("Analysis decisions must be an array.");
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DataRootValidationError(`Invalid decision at index ${index}: expected object, received ${describeJsonValueShape(item)}.`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.decisionId !== "string" || row.decisionId.trim().length === 0) {
      throw new DataRootValidationError(`Invalid decision at index ${index}: decisionId must be a non-empty string (received ${describeJsonValueShape(row.decisionId)}).`);
    }
    if (typeof row.text !== "string" || row.text.trim().length === 0) {
      throw new DataRootValidationError(`Invalid decision at index ${index}: text must be a non-empty string (received ${describeJsonValueShape(row.text)}).`);
    }
    const decision: Decision = { decisionId: row.decisionId, text: row.text };
    if (row.owner !== undefined) {
      if (typeof row.owner !== "string") {
        throw new DataRootValidationError(`Invalid decision owner at index ${index}: expected string, received ${describeJsonValueShape(row.owner)}.`);
      }
      decision.owner = row.owner;
    }
    if (row.decidedAt !== undefined) {
      if (typeof row.decidedAt !== "string") {
        throw new DataRootValidationError(`Invalid decision decidedAt at index ${index}: expected string, received ${describeJsonValueShape(row.decidedAt)}.`);
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
      throw new DataRootValidationError(`Invalid task at index ${index}: expected object with taskId and text strings, received ${describeJsonValueShape(item)}.`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.taskId !== "string" || row.taskId.trim().length === 0) {
      throw new DataRootValidationError(
        `Invalid task at index ${index}: taskId must be a non-empty string (received ${describeJsonValueShape(row.taskId)}; shape ${describeJsonValueShape(row)}).`,
      );
    }
    if (typeof row.text !== "string" || row.text.trim().length === 0) {
      throw new DataRootValidationError(
        `Invalid task at index ${index}: text must be a non-empty string (received ${describeJsonValueShape(row.text)}; shape ${describeJsonValueShape(row)}).`,
      );
    }
    const task: ActionItem = { taskId: row.taskId, text: row.text };
    if (row.assignee !== undefined && row.assignee !== null) {
      if (typeof row.assignee !== "string") {
        throw new DataRootValidationError(`Invalid task assignee at index ${index}: expected string, received ${describeJsonValueShape(row.assignee)}.`);
      }
      task.assignee = row.assignee;
    }
    if (row.dueDate !== undefined && row.dueDate !== null) {
      if (typeof row.dueDate !== "string") {
        throw new DataRootValidationError(`Invalid task dueDate at index ${index}: expected string, received ${describeJsonValueShape(row.dueDate)}.`);
      }
      task.dueDate = row.dueDate;
    }
    if (row.status !== undefined && row.status !== null) {
      if (typeof row.status !== "string" || !TASK_STATUSES.has(row.status)) {
        throw new DataRootValidationError(
          `Invalid task status at index ${index}: expected OPEN|IN_PROGRESS|DONE|CANCELLED, received ${describeJsonValueShape(row.status)}.`,
        );
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
