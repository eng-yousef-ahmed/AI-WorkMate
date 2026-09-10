import type { HubAutomationPreferences, HubNotificationItem } from "../domain/hub";

const automation = window.aiWorkMate.automation;
const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing renderer element: ${id}`);
  return element as T;
};

const list = $("automation-notifications-list");
const badge = $("notifications-badge");
const notice = $("notice");

function showNotice(message: string, error = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.add("visible");
}

function checkbox(id: string): HTMLInputElement {
  return $<HTMLInputElement>(id);
}

function applyPreferences(prefs: HubAutomationPreferences): void {
  checkbox("pref-detect").checked = prefs.meetingDetection;
  checkbox("pref-prep").checked = prefs.meetingPreparation;
  $<HTMLInputElement>("pref-prep-minutes").value = String(prefs.meetingPreparationMinutes);
  checkbox("pref-summaries").checked = prefs.meetingSummaries;
  checkbox("pref-assigned").checked = prefs.assignedTaskNotifications;
  checkbox("pref-overdue").checked = prefs.overdueReminders;
  checkbox("pref-daily").checked = prefs.dailyMeetingReports;
  checkbox("pref-followups").checked = prefs.unresolvedFollowupReminders;
  checkbox("pref-capture-mic").checked = prefs.captureMicrophone;
  checkbox("pref-capture-loopback").checked = prefs.captureSystemLoopback;
  checkbox("pref-capture-screen").checked = prefs.captureScreen;
}

function readPreferencesPatch(): Partial<HubAutomationPreferences> {
  const minutes = Number($<HTMLInputElement>("pref-prep-minutes").value);
  return {
    meetingDetection: checkbox("pref-detect").checked,
    meetingPreparation: checkbox("pref-prep").checked,
    meetingPreparationMinutes: Number.isFinite(minutes) ? minutes : 15,
    meetingSummaries: checkbox("pref-summaries").checked,
    assignedTaskNotifications: checkbox("pref-assigned").checked,
    overdueReminders: checkbox("pref-overdue").checked,
    dailyMeetingReports: checkbox("pref-daily").checked,
    unresolvedFollowupReminders: checkbox("pref-followups").checked,
    captureMicrophone: checkbox("pref-capture-mic").checked,
    captureSystemLoopback: checkbox("pref-capture-loopback").checked,
    captureScreen: checkbox("pref-capture-screen").checked,
  };
}

function renderNotifications(items: HubNotificationItem[]): void {
  list.replaceChildren();
  const unread = items.filter((item) => !item.read).length;
  badge.textContent = unread === 0 ? `${items.length} local` : `${unread} unread`;
  badge.className = unread === 0 ? "calendar-badge connected" : "calendar-badge warn";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meeting-empty";
    empty.textContent = "No local notifications yet. Enable reminders under Capture & reminders.";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = item.read ? "task-row done" : "task-row";
    const title = document.createElement("div");
    title.className = "task-title";
    const heading = document.createElement("span");
    heading.className = "task-title-text";
    heading.textContent = item.title;
    title.append(heading);
    const body = document.createElement("small");
    body.textContent = item.body;
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const when = document.createElement("span");
    when.className = "task-meta-chip";
    when.textContent = new Date(item.createdAt).toLocaleString();
    meta.append(when);
    row.append(title, body, meta);
    if (!item.read) {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "button mini ghost";
      mark.textContent = "Mark read";
      mark.addEventListener("click", () => {
        void automation.markRead(item.notificationId).then(() => refresh());
      });
      row.append(mark);
    }
    if (item.meetingId !== undefined) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "task-meeting-link";
      open.textContent = "Open meeting";
      open.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("ai-workmate:open-meeting", { detail: { meetingId: item.meetingId } }));
      });
      row.append(open);
    }
    list.append(row);
  }
}

async function refresh(): Promise<void> {
  try {
    const [prefs, items] = await Promise.all([
      automation.getPreferences(),
      automation.listNotifications({ limit: 50 }),
    ]);
    applyPreferences(prefs);
    renderNotifications(items);
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

$("notifications-refresh-button").addEventListener("click", () => {
  void automation.runTick().then(() => refresh()).catch((error: unknown) => {
    showNotice(error instanceof Error ? error.message : String(error), true);
  });
});

$("automation-save-button").addEventListener("click", () => {
  void automation.setPreferences(readPreferencesPatch()).then(() => {
    showNotice("Reminder and capture settings saved locally.");
    return refresh();
  }).catch((error: unknown) => {
    showNotice(error instanceof Error ? error.message : String(error), true);
  });
});

void refresh();
