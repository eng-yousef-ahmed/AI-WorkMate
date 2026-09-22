import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisDocument, CalendarEventAssociation, Meeting } from "../domain/models";
import type { HubOfficeExportKind, HubOfficeExportResult } from "../domain/hub";
import { DataRootValidationError, StorageError } from "../storage/errors";
import { isPathInside, normalizeAbsolutePath } from "../storage/LocalStorageService";
import { assertDirectoryHasSpace } from "../storage/disk-space";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { HUB_MAX_ANALYSIS_READ_BYTES } from "../domain/hub";

const MAX_FILENAME_SLUG = 48;

/**
 * Practical Office exports written outside DATA_ROOT:
 * - Word-compatible HTML summary
 * - Excel-friendly CSV of tasks
 * - PowerPoint-style HTML briefing (one section per slide)
 *
 * Meeting content stays local. No cloud conversion service is used.
 */
export class OfficeExportService {
  public constructor(
    private readonly store: LocalFirstStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async exportMeetingDocument(
    meetingId: string,
    kind: HubOfficeExportKind,
    exportDirectory: string,
  ): Promise<HubOfficeExportResult> {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new DataRootValidationError(`Meeting not found: ${meetingId}`);
    }
    const directory = await this.validateExportDirectory(exportDirectory);
    const association = this.store.database.listCalendarEventAssociations(meetingId)[0];
    const analysis = await this.loadAnalysis(meetingId);
    const tasks = this.store.database.listTasks(meetingId);
    const decisions = this.store.database.listDecisions(meetingId);
    const slug = sanitizeFilename(meeting.slug || meeting.title);
    if (kind === "WORD_SUMMARY") {
      const filename = `meeting_${meetingId}_${slug}_summary.doc.html`;
      const body = renderWordHtml({ meeting, association, analysis, decisions, tasks, exportedAt: this.clock().toISOString() });
      return this.writeFile(directory, filename, body, "application/msword");
    }
    if (kind === "EXCEL_TASKS") {
      const filename = `meeting_${meetingId}_${slug}_tasks.csv`;
      const body = renderTasksCsv({ meeting, tasks });
      return this.writeFile(directory, filename, body, "text/csv");
    }
    const filename = `meeting_${meetingId}_${slug}_briefing.html`;
    const body = renderBriefingHtml({ meeting, association, analysis, decisions, tasks, exportedAt: this.clock().toISOString() });
    return this.writeFile(directory, filename, body, "text/html");
  }

  private async loadAnalysis(meetingId: string): Promise<AnalysisDocument | undefined> {
    const artifacts = this.store.database.listArtifacts(meetingId)
      .filter((artifact) => artifact.artifactType === "ANALYSIS_SUMMARY_JSON" && artifact.status === "AVAILABLE")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summary = artifacts[0];
    if (summary === undefined || summary.size > HUB_MAX_ANALYSIS_READ_BYTES) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(Buffer.from(await this.store.readArtifactBytes(summary.relativePath)).toString("utf8")) as AnalysisDocument;
      if (typeof parsed.summary !== "string") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writeFile(
    directory: string,
    filename: string,
    contents: string,
    mimeType: string,
  ): Promise<HubOfficeExportResult> {
    const target = join(directory, filename);
    if (isPathInside(this.store.storage.dataRoot, target) || isPathInside(target, this.store.storage.dataRoot)) {
      throw new DataRootValidationError("Office exports must be written outside DATA_ROOT.");
    }
    const payload = Buffer.from(contents, "utf8");
    await assertDirectoryHasSpace(directory, payload.byteLength, this.store.storage.spaceSafetyMarginBytes);
    await writeFile(target, payload, { flag: "wx" });
    return { kind: mimeType === "text/csv" ? "EXCEL_TASKS" : mimeType === "application/msword" ? "WORD_SUMMARY" : "POWERPOINT_BRIEFING", filename, size: payload.byteLength, mimeType };
  }

  private async validateExportDirectory(value: string): Promise<string> {
    const directory = normalizeAbsolutePath(value);
    if (isPathInside(this.store.storage.dataRoot, directory) || isPathInside(directory, this.store.storage.dataRoot)) {
      throw new DataRootValidationError("Office exports must be written outside DATA_ROOT.");
    }
    await mkdir(directory, { recursive: true });
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new DataRootValidationError("The export location is not a folder.");
    }
    return directory;
  }
}

interface OfficeExportContext {
  meeting: Meeting;
  association?: CalendarEventAssociation;
  analysis?: AnalysisDocument;
  decisions: Array<{ text: string; owner?: string }>;
  tasks: Array<{ text: string; assignee?: string; dueDate?: string; status?: string }>;
  exportedAt: string;
}

function renderWordHtml(context: OfficeExportContext): string {
  const title = escapeHtml(context.meeting.title);
  const summary = escapeHtml(context.analysis?.summary ?? "No local analysis is available for this meeting yet.");
  const attendees = (context.association?.attendees ?? [])
    .map((attendee) => attendee.displayName ?? attendee.email)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const decisions = context.analysis?.decisions?.length ? context.analysis.decisions : context.decisions;
  const tasks = context.analysis?.tasks?.length ? context.analysis.tasks : context.tasks;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #222; }
  h1 { font-size: 20pt; }
  h2 { font-size: 14pt; border-bottom: 1px solid #ccc; }
  p, li { line-height: 1.4; }
  .meta { color: #555; font-size: 10pt; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">Exported ${escapeHtml(context.exportedAt)} from AI WorkMate (local only).</p>
${context.association === undefined ? "" : `<p class="meta">${escapeHtml(context.association.startTime)} – ${escapeHtml(context.association.endTime)}${context.association.location ? ` · ${escapeHtml(context.association.location)}` : ""}</p>`}
${attendees.length === 0 ? "" : `<p><strong>Attendees:</strong> ${attendees.map((name) => escapeHtml(name)).join(", ")}</p>`}
<h2>Summary</h2>
<p>${summary}</p>
${renderListSection("Decisions", decisions.map((item) => item.text + (item.owner ? ` (${item.owner})` : "")))}
${renderListSection("Tasks", tasks.map((item) => formatTaskLine(item)))}
${renderListSection("Risks", context.analysis?.risks ?? [])}
${renderListSection("Questions", context.analysis?.questions ?? [])}
${renderListSection("Follow-ups", context.analysis?.followups ?? [])}
</body>
</html>
`;
}

function renderBriefingHtml(context: OfficeExportContext): string {
  const title = escapeHtml(context.meeting.title);
  const summary = escapeHtml(context.analysis?.summary ?? "No local analysis is available yet.");
  const decisions = context.analysis?.decisions?.length ? context.analysis.decisions : context.decisions;
  const tasks = context.analysis?.tasks?.length ? context.analysis.tasks : context.tasks;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title} — briefing</title>
<style>
  body { margin: 0; background: #111; color: #f4f4f4; font-family: Calibri, Arial, sans-serif; }
  section { min-height: 100vh; box-sizing: border-box; padding: 64px 80px; border-bottom: 1px solid #333; page-break-after: always; }
  h1 { font-size: 42px; margin: 0 0 16px; }
  h2 { font-size: 28px; margin: 0 0 18px; }
  p, li { font-size: 20px; line-height: 1.45; }
  .meta { color: #bbb; font-size: 16px; }
</style>
</head>
<body>
<section>
  <p class="meta">AI WorkMate local briefing</p>
  <h1>${title}</h1>
  <p class="meta">${escapeHtml(context.meeting.meetingDate)} · exported ${escapeHtml(context.exportedAt)}</p>
</section>
<section>
  <h2>Summary</h2>
  <p>${summary}</p>
</section>
<section>
  <h2>Decisions</h2>
  ${asList(decisions.map((item) => item.text + (item.owner ? ` — ${item.owner}` : "")), "No decisions recorded.")}
</section>
<section>
  <h2>Tasks</h2>
  ${asList(tasks.map((item) => formatTaskLine(item)), "No tasks recorded.")}
</section>
</body>
</html>
`;
}

function renderTasksCsv(context: { meeting: Meeting; tasks: Array<{ text: string; assignee?: string; dueDate?: string; status?: string }> }): string {
  const header = ["Meeting", "Meeting date", "Task", "Assignee", "Due date", "Status"];
  const rows = context.tasks.length === 0
    ? [[context.meeting.title, context.meeting.meetingDate, "", "", "", ""]]
    : context.tasks.map((task) => [
      context.meeting.title,
      context.meeting.meetingDate,
      task.text,
      task.assignee ?? "",
      task.dueDate ?? "",
      task.status ?? "OPEN",
    ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `\uFEFF${csv}\r\n`;
}

function renderListSection(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<h2>${escapeHtml(title)}</h2>\n<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}</ul>`;
}

function asList(items: string[], empty: string): string {
  if (items.length === 0) return `<p>${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function formatTaskLine(task: { text: string; assignee?: string; dueDate?: string; status?: string }): string {
  const parts = [task.text];
  if (task.assignee) parts.push(`owner ${task.assignee}`);
  if (task.dueDate) parts.push(`due ${task.dueDate}`);
  if (task.status) parts.push(task.status);
  return parts.join(" · ");
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeFilename(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return (cleaned.length === 0 ? "meeting" : cleaned).slice(0, MAX_FILENAME_SLUG);
}

export function assertOfficeExportKind(value: unknown): HubOfficeExportKind {
  if (value === "WORD_SUMMARY" || value === "EXCEL_TASKS" || value === "POWERPOINT_BRIEFING") {
    return value;
  }
  throw new StorageError("The Office export kind is invalid.");
}
