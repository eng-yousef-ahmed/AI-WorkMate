import type {
  HubFollowupSuggestion,
  HubMeetingSummary,
  HubTaskItem,
  HubTaskStatus,
} from "../domain/hub";

const tasks = window.aiWorkMate.tasks;
const meetings = window.aiWorkMate.meetings;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing renderer element: ${id}`);
  return element as T;
};

const createForm = $<HTMLFormElement>("tasks-create-form");
const createMeetingSelect = $<HTMLSelectElement>("tasks-new-meeting");
const createTextInput = $<HTMLInputElement>("tasks-new-text");
const createAssigneeInput = $<HTMLInputElement>("tasks-new-assignee");
const createDueInput = $<HTMLInputElement>("tasks-new-due");
const createButton = $<HTMLButtonElement>("tasks-create-button");
const filtersBox = $("tasks-filters");
const listBox = $("tasks-list");
const statusLine = $("tasks-status");
const summaryBadge = $("tasks-summary-badge");
const followupsCount = $("tasks-followups-count");
const followupsList = $("tasks-followups-list");
const refreshButton = $<HTMLButtonElement>("tasks-refresh-button");

const STATUS_LABELS: Record<HubTaskStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

let currentFilter: "ALL" | HubTaskStatus = "ALL";
let busy = false;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function showStatus(message: string, error = false): void {
  statusLine.textContent = message;
  statusLine.classList.toggle("error-line", error);
  statusLine.hidden = false;
  if (error) {
    window.setTimeout(() => {
      statusLine.hidden = true;
    }, 8000);
  }
}

function hideStatus(): void {
  statusLine.hidden = true;
}

function setBusy(value: boolean): void {
  busy = value;
  createButton.disabled = value;
  refreshButton.disabled = value;
}

function sourceLabel(item: HubTaskItem): string {
  if (item.sourceKind === "MANUAL") return "Added manually";
  if (item.analysisDate === undefined) return "From meeting analysis";
  const date = new Date(item.analysisDate);
  const label = Number.isNaN(date.getTime())
    ? item.analysisDate
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return item.sourceKind === "ANALYSIS_FOLLOWUPS" ? `From follow-up · analysis ${label}` : `From analysis ${label}`;
}

function dueLabel(item: HubTaskItem): { text: string; overdue: boolean } {
  if (item.dueDate === undefined) return { text: "", overdue: false };
  if (item.status === "DONE" || item.status === "CANCELLED") return { text: `due ${item.dueDate}`, overdue: false };
  const todayKey = localDateKey(new Date());
  return { text: `due ${item.dueDate}`, overdue: item.dueDate < todayKey };
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function openMeeting(meetingId: string): void {
  window.dispatchEvent(new CustomEvent("ai-workmate:open-meeting", { detail: { meetingId } }));
}

// --- Rows --------------------------------------------------------------------

function renderTaskRow(item: HubTaskItem): HTMLElement {
  const row = el("article", `task-row ${item.status === "DONE" || item.status === "CANCELLED" ? "done" : ""}`);
  row.dataset.taskId = item.taskId;

  const title = el("div", "task-title");
  const check = button("✓", "task-check", () => {
    void changeStatus(item, item.status === "DONE" ? "OPEN" : "DONE");
  });
  check.title = item.status === "DONE" ? "Reopen task" : "Complete task";
  if (item.status === "CANCELLED") check.hidden = true;
  const textNode = el("span", "task-title-text", item.text);
  title.append(check, textNode);
  row.append(title);

  const meta = el("div", "task-meta");
  const meetingChip = document.createElement("button");
  meetingChip.type = "button";
  meetingChip.className = "task-meeting-link";
  meetingChip.textContent = item.meetingTitle;
  meetingChip.title = "Open the originating meeting";
  meetingChip.addEventListener("click", () => openMeeting(item.meetingId));
  meta.append(meetingChip);
  meta.append(el("span", "task-meta-chip provenance", sourceLabel(item)));
  if (item.assignee !== undefined) {
    meta.append(el("span", "task-meta-chip", `→ ${item.assignee}`));
  }
  const due = dueLabel(item);
  if (due.text.length > 0) {
    meta.append(el("span", `task-meta-chip ${due.overdue ? "due-overdue" : ""}`, due.text));
  }
  meta.append(el("span", `status-pill ${statusClass(item.status)}`, STATUS_LABELS[item.status]));
  row.append(meta);

  const actions = el("div", "task-actions");
  if (item.status === "DONE" || item.status === "CANCELLED") {
    actions.append(button("Reopen", "button mini", () => void changeStatus(item, "OPEN")));
  } else {
    if (item.status === "OPEN") {
      actions.append(button("Start", "button mini", () => void changeStatus(item, "IN_PROGRESS")));
    }
    actions.append(button("Complete", "button mini primary", () => void changeStatus(item, "DONE")));
    actions.append(button("Cancel", "button mini ghost", () => void changeStatus(item, "CANCELLED")));
  }
  actions.append(button("Edit", "button mini ghost", () => replaceRowWithEditor(row, item)));
  row.append(actions);
  return row;
}

function replaceRowWithEditor(row: HTMLElement, item: HubTaskItem): void {
  const editor = el("div", "task-edit-fields");
  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.maxLength = 2000;
  textInput.value = item.text;
  const assigneeInput = document.createElement("input");
  assigneeInput.type = "text";
  assigneeInput.maxLength = 200;
  assigneeInput.value = item.assignee ?? "";
  const dueInput = document.createElement("input");
  dueInput.type = "date";
  dueInput.value = item.dueDate ?? "";
  editor.append(el("span", "hub-search-label", "TASK TEXT"));
  editor.append(textInput);
  const fields = el("div", "tasks-field-row");
  const assigneeField = el("label", "field-label", "OWNER / ASSIGNEE");
  const dueField = el("label", "field-label", "DUE DATE");
  assigneeField.append(assigneeInput);
  dueField.append(dueInput);
  fields.append(assigneeField, dueField);
  editor.append(fields);

  const actions = el("div", "task-actions");
  const save = button("Save", "button mini primary", async () => {
    const text = textInput.value.trim();
    if (text.length === 0 || text.length > 2000) {
      showStatus("The task text is invalid.", true);
      return;
    }
    try {
      await tasks.updateTask(item.taskId, {
        text,
        assignee: assigneeInput.value.trim().length > 0 ? assigneeInput.value.trim() : null,
        dueDate: dueInput.value.length > 0 ? dueInput.value : null,
      });
      hideStatus();
      await refreshTasks();
    } catch (error: unknown) {
      showStatus(errorMessage(error), true);
    }
  });
  const cancel = button("Cancel", "button mini ghost", async () => {
    await refreshTasks();
  });
  actions.append(save, cancel);
  editor.append(actions);
  row.replaceChildren();
  row.classList.remove("done");
  row.append(editor);
}

async function changeStatus(item: HubTaskItem, status: HubTaskStatus): Promise<void> {
  try {
    await tasks.setTaskStatus(item.taskId, status);
    hideStatus();
    await refreshTasks();
  } catch (error: unknown) {
    showStatus(errorMessage(error), true);
  }
}

function statusClass(status: HubTaskStatus): string {
  switch (status) {
    case "IN_PROGRESS": return "processing";
    case "DONE": return "completed";
    case "CANCELLED": return "cancelled";
    default: return "scheduled";
  }
}

// --- Loading -----------------------------------------------------------------

async function refreshTasks(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const query = currentFilter === "ALL" ? undefined : { status: currentFilter };
    const [items, open, inProgress, done, cancelled] = await Promise.all([
      tasks.listTasks(query),
      tasks.listTasks({ status: "OPEN" }),
      tasks.listTasks({ status: "IN_PROGRESS" }),
      tasks.listTasks({ status: "DONE" }),
      tasks.listTasks({ status: "CANCELLED" }),
    ]);
    summaryBadge.textContent = `${open.length} open · ${inProgress.length} in progress · ${done.length} done · ${cancelled.length} cancelled`;
    renderTaskList(items);
  } catch (error: unknown) {
    renderTaskError(error);
  } finally {
    setBusy(false);
  }
}

function renderTaskList(items: HubTaskItem[]): void {
  listBox.replaceChildren();
  if (items.length === 0) {
    listBox.append(el("div", "meeting-empty", currentFilter === "ALL"
      ? "No tasks yet. Add one above, or convert a follow-up below."
      : `No ${STATUS_LABELS[currentFilter as HubTaskStatus]?.toLowerCase() ?? "matching"} tasks.`));
    return;
  }
  for (const item of items) {
    listBox.append(renderTaskRow(item));
  }
}

function renderTaskError(error: unknown): void {
  listBox.replaceChildren();
  listBox.append(el("div", "meeting-empty", "Tasks could not be loaded — choose a local data location first."));
  showStatus(errorMessage(error), true);
}

// --- Composer -----------------------------------------------------------------

async function loadMeetingOptions(): Promise<void> {
  createMeetingSelect.replaceChildren();
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "Choose the originating meeting…";
  createMeetingSelect.append(option);
  try {
    const overview = await meetings.getOverview();
    const seen = new Set<string>();
    const summaries = [...overview.recent, ...overview.today, ...overview.upcoming];
    const unique: HubMeetingSummary[] = [];
    for (const summary of summaries) {
      if (!seen.has(summary.meetingId)) {
        seen.add(summary.meetingId);
        unique.push(summary);
      }
    }
    unique.sort((a, b) => a.title.localeCompare(b.title) || b.meetingDate.localeCompare(a.meetingDate));
    for (const summary of unique) {
      const item = document.createElement("option");
      item.value = summary.meetingId;
      item.textContent = `${summary.title} · ${summary.meetingDate}`;
      createMeetingSelect.append(item);
    }
  } catch {
    // The select stays empty; the submit handler reports the need for setup.
  }
}

async function submitCreateTask(): Promise<void> {
  const meetingId = createMeetingSelect.value;
  const text = createTextInput.value.trim();
  if (meetingId.length === 0 || text.length === 0) {
    showStatus("Choose an originating meeting and enter the task text.", true);
    return;
  }
  setBusy(true);
  try {
    await tasks.createTask({
      meetingId,
      text,
      ...(createAssigneeInput.value.trim().length > 0 ? { assignee: createAssigneeInput.value.trim() } : {}),
      ...(createDueInput.value.length > 0 ? { dueDate: createDueInput.value } : {}),
    });
    createTextInput.value = "";
    createAssigneeInput.value = "";
    createDueInput.value = "";
    showStatus("Task added — it keeps its meeting provenance.");
    await refreshTasks();
  } catch (error: unknown) {
    showStatus(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

// --- Follow-ups ---------------------------------------------------------------

async function refreshFollowups(): Promise<void> {
  let suggestions: HubFollowupSuggestion[];
  try {
    suggestions = await tasks.listFollowupSuggestions();
  } catch (error: unknown) {
    followupsList.replaceChildren();
    followupsList.append(el("div", "meeting-empty", "Follow-ups could not be loaded."));
    followupsCount.textContent = "0";
    showStatus(errorMessage(error), true);
    return;
  }
  followupsCount.textContent = String(suggestions.length);
  followupsList.replaceChildren();
  if (suggestions.length === 0) {
    followupsList.append(el("div", "meeting-empty", "No untracked follow-ups from meeting analysis."));
    return;
  }
  for (const suggestion of suggestions) {
    followupsList.append(renderFollowupRow(suggestion));
  }
}

function renderFollowupRow(suggestion: HubFollowupSuggestion): HTMLElement {
  const row = el("div", "followup-row");
  const main = el("div", "meeting-main");
  main.append(el("strong", undefined, suggestion.text));
  const date = new Date(suggestion.analysisDate);
  const dateLabel = Number.isNaN(date.getTime())
    ? suggestion.analysisDate
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  main.append(el("small", undefined, `${suggestion.meetingTitle} · analysis ${dateLabel}`));
  row.append(main);
  if (suggestion.alreadyTask) {
    const tracked = el("span", "task-meta-chip", "Already tracked");
    row.append(tracked);
  } else {
    row.append(button("Convert to task", "button mini primary", () => void convertFollowup(suggestion)));
  }
  return row;
}

async function convertFollowup(suggestion: HubFollowupSuggestion): Promise<void> {
  try {
    await tasks.convertFollowup(suggestion.followupId);
    showStatus("Follow-up converted to a tracked task.");
    await Promise.all([refreshTasks(), refreshFollowups()]);
  } catch (error: unknown) {
    showStatus(errorMessage(error), true);
  }
}

// --- Wiring -------------------------------------------------------------------

function bindTasks(): void {
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCreateTask();
  });
  filtersBox.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-status]");
    if (target === null) return;
    currentFilter = target.dataset.status === "ALL" ? "ALL" : target.dataset.status as HubTaskStatus;
    for (const chip of filtersBox.querySelectorAll<HTMLButtonElement>("button[data-status]")) {
      chip.classList.toggle("active", chip.dataset.status === target.dataset.status);
    }
    void refreshTasks();
  });
  refreshButton.addEventListener("click", () => void refreshAll());
  void loadMeetingOptions();
  void refreshTasks();
  void refreshFollowups();
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshTasks(), refreshFollowups(), loadMeetingOptions()]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

bindTasks();
