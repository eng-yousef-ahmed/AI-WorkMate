import { randomUUID } from "node:crypto";

import type {
  HubAutomationPreferences,
  HubAutomationTickResult,
  HubNotificationItem,
  HubNotificationKind,
} from "../domain/hub";
import type { CalendarEventAssociation, Meeting } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import type { NotificationRecord } from "../storage/LocalDatabase";
import { DEFAULT_AUTOMATION_PREFERENCES } from "./AutomationPreferences";

const DEFAULT_DETECTION_LEAD_MS = 15 * 60 * 1000;
const MAX_NOTIFICATION_TITLE = 180;
const MAX_NOTIFICATION_BODY = 600;

export interface LocalNotifier {
  notify(notification: { title: string; body: string }): void;
}

export interface AutomationEngineDependencies {
  store: LocalFirstStore;
  clock?: () => Date;
  notifier?: LocalNotifier;
  preferences?: () => HubAutomationPreferences | Promise<HubAutomationPreferences>;
}

/**
 * Local-only automation. Every side effect is either:
 * - a meeting lifecycle transition (SCHEDULED → DETECTED), or
 * - a notification stored in SQLite and optionally shown as an OS toast.
 *
 * Nothing is emailed, posted, or sent to cloud services.
 */
export class AutomationEngine {
  private readonly store: LocalFirstStore;
  private readonly clock: () => Date;
  private readonly notifier: LocalNotifier;
  private readonly loadPreferences: () => HubAutomationPreferences | Promise<HubAutomationPreferences>;

  public constructor(dependencies: AutomationEngineDependencies) {
    this.store = dependencies.store;
    this.clock = dependencies.clock ?? (() => new Date());
    this.notifier = dependencies.notifier ?? { notify: () => undefined };
    this.loadPreferences = dependencies.preferences ?? (() => ({ ...DEFAULT_AUTOMATION_PREFERENCES }));
  }

  public async runTick(): Promise<HubAutomationTickResult> {
    const preferences = await this.loadPreferences();
    const now = this.clock();
    let detectedMeetings = 0;
    let createdNotifications = 0;
    let skippedDuplicates = 0;

    const record = (kind: HubNotificationKind, fingerprint: string, title: string, body: string, extras: { meetingId?: string; taskId?: string } = {}): boolean => {
      const created = this.createNotification({ kind, fingerprint, title, body, ...extras });
      if (created) {
        createdNotifications += 1;
        this.notifier.notify({ title, body });
        return true;
      }
      skippedDuplicates += 1;
      return false;
    };

    const meetings = this.store.listMeetings();
    const associations = this.store.database.listCalendarEventAssociations();
    const associationsByMeeting = new Map<string, CalendarEventAssociation>();
    for (const association of associations) {
      if (!associationsByMeeting.has(association.meetingId)) {
        associationsByMeeting.set(association.meetingId, association);
      }
    }

    if (preferences.meetingDetection) {
      const leadMs = Math.max(60_000, preferences.meetingPreparationMinutes * 60_000);
      for (const meeting of meetings) {
        if (meeting.status !== "SCHEDULED") continue;
        const association = associationsByMeeting.get(meeting.meetingId);
        if (association === undefined || association.isCancelled) continue;
        if (!isWithinDetectionWindow(now, association, leadMs)) continue;
        this.store.database.updateMeetingStatus(meeting.meetingId, "DETECTED");
        detectedMeetings += 1;
        meeting.status = "DETECTED";
        if (preferences.meetingPreparation) {
          record(
            "MEETING_DETECTED",
            `detect:${meeting.meetingId}`,
            `Meeting starting soon: ${clip(meeting.title, 80)}`,
            `${formatClock(association.startTime)} · join from AI WorkMate when you are ready. Recording stays on this device.`,
            { meetingId: meeting.meetingId },
          );
        }
      }
    }

    if (preferences.meetingPreparation) {
      const leadMs = preferences.meetingPreparationMinutes * 60_000;
      for (const meeting of meetings) {
        const association = associationsByMeeting.get(meeting.meetingId);
        if (association === undefined || association.isCancelled) continue;
        if (meeting.status === "CANCELLED" || meeting.status === "COMPLETED" || meeting.status === "FAILED") continue;
        if (!isWithinPreparationWindow(now, association, leadMs)) continue;
        const day = localDateKey(now);
        record(
          "MEETING_PREPARATION",
          `prep:${meeting.meetingId}:${day}`,
          `Prepare: ${clip(meeting.title, 80)}`,
          `Starts ${formatClock(association.startTime)}. Open the join link, then start a local recording.`,
          { meetingId: meeting.meetingId },
        );
      }
    }

    if (preferences.meetingSummaries) {
      for (const meeting of meetings) {
        if (meeting.status !== "COMPLETED") continue;
        const analysis = this.store.database.listAnalysis(meeting.meetingId)
          .filter((item) => item.kind === "SUMMARY")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (analysis === undefined) continue;
        record(
          "MEETING_SUMMARY_READY",
          `summary:${meeting.meetingId}:${analysis.createdAt}`,
          `Summary ready: ${clip(meeting.title, 80)}`,
          "A grounded local analysis is available. Nothing was sent to the cloud.",
          { meetingId: meeting.meetingId },
        );
      }
    }

    if (preferences.assignedTaskNotifications) {
      for (const task of this.store.listAllTasks()) {
        if (task.status === "DONE" || task.status === "CANCELLED") continue;
        if (task.assignee === undefined || task.assignee.trim().length === 0) continue;
        if (task.sourceArtifactId === undefined) continue;
        const meeting = meetings.find((item) => item.meetingId === task.meetingId);
        record(
          "TASK_ASSIGNED",
          `task-assigned:${task.taskId}`,
          `Task for ${clip(task.assignee, 40)}`,
          `${clip(task.text, 160)}${meeting === undefined ? "" : ` · ${meeting.title}`}`,
          { meetingId: task.meetingId, taskId: task.taskId },
        );
      }
    }

    if (preferences.overdueReminders) {
      const today = localDateKey(now);
      for (const task of this.store.listAllTasks()) {
        if (task.status === "DONE" || task.status === "CANCELLED") continue;
        if (task.dueDate === undefined || task.dueDate >= today) continue;
        record(
          "TASK_OVERDUE",
          `overdue:${task.taskId}:${task.dueDate}`,
          "Overdue task",
          `${clip(task.text, 160)} was due ${task.dueDate}${task.assignee === undefined ? "" : ` (${task.assignee})`}.`,
          { meetingId: task.meetingId, taskId: task.taskId },
        );
      }
    }

    if (preferences.dailyMeetingReports) {
      const today = localDateKey(now);
      const todays = meetings.filter((meeting) => meeting.meetingDate === today && meeting.status !== "CANCELLED");
      const overdue = this.store.listAllTasks().filter((task) =>
        task.status !== "DONE" && task.status !== "CANCELLED" && task.dueDate !== undefined && task.dueDate < today,
      );
      const titles = todays.slice(0, 5).map((meeting) => meeting.title);
      const extra = todays.length > 5 ? ` and ${todays.length - 5} more` : "";
      record(
        "DAILY_MEETING_REPORT",
        `daily:${today}`,
        `Daily report · ${today}`,
        `${todays.length} meeting${todays.length === 1 ? "" : "s"} today${titles.length === 0 ? "" : `: ${titles.join("; ")}`}${extra}. ${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}. Local only.`,
      );
    }

    if (preferences.unresolvedFollowupReminders) {
      const today = localDateKey(now);
      const unresolved = countUnresolvedFollowups(this.store, meetings);
      if (unresolved > 0) {
        record(
          "UNRESOLVED_FOLLOWUPS",
          `followups:${today}`,
          "Unresolved follow-ups",
          `${unresolved} analysis follow-up${unresolved === 1 ? "" : "s"} are not yet tracked as tasks.`,
        );
      }
    }

    return { detectedMeetings, createdNotifications, skippedDuplicates };
  }

  public listNotifications(options: { unreadOnly?: boolean; limit?: number } = {}): HubNotificationItem[] {
    return this.store.database.listNotifications(options).map(toHubNotification);
  }

  public markNotificationRead(notificationId: string): HubNotificationItem | undefined {
    const updated = this.store.database.markNotificationRead(notificationId, this.clock().toISOString());
    return updated === undefined ? undefined : toHubNotification(updated);
  }

  private createNotification(input: {
    kind: HubNotificationKind;
    fingerprint: string;
    title: string;
    body: string;
    meetingId?: string;
    taskId?: string;
  }): boolean {
    const now = this.clock().toISOString();
    const record: NotificationRecord = {
      notificationId: randomUUID(),
      kind: input.kind,
      title: clip(input.title, MAX_NOTIFICATION_TITLE),
      body: clip(input.body, MAX_NOTIFICATION_BODY),
      fingerprint: input.fingerprint,
      createdAt: now,
    };
    if (input.meetingId !== undefined) record.meetingId = input.meetingId;
    if (input.taskId !== undefined) record.taskId = input.taskId;
    return this.store.database.registerNotification(record);
  }
}

function isWithinDetectionWindow(now: Date, association: CalendarEventAssociation, leadMs: number): boolean {
  const start = Date.parse(association.startTime);
  const end = Date.parse(association.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const ts = now.getTime();
  return ts >= start - Math.max(leadMs, DEFAULT_DETECTION_LEAD_MS) && ts <= end;
}

function isWithinPreparationWindow(now: Date, association: CalendarEventAssociation, leadMs: number): boolean {
  const start = Date.parse(association.startTime);
  if (!Number.isFinite(start)) return false;
  const ts = now.getTime();
  return ts >= start - leadMs && ts < start;
}

function countUnresolvedFollowups(store: LocalFirstStore, meetings: Meeting[]): number {
  const converted = new Set(
    store.listAllTasks()
      .filter((task) => task.sourceArtifactId !== undefined)
      .map((task) => `${task.meetingId}:${task.sourceArtifactId}`),
  );
  let count = 0;
  for (const meeting of meetings) {
    const followups = store.database.listAnalysis(meeting.meetingId)
      .filter((record) => record.kind === "FOLLOWUPS")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (followups === undefined) continue;
    if (!converted.has(`${meeting.meetingId}:${followups.artifactId}`)) {
      count += 1;
    }
  }
  return count;
}

function toHubNotification(record: NotificationRecord): HubNotificationItem {
  const item: HubNotificationItem = {
    notificationId: record.notificationId,
    kind: record.kind,
    title: record.title,
    body: record.body,
    createdAt: record.createdAt,
    read: record.readAt !== undefined,
  };
  if (record.meetingId !== undefined) item.meetingId = record.meetingId;
  if (record.taskId !== undefined) item.taskId = record.taskId;
  return item;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
