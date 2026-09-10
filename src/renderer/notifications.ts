import type {
  HubNotification,
  HubNotificationSettings,
} from "../domain/hub";

const notifications = window.aiWorkMate.notifications;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing renderer element: ${id}`);
  return element as T;
};

const toggle = $<HTMLButtonElement>("notifications-toggle");
const panel = $("notifications-panel");
const unreadBadge = $<HTMLSpanElement>("notifications-unread");
const listBox = $("notifications-list");
const emptyBox = $("notifications-empty");
const markAllButton = $<HTMLButtonElement>("notifications-mark-all");
const enabledToggle = $<HTMLInputElement>("notifications-enabled");
const digestToggle = $<HTMLInputElement>("notifications-digest");
const digestTimeInput = $<HTMLInputElement>("notifications-digest-time");
const runNowButton = $<HTMLButtonElement>("notifications-run-now");
const runResult = $("notifications-run-result");

const KIND_META: Partial<Record<HubNotification["kind"], { icon: string; label: string }>> = {
  MEETING_READY: { icon: "✓", label: "Meeting ready" },
  MEETING_ISSUE: { icon: "!", label: "Processing issue" },
  TASK_DUE: { icon: "◷", label: "Task reminder" },
  FOLLOWUP_DIGEST: { icon: "▤", label: "Daily review" },
  MEETING_DETECTED: { icon: "●", label: "Meeting detected" },
  MEETING_PREPARATION: { icon: "◷", label: "Prepare to join" },
  MEETING_SUMMARY_READY: { icon: "✓", label: "Summary ready" },
  TASK_ASSIGNED: { icon: "✓", label: "Task assigned" },
  TASK_OVERDUE: { icon: "!", label: "Overdue task" },
  DAILY_MEETING_REPORT: { icon: "▤", label: "Daily report" },
  UNRESOLVED_FOLLOWUPS: { icon: "→", label: "Follow-ups" },
};

interface AutomationRunSummary {
  inserted?: number;
  taskAlerts?: number;
  digestFired?: boolean;
  pruned?: number;
}

let open = false;
let items: HubNotification[] = [];
let settings: HubNotificationSettings | undefined;
let syncingSettings = false;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderBadge(): void {
  const unread = items.filter((item) => item.readAt === null).length;
  unreadBadge.textContent = String(unread);
  unreadBadge.hidden = unread === 0;
  markAllButton.disabled = unread === 0;
  toggle.setAttribute("aria-label", `Notifications (${unread} unread)`);
}

function navigateTo(item: HubNotification): void {
  if (item.action === "open-meeting" && item.meetingId !== undefined) {
    window.dispatchEvent(new CustomEvent("ai-workmate:open-meeting", { detail: { meetingId: item.meetingId } }));
  } else if (item.action === "open-tasks") {
    const section = document.getElementById("tasks");
    if (section !== null) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.location.hash = "tasks";
  }
}

function renderList(): void {
  listBox.textContent = "";
  for (const item of items) {
    const meta = KIND_META[item.kind] ?? { icon: "•", label: item.kind };
    const row = el("button", `notification-row${item.readAt === null ? " unread" : ""}${item.severity === "WARNING" ? " warning" : ""}`) as HTMLButtonElement;
    row.type = "button";
    row.setAttribute("role", "listitem");
    row.append(
      el("span", "notification-dot"),
      el("span", "notification-kind", meta.icon),
    );
    const main = el("span", "notification-main");
    const titleRow = el("span", "notification-title-row");
    const title = el("strong", undefined, item.title);
    const when = el("span", "notification-when", timeLabel(item.createdAt));
    titleRow.append(title, when);
    const body = el("p", undefined, item.body);
    const go = item.action === undefined ? undefined : el("span", "notification-go", meta.label + " →");
    main.append(titleRow, body);
    if (go !== undefined) main.append(go);
    row.append(main);
    row.addEventListener("click", () => void openNotification(item));
    listBox.append(row);
  }
  emptyBox.hidden = items.length > 0;
  listBox.hidden = items.length === 0;
  renderBadge();
}

async function openNotification(item: HubNotification): Promise<void> {
  setOpen(false);
  if (item.readAt === null) {
    try {
      await notifications.markRead(item.notificationId);
    } catch {
      // The history changed underneath (e.g. prune); refresh keeps it accurate.
    }
    await refresh();
  }
  navigateTo(item);
}

function setOpen(next: boolean): void {
  open = next;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

async function refresh(): Promise<void> {
  try {
    const page = await notifications.list();
    items = page.notifications;
    renderList();
  } catch (error: unknown) {
    items = [];
    renderList();
    showRunResult(errorMessage(error), true);
  }
}

async function syncSettingsFromUi(): Promise<void> {
  if (syncingSettings || settings === undefined) return;
  syncingSettings = true;
  try {
    settings = await notifications.updateSettings({
      notificationsEnabled: enabledToggle.checked,
      digestEnabled: digestToggle.checked,
      digestTime: digestTimeInput.value || undefined,
    });
    showRunResult("Preferences saved on this device.");
  } catch (error: unknown) {
    // Revert toggles to the persisted state on failure.
    applySettings(settings);
    showRunResult(errorMessage(error), true);
  } finally {
    syncingSettings = false;
  }
}

function applySettings(next: HubNotificationSettings): void {
  settings = next;
  enabledToggle.checked = next.notificationsEnabled;
  digestToggle.checked = next.digestEnabled;
  digestTimeInput.value = next.digestTime;
}

function showRunResult(message: string, error = false): void {
  runResult.textContent = message;
  runResult.classList.toggle("error-line", error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAutomationNow(): Promise<void> {
  runNowButton.disabled = true;
  try {
    const summary = (await notifications.runAutomationNow()) as AutomationRunSummary | undefined;
    const created = typeof summary?.inserted === "number" ? summary.inserted : 0;
    showRunResult(created > 0
      ? `Checked local meetings and tasks — ${created} new item${created === 1 ? "" : "s"}.`
      : "Checked local meetings and tasks — nothing new right now.");
    await refresh();
  } catch (error: unknown) {
    showRunResult(errorMessage(error), true);
  } finally {
    runNowButton.disabled = false;
  }
}

// --- Wiring -------------------------------------------------------------------

toggle.addEventListener("click", () => {
  setOpen(!open);
  if (open) {
    void refresh();
  }
});

document.addEventListener("click", (event) => {
  if (!open) return;
  const wrap = $("notifications-wrap");
  if (!wrap.contains(event.target as Node)) {
    setOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && open) {
    setOpen(false);
  }
});

markAllButton.addEventListener("click", async () => {
  try {
    await notifications.markAllRead();
    await refresh();
  } catch (error: unknown) {
    showRunResult(errorMessage(error), true);
  }
});

enabledToggle.addEventListener("change", () => void syncSettingsFromUi());
digestToggle.addEventListener("change", () => void syncSettingsFromUi());
digestTimeInput.addEventListener("change", () => void syncSettingsFromUi());
runNowButton.addEventListener("click", () => void runAutomationNow());

// Main-process pushes keep the badge current when automation ticks (due-date
// alerts, the daily digest) create rows outside a renderer action.
notifications.onChanged(() => {
  void refresh();
});

async function init(): Promise<void> {
  try {
    applySettings(await notifications.getSettings());
  } catch (error: unknown) {
    showRunResult(errorMessage(error), true);
  }
  await refresh();
}

void init();
