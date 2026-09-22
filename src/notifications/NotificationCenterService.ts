import { randomUUID } from "node:crypto";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import type { TaskManagementService } from "../tasks/TaskManagementService";
import type { NotificationRecord, NotificationSeverity } from "../storage/LocalDatabase";
import type {
  HubNotification,
  HubNotificationAction,
  HubNotificationKind,
  HubNotificationPage,
  HubNotificationSettings,
  HubNotificationSettingsInput,
} from "../domain/hub";
import { StorageError } from "../storage/errors";

export const DEFAULT_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_DIGEST_ENABLED = false;
export const DEFAULT_DIGEST_TIME = "09:00";
export const NOTIFICATION_PAGE_LIMIT = 100;
export const NOTIFICATION_RETENTION_ROWS = 500;
export const NOTIFICATION_RETENTION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const NOTIFICATION_TITLE_MAX = 140;
export const NOTIFICATION_BODY_MAX = 1000;
export const AUTOMATION_INTERVAL_MS = 60 * 1000;

const SETTINGS_KEY = "notifications.settings";
const LAST_DIGEST_DAY_KEY = "notifications.lastDigestDay";

const DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AutomationSummary {
  inserted: number;
  taskAlerts: number;
  digestFired: boolean;
  pruned: number;
}

export interface NotificationCenterOptions {
  store: LocalFirstStore;
  /** Task domain service used for due-date scans and follow-up counts. */
  tasks: TaskManagementService;
  clock?: () => Date;
  /**
   * Optional presenter for OS-level popups (Electron Notification in the
   * main process). The service only invokes it when the master
   * notifications toggle is enabled.
   */
  presenter?: (notification: HubNotification) => void;
  /** Fired after any mutation of the notification history or its settings. */
  onChanged?: () => void;
}

/**
 * Local notification center and user-controlled automation.
 *
 * Everything here is derived from persisted local state (meetings, tasks,
 * follow-up analysis) and stays on this device. Automations run only while
 * the app is running, never silently outside the user's settings:
 *  - due-task alerts follow the master toggle (default ON);
 *  - the daily digest is an explicit opt-in (default OFF);
 *  - OS popups are optional and gated by the master toggle;
 *  - every generated event has a unique dedupe key, so repeated ticks and
 *    idempotent retries never duplicate rows.
 */
export class NotificationCenterService {
  private readonly store: LocalFirstStore;
  private readonly tasks: TaskManagementService;
  private readonly clock: () => Date;
  private readonly presenter?: (notification: HubNotification) => void;
  private readonly onChanged?: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  // Prevents two runAutomation() calls from overlapping if a tick ever takes
  // longer than the interval (e.g. a slow storage backend or large digest).
  private automationInFlight = false;

  public constructor(options: NotificationCenterOptions) {
    this.store = options.store;
    this.tasks = options.tasks;
    this.clock = options.clock ?? (() => new Date());
    this.presenter = options.presenter;
    this.onChanged = options.onChanged;
  }

  // --- Notification center ---------------------------------------------------

  public listPage(limit = NOTIFICATION_PAGE_LIMIT): HubNotificationPage {
    const records = this.store.database.listNotifications(limit);
    return {
      notifications: records.map((record) => toHubNotification(record)),
      unread: this.store.database.unreadNotificationCount(),
    };
  }

  public markRead(notificationId: string): HubNotification | undefined {
    const id = readId(notificationId, "notification id");
    const record = this.store.database.markNotificationRead(id, this.clock().toISOString());
    if (record === undefined) {
      return undefined;
    }
    this.onChanged?.();
    return toHubNotification(record);
  }

  public markAllRead(): number {
    const changed = this.store.database.markAllNotificationsRead(this.clock().toISOString());
    if (changed > 0) {
      this.onChanged?.();
    }
    return changed;
  }

  // --- Settings ----------------------------------------------------------------

  public getSettings(): HubNotificationSettings {
    return loadSettings(this.store.database);
  }

  public updateSettings(input: HubNotificationSettingsInput): HubNotificationSettings {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new StorageError("The notification settings are invalid.");
    }
    const recognized = (Object.keys(input) as Array<keyof HubNotificationSettingsInput>)
      .filter((key) => input[key] !== undefined);
    if (recognized.length === 0) {
      throw new StorageError("The notification settings update is empty.");
    }
    if (input.notificationsEnabled !== undefined && typeof input.notificationsEnabled !== "boolean") {
      throw new StorageError("The notifications toggle is invalid.");
    }
    if (input.digestEnabled !== undefined && typeof input.digestEnabled !== "boolean") {
      throw new StorageError("The digest toggle is invalid.");
    }
    let digestTime = input.digestTime;
    if (digestTime !== undefined) {
      if (typeof digestTime !== "string") {
        throw new StorageError("The digest time is invalid.");
      }
      digestTime = digestTime.trim();
      if (!DIGEST_TIME_PATTERN.test(digestTime)) {
        throw new StorageError("The digest time must be a 24-hour HH:MM local time.");
      }
    }
    const current = loadSettings(this.store.database);
    const next: HubNotificationSettings = {
      notificationsEnabled: input.notificationsEnabled ?? current.notificationsEnabled,
      digestEnabled: input.digestEnabled ?? current.digestEnabled,
      digestTime: digestTime ?? current.digestTime,
      updatedAt: this.clock().toISOString(),
    };
    this.store.database.setMetadata(SETTINGS_KEY, JSON.stringify(next));
    this.onChanged?.();
    return next;
  }

  // --- Event recording (reactions to explicit user actions) -------------------

  /**
   * Records the terminal outcome of a meeting processing run that the user
   * explicitly triggered ("Process meeting"). Meetings still in a live state
   * produce nothing; repeated outcomes of the same kind are deduped.
   */
  public recordMeetingOutcome(meetingId: string): HubNotification | undefined {
    const id = readId(meetingId, "meeting id");
    const meeting = this.store.getMeeting(id);
    if (meeting === undefined) {
      return undefined;
    }
    let kind: HubNotificationKind;
    let severity: NotificationSeverity;
    let title: string;
    let body: string;
    const settings = loadSettings(this.store.database);
    switch (meeting.status) {
      case "COMPLETED":
        kind = "MEETING_READY";
        severity = "INFO";
        title = "Transcript and analysis ready";
        body = `${meeting.title} · ${meeting.meetingDate ?? ""}`.trimEnd().replace(/ · $/, "");
        body = body.length > 0 ? body : "The meeting has been processed.";
        break;
      case "FAILED":
      case "INCOMPLETE":
        kind = "MEETING_ISSUE";
        severity = "WARNING";
        title = "Meeting processing needs attention";
        body = `${meeting.title} · ${meeting.meetingDate ?? ""}`.trimEnd().replace(/ · $/, "");
        body = body.length > 0 ? body : "The meeting did not finish processing.";
        break;
      default:
        return undefined;
    }
    return this.create({
      kind,
      severity,
      title,
      body,
      meetingId: id,
      action: "open-meeting",
      dedupeKey: `meeting-outcome:${id}:${meeting.status}`,
      present: settings.notificationsEnabled,
    });
  }

  // --- Automation (explicit user control only) ---------------------------------

  /**
   * Runs the local automation pass: retention pruning, due-task alerts, and
   * (when enabled and due) the daily digest. Safe to call on every tick and
   * at app start; dedupe keys make repeated runs idempotent.
   */
  public async runAutomation(): Promise<AutomationSummary> {
    const now = this.clock();
    const pruned = this.store.database.pruneNotifications(NOTIFICATION_RETENTION_ROWS, NOTIFICATION_RETENTION_MS, now);
    const settings = loadSettings(this.store.database);
    if (!settings.notificationsEnabled) {
      return { inserted: 0, taskAlerts: 0, digestFired: false, pruned };
    }

    let inserted = 0;
    const taskAlerts = this.scanDueTasks(settings, now);
    inserted += taskAlerts;
    let digestFired = false;
    if (settings.digestEnabled && await this.fireDailyDigestIfDue(settings, now)) {
      digestFired = true;
      inserted += 1;
    }
    return { inserted, taskAlerts, digestFired, pruned };
  }

  private scanDueTasks(settings: HubNotificationSettings, now: Date): number {
    const todayKey = localDateKey(now);
    const items = this.tasks.listTasks({ status: "OPEN" })
      .concat(this.tasks.listTasks({ status: "IN_PROGRESS" }));
    let created = 0;
    for (const item of items) {
      if (item.dueDate === undefined || item.dueDate > todayKey) continue;
      const overdue = item.dueDate < todayKey;
      const title = overdue ? "Task overdue" : "Task due today";
      const snippet = clip(item.text, 180);
      const owner = item.assignee === undefined ? undefined : ` (owner: ${clip(item.assignee, 80)})`;
      const body = `"${snippet}" — from ${item.meetingTitle ?? "your meetings"}${owner ?? ""}`.slice(0, NOTIFICATION_BODY_MAX);
      const notification = this.create({
        kind: "TASK_DUE",
        severity: overdue ? "WARNING" : "INFO",
        title,
        body,
        meetingId: item.meetingId,
        taskId: item.taskId,
        action: "open-tasks",
        dedupeKey: `task-due:${item.taskId}:${item.dueDate}`,
        present: settings.notificationsEnabled,
      });
      if (notification !== undefined) created += 1;
    }
    return created;
  }

  private async fireDailyDigestIfDue(settings: HubNotificationSettings, now: Date): Promise<boolean> {
    const todayKey = localDateKey(now);
    if (localTimeKey(now) < settings.digestTime) {
      return false;
    }
    if (this.store.database.getMetadata(LAST_DIGEST_DAY_KEY) === todayKey) {
      return false; // already ran for this local day
    }
    const active = this.tasks.listTasks()
      .filter((item) => item.status === "OPEN" || item.status === "IN_PROGRESS");
    const openTotal = active.length;
    const dueCount = active.filter((item) => item.dueDate !== undefined && item.dueDate <= todayKey).length;
    const suggestions = await this.tasks.listFollowupSuggestions();
    const followupTotal = suggestions.filter((item) => !item.alreadyTask).length;
    const doneTodayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const completedToday = this.tasks.listTasks({ status: "DONE" })
      .filter((item) => item.updatedAt >= doneTodayStart).length;

    // Remember the run for today even when there is nothing to report, so the
    // digest stays at most one quiet row per day and never retries in a loop.
    this.store.database.setMetadata(LAST_DIGEST_DAY_KEY, todayKey);

    const lines: string[] = [];
    if (openTotal > 0) lines.push(`${openTotal} open task${openTotal === 1 ? "" : "s"}${dueCount > 0 ? `, ${dueCount} due today or overdue` : ""}`);
    if (followupTotal > 0) lines.push(`${followupTotal} follow-up${followupTotal === 1 ? "" : "s"} from analysis ready to convert`);
    if (completedToday > 0) lines.push(`${completedToday} completed today`);
    if (lines.length === 0) {
      return false;
    }
    const dueSamples = active
      .filter((item) => item.dueDate !== undefined && item.dueDate <= todayKey)
      .slice(0, 3)
      .map((item) => `• ${clip(item.text, 100)} (${item.meetingTitle ?? "meeting"})`);
    const bodyParts = [...lines, ...(dueSamples.length > 0 ? ["", ...dueSamples] : [])];
    const notification = this.create({
      kind: "FOLLOWUP_DIGEST",
      severity: "INFO",
      title: "Daily review",
      body: bodyParts.join("\n").slice(0, NOTIFICATION_BODY_MAX),
      action: "open-tasks",
      dedupeKey: `digest:${todayKey}`,
      present: settings.notificationsEnabled,
    });
    return notification !== undefined;
  }

  // --- Lifecycle ----------------------------------------------------------------

  /** Starts periodic automation while the workspace is attached (app running). */
  public start(intervalMs = AUTOMATION_INTERVAL_MS): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.automationInFlight) {
        // Previous tick has not finished yet; skip this firing rather than
        // running two runAutomation() passes concurrently.
        return;
      }
      this.automationInFlight = true;
      void this.runAutomation()
        .catch((error: unknown) => {
          console.error("Notification automation tick failed", error);
        })
        .finally(() => {
          this.automationInFlight = false;
        });
    }, intervalMs);
    // Never keep the app alive on its own; the tick only runs while the app
    // (or a test harness) is already running.
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // --- Helpers ------------------------------------------------------------------

  private create(input: {
    kind: HubNotificationKind;
    severity: NotificationSeverity;
    title: string;
    body: string;
    meetingId?: string;
    taskId?: string;
    action: HubNotificationAction;
    dedupeKey: string;
    present: boolean;
  }): HubNotification | undefined {
    const title = clip(input.title, NOTIFICATION_TITLE_MAX).trim();
    const body = clip(input.body, NOTIFICATION_BODY_MAX).trim();
    if (title.length === 0 || body.length === 0) {
      return undefined;
    }
    const record: NotificationRecord = {
      notificationId: randomId(),
      kind: input.kind,
      severity: input.severity,
      title,
      body,
      createdAt: this.clock().toISOString(),
      dedupeKey: input.dedupeKey,
    };
    if (input.meetingId !== undefined) record.meetingId = input.meetingId;
    if (input.taskId !== undefined) record.taskId = input.taskId;
    if (input.action !== undefined) record.action = input.action;
    const inserted = this.store.database.addNotification(record);
    if (!inserted) {
      return undefined; // already present: idempotent duplicate
    }
    const notification = toHubNotification(record);
    this.onChanged?.();
    if (input.present) {
      this.presenter?.(notification);
    }
    return notification;
  }
}

function toHubNotification(record: NotificationRecord): HubNotification {
  const notification: HubNotification = {
    notificationId: record.notificationId,
    kind: record.kind as HubNotificationKind,
    severity: record.severity,
    title: record.title,
    body: record.body,
    createdAt: record.createdAt,
    readAt: record.readAt ?? null,
  };
  if (record.meetingId !== undefined) notification.meetingId = record.meetingId;
  if (record.taskId !== undefined) notification.taskId = record.taskId;
  if (record.action !== undefined) notification.action = record.action as HubNotificationAction;
  return notification;
}

function loadSettings(database: { getMetadata(key: string): string | undefined }): HubNotificationSettings {
  const stored = database.getMetadata(SETTINGS_KEY);
  if (stored === undefined) {
    return {
      notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
      digestEnabled: DEFAULT_DIGEST_ENABLED,
      digestTime: DEFAULT_DIGEST_TIME,
      updatedAt: "",
    };
  }
  try {
    const value = JSON.parse(stored) as Partial<HubNotificationSettings>;
    const settings: HubNotificationSettings = {
      notificationsEnabled: typeof value.notificationsEnabled === "boolean"
        ? value.notificationsEnabled
        : DEFAULT_NOTIFICATIONS_ENABLED,
      digestEnabled: typeof value.digestEnabled === "boolean"
        ? value.digestEnabled
        : DEFAULT_DIGEST_ENABLED,
      digestTime: typeof value.digestTime === "string" && DIGEST_TIME_PATTERN.test(value.digestTime.trim())
        ? value.digestTime.trim()
        : DEFAULT_DIGEST_TIME,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    };
    return settings;
  } catch {
    return {
      notificationsEnabled: DEFAULT_NOTIFICATIONS_ENABLED,
      digestEnabled: DEFAULT_DIGEST_ENABLED,
      digestTime: DEFAULT_DIGEST_TIME,
      updatedAt: "",
    };
  }
}

function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new StorageError(`The ${label} is invalid.`);
  }
  return value.trim();
}

function clip(text: string, maxLength: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimeKey(now: Date): string {
  const hours = `${now.getHours()}`.padStart(2, "0");
  const minutes = `${now.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

function randomId(): string {
  return randomUUID();
}
