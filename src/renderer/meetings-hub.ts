import type {
  HubAnalysisDocument,
  HubAssistedJoinPlan,
  HubCaptureCapabilities,
  HubCaptureRequest,
  HubCaptureSnapshot,
  HubChatAnswer,
  HubChatEvidenceSource,
  HubHistoryFilter,
  HubMeetingAssistPlan,
  HubMeetingSummary,
  HubOfficeExportKind,
  HubTranscriptContent,
  MeetingDetail,
  MeetingHubOverview,
  TranscriptSearchHit,
} from "../domain/hub";

const meetings = window.aiWorkMate.meetings;
const storage = window.aiWorkMate.storage;
const automation = window.aiWorkMate.automation;

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing renderer element: ${id}`);
  return element as T;
};

const todayList = $("hub-today");
const upcomingList = $("hub-upcoming");
const recentList = $("hub-recent");
const searchResults = $("hub-search-results");
const searchInput = $<HTMLInputElement>("hub-search-input");
const searchStatus = $("hub-search-status");
const detailPane = $("hub-detail");
const notice = $("hub-notice");
// Readiness indicator only (role=status in the HTML): it reports the last
// discovery result from renderCaptureStatus and intentionally has no click
// action. Capture defaults live on the existing #capture route.
const captureStatus = $("hub-capture-status");
const refreshButton = $<HTMLButtonElement>("hub-refresh-button");
const REFRESH_LABEL = "↻ Refresh";
const REFRESHING_LABEL = "↻ Refreshing…";
// Header standalone control: starts a new local meeting when idle, stops the
// active recording while one is running. Rows/detail keep their own
// per-meeting Record/Stop actions for calendar-linked meetings.
const recordButton = $<HTMLButtonElement>("hub-record-button");
const recordingStatus = $("hub-recording-status");
const RECORD_LABEL = "● Start recording";
const RECORD_STARTING_LABEL = "● Starting…";
const RECORDING_STOP_LABEL = "■ Stop recording";
const RECORD_STOPPING_LABEL = "■ Stopping…";

let capabilities: HubCaptureCapabilities | undefined;
let openMeetingId: string | undefined;
let openMeetingTitle = "";
let busy = false;
// Only one capture IPC (start/stop/abort) may be in flight at a time, across
// the header button and every row/detail action, so double clicks can never
// send duplicate starts.
let captureBusy = false;
// Only one Transcribe & analyze IPC may be in flight per meeting, so double
// clicks can never send duplicate processing requests. The main process
// enforces the same per-meeting serialization; this guard avoids firing an
// IPC that would deterministically fail fast.
const processingMeetings = new Set<string>();
let captureAction: "start" | "stop" | undefined;
let activeCapture: { meetingId: string; title: string } | undefined;

const STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "Scheduled",
  DETECTED: "Detected",
  PREPARING: "Preparing…",
  RECORDING: "Recording…",
  FINALIZING: "Finalizing…",
  PROCESSING: "Processing…",
  COMPLETED: "Completed",
  INCOMPLETE: "Incomplete",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

function statusClass(status: string): string {
  switch (status) {
    case "RECORDING": case "PREPARING": return "recording";
    case "COMPLETED": return "completed";
    case "CANCELLED": return "cancelled";
    case "FAILED": return "failed";
    case "INCOMPLETE": return "incomplete";
    case "PROCESSING": case "FINALIZING": return "processing";
    default: return "scheduled";
  }
}

function providerLabel(summary: HubMeetingSummary): string {
  const calendar = summary.calendar;
  if (calendar === undefined) return "";
  if (calendar.meetingPlatform === "TEAMS") return "Teams";
  if (calendar.joinUrl !== undefined) return calendar.onlineMeetingProvider ?? "Online";
  return calendar.provider === "GOOGLE_CALENDAR" ? "Google Calendar" : "Microsoft 365";
}

function timeLabel(summary: HubMeetingSummary): string {
  const start = summary.calendar?.startTime ?? summary.startedAt;
  if (start === undefined) return summary.meetingDate;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return start;
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return sameDay ? time : `${day} ${time}`;
}

let noticeTimer: number | undefined;

function showNoticeMessage(message: string, error = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.add("visible");
  // One shared notice element: a newer notice supersedes any earlier one, so
  // cancel the earlier auto-hide first. Without this, a stale timer (e.g.
  // from an "already in progress" busy click, or an earlier error) fires
  // after the newer notice appears and hides it — on slow Windows IPC the
  // busy timer lands ~immediately after the refresh success, so the success
  // feedback never becomes visible. Same clear-then-schedule idiom as the
  // search debounce below.
  if (noticeTimer !== undefined) {
    window.clearTimeout(noticeTimer);
  }
  noticeTimer = window.setTimeout(() => {
    notice.classList.remove("visible");
    noticeTimer = undefined;
  }, error ? 8000 : 3500);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

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

// --- Overview rendering ------------------------------------------------------

function renderMeetingRow(summary: HubMeetingSummary, list: HTMLElement): void {
  const row = el("article", "meeting-row");
  row.dataset.meetingId = summary.meetingId;

  const when = el("div", "meeting-when", timeLabel(summary));

  const main = el("div", "meeting-main");
  const title = el("strong", undefined, summary.title);
  const metaParts: string[] = [];
  const provider = providerLabel(summary);
  if (provider.length > 0) metaParts.push(provider);
  if (summary.calendar?.location !== undefined) metaParts.push(summary.calendar.location);
  if (summary.calendar?.isCancelled === true) metaParts.push("Cancelled");
  if (summary.hasAnalysis) metaParts.push("Analysis ready");
  else if (summary.hasTranscript) metaParts.push("Transcript ready");
  if (summary.hasRecording) metaParts.push("Recording");
  if (summary.artifactCount > 0) metaParts.push(`${summary.artifactCount} artifact${summary.artifactCount === 1 ? "" : "s"}`);
  const meta = el("small", undefined, metaParts.join(" · "));
  main.append(title, meta);

  const status = el("span", `status-pill ${statusClass(summary.status)}`, STATUS_LABELS[summary.status] ?? summary.status);

  const actions = el("div", "meeting-actions");
  if (summary.calendar?.joinUrl !== undefined && summary.status !== "CANCELLED") {
    actions.append(button("Join", "button mini", () => void beginAssistedJoin(summary.meetingId)));
  }
  const captureSupported = capabilities?.supported === true;
  if (summary.isActive && (summary.status === "RECORDING" || summary.status === "PREPARING" || summary.status === "FINALIZING")) {
    actions.append(button("Stop", "button mini danger", () => void stopCapture(summary.meetingId)));
    actions.append(button("Cancel", "button mini ghost", () => void abortCapture(summary.meetingId)));
  } else if (captureSupported && (summary.status === "SCHEDULED" || summary.status === "DETECTED" || summary.status === "COMPLETED" || summary.status === "INCOMPLETE" || summary.status === "FAILED")) {
    actions.append(button("Record", "button mini primary", () => void startCapture(summary.meetingId)));
  }
  actions.append(button("Details", "button mini ghost", () => void openDetail(summary.meetingId)));

  row.append(when, main, status, actions);
  list.append(row);
}

function renderList(items: HubMeetingSummary[], list: HTMLElement, emptyMessage: string): void {
  list.replaceChildren();
  if (items.length === 0) {
    const empty = el("div", "meeting-empty", emptyMessage);
    list.append(empty);
    return;
  }
  for (const item of items) {
    renderMeetingRow(item, list);
  }
}

function renderOverview(next: MeetingHubOverview): void {
  $("hub-day-label").textContent = `${next.todayLabel} — everything stays on this device.`;
  $("hub-today-count").textContent = String(next.today.length);
  $("hub-upcoming-count").textContent = String(next.upcoming.length);
  $("hub-history-count").textContent = String(next.historyTotal);
  renderList(next.today, todayList, "No synced meetings today.");
  renderList(next.upcoming, upcomingList, "No upcoming synced meetings.");
  if (historyFilter === "ALL") {
    renderList(next.recent, recentList, "No meeting history yet — record your first meeting to begin.");
  } else {
    void refreshHistory();
  }
  activeCapture = findActiveCapture(next);
  renderRecordButton();
}

function renderCaptureStatus(): void {
  if (capabilities === undefined) {
    captureStatus.textContent = "Capture unavailable";
    captureStatus.className = "calendar-badge neutral";
    return;
  }
  const sources: string[] = [];
  if (capabilities.microphone) sources.push("microphone");
  if (capabilities.systemLoopback) sources.push("system audio");
  if (capabilities.screen) sources.push("screen");
  if (capabilities.window) sources.push("window");
  captureStatus.textContent = capabilities.supported
    ? `Local capture ready (${sources.join(", ")})`
    : "Local capture not available on this platform";
  captureStatus.className = capabilities.supported ? "calendar-badge connected" : "calendar-badge neutral";
}

async function refreshHub(manual = false): Promise<void> {
  if (busy) {
    // A refresh triggered by initial load, window focus, or a capture action
    // is still awaiting the real Meeting Hub IPC. Tell an explicit click the
    // truth instead of silently swallowing it or faking success.
    if (manual) {
      showNoticeMessage("A refresh is already in progress…");
    }
    return;
  }
  busy = true;
  refreshButton.disabled = true;
  const restoreLabel = refreshButton.textContent;
  refreshButton.textContent = REFRESHING_LABEL;
  try {
    const [next, caps] = await Promise.all([
      meetings.getOverview(),
      meetings.getCaptureCapabilities().catch(() => undefined),
    ]);
    capabilities = caps;
    renderOverview(next);
    renderCaptureStatus();
    if (openMeetingId !== undefined) {
      await renderDetail(openMeetingId);
    }
    // Manual clicks confirm only after the real overview/capabilities IPC
    // resolved and the page re-rendered; background refreshes stay silent.
    if (manual) {
      showNoticeMessage("Meeting hub refreshed.");
    }
  } catch (error: unknown) {
    showErrorMessage(error);
  } finally {
    busy = false;
    refreshButton.disabled = false;
    refreshButton.textContent = restoreLabel.length > 0 ? restoreLabel : REFRESH_LABEL;
  }
}

// --- Capture controls --------------------------------------------------------

interface CaptureSources {
  microphone: boolean;
  systemLoopback: boolean;
  screen: boolean;
}

async function captureSourcesFromPrefs(): Promise<CaptureSources> {
  try {
    const prefs = await automation.getPreferences();
    const microphone = prefs.captureMicrophone;
    const systemLoopback = prefs.captureSystemLoopback;
    const screen = prefs.captureScreen;
    if (!microphone && !systemLoopback && !screen) {
      return { microphone: true, systemLoopback: true, screen: false };
    }
    return { microphone, systemLoopback, screen };
  } catch {
    return { microphone: true, systemLoopback: true, screen: false };
  }
}

async function captureRequestFromPrefs(meetingId: string): Promise<HubCaptureRequest> {
  return { meetingId, ...(await captureSourcesFromPrefs()) };
}

/**
 * The orchestrator RESOLVES start/stop failures as FAILED snapshots (with
 * `error`) instead of throwing, so every capture call must inspect the
 * snapshot — announcing success from IPC resolution alone fakes it.
 */
function captureSnapshotFailure(snapshot: HubCaptureSnapshot): string | undefined {
  if (snapshot.phase === "FAILED" || snapshot.error !== undefined) {
    return snapshot.error?.message ?? "The capture step did not complete.";
  }
  return undefined;
}

function beginCaptureAction(action: "start" | "stop"): boolean {
  if (captureBusy) {
    showNoticeMessage("A capture action is already in progress…");
    return false;
  }
  captureBusy = true;
  captureAction = action;
  renderRecordButton();
  return true;
}

function endCaptureAction(): void {
  captureBusy = false;
  captureAction = undefined;
  renderRecordButton();
}

async function startCaptureWithRequest(request: HubCaptureRequest): Promise<void> {
  if (!beginCaptureAction("start")) {
    return;
  }
  try {
    const snapshot = await meetings.startCapture(request);
    const failure = captureSnapshotFailure(snapshot);
    if (failure === undefined) {
      showNoticeMessage("Recording started. Meeting audio stays on this device.");
    } else {
      showErrorMessage(failure);
    }
  } catch (error: unknown) {
    showErrorMessage(error);
  } finally {
    // Refresh while still guarded so the header cannot offer a second start
    // before the new active state renders.
    await refreshHub();
    endCaptureAction();
  }
}

async function startCapture(meetingId: string, request?: HubCaptureRequest): Promise<void> {
  await startCaptureWithRequest(request ?? await captureRequestFromPrefs(meetingId));
}

function standaloneMeetingTitle(): string {
  return `Local meeting — ${new Date().toLocaleString()}`;
}

async function startStandaloneCapture(): Promise<void> {
  await startCaptureWithRequest({ title: standaloneMeetingTitle(), ...(await captureSourcesFromPrefs()) });
}

function findActiveCapture(next: MeetingHubOverview): { meetingId: string; title: string } | undefined {
  // Same live predicate as the per-row Stop buttons, so the header and the
  // rows can never disagree about which recording is active.
  const live = [...next.today, ...next.upcoming, ...next.recent].find(
    (summary) =>
      summary.isActive &&
      (summary.status === "RECORDING" || summary.status === "PREPARING" || summary.status === "FINALIZING"),
  );
  return live === undefined ? undefined : { meetingId: live.meetingId, title: live.title };
}

function renderRecordButton(): void {
  if (captureBusy) {
    recordButton.disabled = true;
    recordButton.className = captureAction === "stop" ? "button danger" : "button primary";
    recordButton.textContent = captureAction === "stop" ? RECORD_STOPPING_LABEL : RECORD_STARTING_LABEL;
    recordButton.title = "A capture action is in progress…";
    return;
  }
  if (activeCapture !== undefined) {
    recordButton.disabled = false;
    recordButton.className = "button danger";
    recordButton.textContent = RECORDING_STOP_LABEL;
    recordButton.title = `Stop recording “${activeCapture.title}”.`;
    recordingStatus.hidden = false;
    recordingStatus.textContent = `● Recording — ${activeCapture.title}`;
    return;
  }
  recordingStatus.hidden = true;
  recordingStatus.textContent = "";
  if (capabilities === undefined) {
    recordButton.disabled = true;
    recordButton.className = "button primary";
    recordButton.textContent = RECORD_LABEL;
    recordButton.title = "Checking local capture support…";
    return;
  }
  const supported = capabilities.supported === true;
  recordButton.disabled = !supported;
  recordButton.className = "button primary";
  recordButton.textContent = RECORD_LABEL;
  recordButton.title = supported ? "Start a local recording" : "Local capture is not available on this computer";
}

/** Renders the platform-aware assisted flow card inside the meeting detail. */
function renderAssistPlan(plan: HubMeetingAssistPlan, summary: HubMeetingSummary): HTMLElement {
  const card = el("div", "assist-card");
  const heading = el("div", "detail-heading assist-heading");
  heading.append(
    el("div", "assist-platform-chip", `◆ ${plan.platformLabel}`),
    el("h4", undefined, "Assisted flow"),
    el("small", undefined, plan.joinLinkAvailable
      ? "The stored meeting link is ready — join, then start the recommended capture."
      : "No join link was stored for this meeting; the capture plan below still works."),
  );
  card.append(heading);

  if (plan.captureSupported) {
    const sourceLine = el("p", "assist-summary");
    const labels: string[] = [];
    if (plan.recommended.systemLoopback) labels.push("system audio");
    if (plan.recommended.microphone) labels.push("microphone");
    if (plan.recommended.window !== undefined) labels.push("meeting window capture");
    if (plan.recommended.screen) labels.push("screen capture");
    sourceLine.textContent = labels.length > 0
      ? `Recommended sources: ${labels.join(" + ")}. Everything is recorded on this device.`
      : "No capture source is available on this computer right now.";
    card.append(sourceLine);
  } else {
    card.append(el("p", "assist-summary muted", "Capture is not available on this computer right now — join normally and take notes."));
  }

  const steps = el("ol", "assist-checklist");
  for (const item of plan.checklist) {
    const step = el("li");
    const title = el("strong", undefined, item.title);
    step.append(title);
    if (item.note !== undefined) {
      step.append(el("small", undefined, item.note));
    }
    steps.append(step);
  }
  card.append(steps);

  const actions = el("div", "meeting-actions assist-actions");
  if (plan.captureSupported && !summary.isActive && summary.status !== "CANCELLED") {
    actions.append(button("Start recommended capture", "button mini primary", () => {
      void startCapture(plan.meetingId, { ...plan.recommended });
    }));
  }
  card.append(actions);
  return card;
}

async function stopCapture(meetingId: string): Promise<void> {
  try {
    await meetings.stopCapture(meetingId);
    showNoticeMessage("Recording stopped.");
  } catch (error: unknown) {
    showErrorMessage(error);
  }
  await refreshHub();
}

async function abortCapture(meetingId: string): Promise<void> {
  try {
    await meetings.abortCapture(meetingId, "Stopped from the meeting hub.");
    showNoticeMessage("Recording cancelled.", true);
  } catch (error: unknown) {
    showErrorMessage(error);
  }
  await refreshHub();
}

// --- Detail ------------------------------------------------------------------

function artifactIcon(type: string): string {
  if (type.startsWith("RECORDING_")) return "●";
  if (type.startsWith("TRANSCRIPT_")) return "≡";
  if (type.startsWith("ANALYSIS_")) return "◈";
  if (type === "MEETING_MANIFEST") return "⌂";
  return "▤";
}

function renderArtifacts(detail: MeetingDetail): HTMLElement {
  const panel = el("div", "detail-panel");
  const heading = el("div", "detail-heading");
  const title = el("h4", undefined, "Artifacts");
  const meta = el("small", undefined, `folder: ${detail.folderLabel}`);
  heading.append(title, meta);
  panel.append(heading);
  if (detail.artifacts.length === 0) {
    panel.append(el("p", "detail-empty", "No artifacts yet."));
    return panel;
  }
  for (const artifact of detail.artifacts) {
    const row = el("div", "artifact-row");
    const icon = el("span", "artifact-icon", artifactIcon(artifact.artifactType));
    const copy = el("div", "artifact-copy");
    const name = el("strong", undefined, artifact.label);
    const statusText = artifact.status === "AVAILABLE" ? "" : ` · ${artifact.status}`;
    const detailText = el("small", undefined, `${artifact.artifactType}${statusText} · ${formatBytes(artifact.size)}`);
    copy.append(name, detailText);
    row.append(icon, copy);
    panel.append(row);
  }
  return panel;
}

function renderTranscripts(detail: MeetingDetail): HTMLElement {
  const panel = el("div", "detail-panel");
  const heading = el("div", "detail-heading");
  heading.append(el("h4", undefined, "Transcripts"));
  panel.append(heading);
  if (detail.transcripts.length === 0) {
    panel.append(el("p", "detail-empty", "No transcripts yet. After a recording stops, transcription runs locally."));
    return panel;
  }
  for (const transcript of detail.transcripts) {
    const row = el("div", "artifact-row");
    const copy = el("div", "artifact-copy");
    copy.append(
      el("strong", undefined, transcript.language.toUpperCase() === "EN" ? "Transcript (English)" : `Transcript (${transcript.language})`),
      el("small", undefined, `${new Date(transcript.createdAt).toLocaleString()}${transcript.engineId === undefined ? "" : ` · ${transcript.engineId}`}`),
    );
    row.append(el("span", "artifact-icon", "≡"), copy);
    const view = button("View", "button mini ghost", () => void showTranscript(detail.meeting.meetingId, transcript.transcriptId));
    row.append(view);
    panel.append(row);
  }
  return panel;
}

function renderJobs(detail: MeetingDetail): HTMLElement | undefined {
  if (detail.processingJobs.length === 0) return undefined;
  const panel = el("div", "detail-panel");
  const heading = el("div", "detail-heading");
  heading.append(el("h4", undefined, "Processing jobs"));
  panel.append(heading);
  for (const job of detail.processingJobs) {
    const row = el("div", "artifact-row");
    const copy = el("div", "artifact-copy");
    const label = `${job.jobType} — ${job.state}`;
    copy.append(el("strong", undefined, label), el("small", undefined, job.error ?? job.createdAt));
    row.append(copy);
    panel.append(row);
  }
  return panel;
}

function renderAnalysis(analysis: HubAnalysisDocument): HTMLElement {
  const panel = el("div", "detail-panel analysis-panel");
  const heading = el("div", "detail-heading");
  const run = el("small", undefined, `Generated ${new Date(analysis.createdAt).toLocaleString()} · local`);
  heading.append(el("h4", undefined, "Summary"), run);
  panel.append(heading);
  panel.append(el("p", "analysis-summary", analysis.summary));

  if (analysis.decisions.length > 0) {
    panel.append(el("h5", "detail-subheading", "Decisions"));
    for (const decision of analysis.decisions) {
      const row = el("div", "analysis-item");
      row.append(el("span", undefined, "◆"));
      row.append(el("span", undefined, decision.text + (decision.owner === undefined ? "" : ` — ${decision.owner}`)));
      panel.append(row);
    }
  }
  if (analysis.tasks.length > 0) {
    panel.append(el("h5", "detail-subheading", "Tasks"));
    for (const task of analysis.tasks) {
      const row = el("div", "analysis-item");
      const status = el("span", `task-status ${statusClass(task.status)}`, task.status.replace("_", " ").toLowerCase());
      const text = task.text + (task.assignee === undefined ? "" : ` (${task.assignee})`) + (task.dueDate === undefined ? "" : ` · due ${task.dueDate}`);
      row.append(status, el("span", undefined, text));
      panel.append(row);
    }
  }
  if (analysis.risks.length > 0) {
    panel.append(el("h5", "detail-subheading", "Risks"));
    for (const risk of analysis.risks) panel.append(el("div", "analysis-item", `⚠ ${risk}`));
  }
  if (analysis.followups.length > 0) {
    panel.append(el("h5", "detail-subheading", "Follow-ups"));
    for (const followup of analysis.followups) panel.append(el("div", "analysis-item", `→ ${followup}`));
  }
  if (analysis.questions.length > 0) {
    panel.append(el("h5", "detail-subheading", "Open questions"));
    for (const question of analysis.questions) panel.append(el("div", "analysis-item", `? ${question}`));
  }
  return panel;
}

async function renderDetail(meetingId: string): Promise<void> {
  try {
    const [detail, analysis, plan] = await Promise.all([
      meetings.getDetail(meetingId),
      meetings.getAnalysis(meetingId).catch(() => undefined),
      // The assisted-flow plan is guidance only: when planning fails (no
      // capture adapter, discovery error) the meeting still opens normally.
      meetings.getAssistedFlowPlan(meetingId).catch(() => undefined),
    ]);
    openMeetingId = meetingId;
    openMeetingTitle = detail.meeting.title;
    renderDetailPane(detail, analysis, plan);
    syncChatScopeVisibility();
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

function renderDetailPane(detail: MeetingDetail, analysis: HubAnalysisDocument | undefined, plan?: HubMeetingAssistPlan): void {
  detailPane.replaceChildren();
  detailPane.hidden = false;

  const summary = detail.meeting;
  const header = el("div", "detail-header");
  const back = button("← Meetings", "button mini ghost", () => {
    detailPane.hidden = true;
    openMeetingId = undefined;
    openMeetingTitle = "";
    detailPane.replaceChildren();
    syncChatScopeVisibility();
  });
  const titleBox = el("div", "detail-title");
  titleBox.append(
    el("h3", undefined, summary.title),
    el("small", undefined, `${timeLabel(summary)} · ${STATUS_LABELS[summary.status] ?? summary.status}` +
      (summary.calendar?.subject !== undefined && summary.calendar.subject !== summary.title ? ` · calendar: ${summary.calendar.subject}` : "")),
  );
  header.append(back, titleBox);

  const actions = el("div", "meeting-actions detail-actions");
  const captureSupported = capabilities?.supported === true;
  const assistedRequest: HubCaptureRequest | undefined =
    plan?.captureSupported === true ? { ...plan.recommended } : undefined;
  if (summary.isActive) {
    actions.append(button("Stop recording", "button mini danger", () => void stopCapture(summary.meetingId)));
    actions.append(button("Cancel recording", "button mini ghost", () => void abortCapture(summary.meetingId)));
  } else if (summary.status !== "CANCELLED" && (captureSupported || plan === undefined)) {
    // With a plan, the recommended (platform-aware) sources are used; without
    // one the legacy microphone + system audio defaults apply.
    actions.append(button(
      assistedRequest !== undefined ? "Record meeting (recommended)" : "Record meeting",
      "button mini primary",
      () => void startCapture(summary.meetingId, assistedRequest),
    ));
  }
  if (summary.calendar?.joinUrl !== undefined && summary.status !== "CANCELLED") {
    actions.append(button("Assisted join", "button mini", () => void beginAssistedJoin(summary.meetingId)));
  }
  if (!summary.isActive) {
    actions.append(button("Word", "button mini ghost", () => void exportOffice(summary.meetingId, "WORD_SUMMARY")));
    actions.append(button("Excel", "button mini ghost", () => void exportOffice(summary.meetingId, "EXCEL_TASKS")));
    actions.append(button("Briefing", "button mini ghost", () => void exportOffice(summary.meetingId, "POWERPOINT_BRIEFING")));
    actions.append(button("Export package", "button mini ghost", () => {
      void storage.exportMeeting(summary.meetingId)
        .then((result) => {
          if (result !== null) showNoticeMessage(`Meeting package exported (${formatBytes(result.size)}).`);
        })
        .catch((error: unknown) => showErrorMessage(error));
    }));
  }
  const canProcess = summary.hasRecording && !summary.hasAnalysis && !summary.isActive &&
    (summary.status === "COMPLETED" || summary.status === "INCOMPLETE" || summary.status === "FAILED");
  if (canProcess) {
    // While a run for this meeting is in flight (e.g. a refresh re-rendered
    // the detail mid-run), offer no second action.
    const processInFlight = processingMeetings.has(summary.meetingId);
    const processButton = button(
      processInFlight ? "Processing…" : "Transcribe & analyze",
      "button mini primary",
      () => void processMeeting(summary.meetingId),
    );
    processButton.disabled = processInFlight;
    actions.append(processButton);
  }
  header.append(actions);
  detailPane.append(header);

  if (plan !== undefined) {
    detailPane.append(renderAssistPlan(plan, summary));
  }

  if (analysis !== undefined) {
    detailPane.append(renderAnalysis(analysis));
  }
  detailPane.append(renderTranscripts(detail));
  const jobs = renderJobs(detail);
  if (jobs !== undefined) detailPane.append(jobs);
  detailPane.append(renderArtifacts(detail));

  const firstTranscript = detail.transcripts[0];
  if (firstTranscript !== undefined) {
    void showTranscript(summary.meetingId, firstTranscript.transcriptId);
  }
}

async function processMeeting(meetingId: string): Promise<void> {
  if (processingMeetings.has(meetingId)) {
    showNoticeMessage("This meeting is already being processed…");
    return;
  }
  processingMeetings.add(meetingId);
  try {
    showNoticeMessage("Transcription and analysis started (local models by default).");
    await meetings.processMeeting(meetingId, false);
    await renderDetail(meetingId);
  } catch (error: unknown) {
    showErrorMessage(error);
    // The run persisted a terminal state (meeting FAILED plus the job error)
    // before rejecting: re-render so the UI can never stick on a stale
    // "Processing…" pill after a failed analysis.
    await renderDetail(meetingId);
  } finally {
    processingMeetings.delete(meetingId);
    await refreshHub();
  }
}

async function showTranscript(meetingId: string, transcriptId: string): Promise<void> {
  let content: HubTranscriptContent;
  try {
    content = await meetings.getTranscriptContent(meetingId, transcriptId);
  } catch (error: unknown) {
    showErrorMessage(error);
    return;
  }

  const existing = document.getElementById("hub-transcript-viewer");
  if (existing !== null) existing.remove();
  const viewer = el("div", "transcript-viewer");
  viewer.id = "hub-transcript-viewer";
  const heading = el("div", "detail-heading");
  heading.append(el("h4", undefined, "Transcript text"));
  if (content.available) {
    heading.append(el("small", undefined, `${content.language} · generated ${new Date(content.createdAt).toLocaleString()}`));
  }
  viewer.append(heading);
  if (!content.available) {
    viewer.append(el("p", "detail-empty", content.reason === "TRANSCRIPT_TOO_LARGE"
      ? "This transcript is too large to preview. Export the meeting to open it on disk."
      : "The transcript file is missing or damaged. Run Verify storage from the Storage settings to repair the index."));
  } else {
    const pre = el("pre", "transcript-text", content.text ?? "");
    if (content.truncated) {
      viewer.append(el("p", "calendar-line", "Transcript truncated for preview — export the meeting for the full file."));
    }
    viewer.append(pre);
  }
  detailPane.append(viewer);
  viewer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// --- Search ------------------------------------------------------------------

let searchTimer: number | undefined;

function bindSearch(): void {
  searchInput.addEventListener("input", () => {
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
}

async function runSearch(): Promise<void> {
  const query = searchInput.value.trim();
  if (query.length === 0) {
    searchResults.hidden = true;
    searchResults.replaceChildren();
    searchStatus.hidden = true;
    return;
  }
  try {
    const results = await meetings.searchTranscripts(query, 20);
    searchResults.replaceChildren();
    searchStatus.hidden = false;
    if (results.hitCount === 0) {
      searchStatus.textContent = `No transcript contains “${query}”.`;
    } else {
      searchStatus.textContent = `${results.hitCount} match${results.hitCount === 1 ? "" : "es"}${results.truncated ? " (showing first 20)" : ""}.`;
      searchResults.hidden = false;
      for (const hit of results.matches) {
        searchResults.append(renderSearchHit(hit));
      }
    }
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

function renderSearchHit(hit: TranscriptSearchHit): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "meeting-row search-hit";
  const when = el("div", "meeting-when", new Date(hit.meetingDate).toLocaleDateString());
  const main = el("div", "meeting-main");
  main.append(el("strong", undefined, hit.meetingTitle));
  main.append(el("small", "search-snippet", hit.snippet));
  const status = el("span", `status-pill ${statusClass(hit.meetingStatus)}`, STATUS_LABELS[hit.meetingStatus] ?? hit.meetingStatus);
  row.append(when, main, status);
  row.addEventListener("click", () => void openDetail(hit.meetingId));
  return row;
}

async function openDetail(meetingId: string): Promise<void> {
  await renderDetail(meetingId);
  detailPane.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showErrorMessage(error: unknown): void {
  showNoticeMessage(error instanceof Error ? error.message : String(error), true);
}

// --- Meeting chat (grounded, local-only) --------------------------------------

const SUGGESTED_QUESTIONS = [
  "What decisions were made in my recent meetings?",
  "Who said what about the data migration?",
  "Which follow-up tasks are still open?",
  "When was the release date discussed?",
];

const chatThread = $("chat-thread");
const chatEmpty = $("chat-empty");
const chatSuggestions = $("chat-suggestions");
const chatForm = $<HTMLFormElement>("chat-form");
const chatQuestionInput = $<HTMLInputElement>("chat-question");
const chatSendButton = $<HTMLButtonElement>("chat-send-button");
const chatStatus = $("chat-status");
const chatScopeWrap = $("chat-scope-wrap");
const chatScopeInput = $<HTMLInputElement>("chat-scope-current");

let chatBusy = false;

function syncChatScopeVisibility(): void {
  chatScopeWrap.hidden = openMeetingId === undefined;
  if (openMeetingId === undefined) {
    chatScopeInput.checked = false;
  }
}

function renderSuggestionChips(): void {
  chatSuggestions.replaceChildren();
  for (const question of SUGGESTED_QUESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-suggestion";
    chip.textContent = question;
    chip.addEventListener("click", () => {
      if (chatBusy) return;
      chatQuestionInput.value = question;
      void submitChatQuestion();
    });
    chatSuggestions.append(chip);
  }
}

function setChatBusy(busy: boolean, statusText?: string): void {
  chatBusy = busy;
  chatSendButton.disabled = busy;
  chatQuestionInput.disabled = busy;
  if (statusText === undefined) {
    chatStatus.hidden = true;
    chatStatus.textContent = "";
    return;
  }
  chatStatus.hidden = false;
  chatStatus.textContent = statusText;
}

function appendUserBubble(question: string): void {
  chatEmpty.hidden = true;
  const bubble = el("div", "chat-bubble user");
  bubble.textContent = question;
  chatThread.append(bubble);
}

function appendAnswerBubble(answer: HubChatAnswer): void {
  const bubble = el("div", answer.refusal ? "chat-bubble assistant refusal" : "chat-bubble assistant");
  if (answer.refusal) {
    const lines = answer.answer.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) lines.push("I cannot answer this from the recorded meetings.");
    for (const line of lines) {
      bubble.append(el("span", undefined, line));
    }
    const hint = el("span", undefined, answer.refusalReason === "NO_EVIDENCE"
      ? "No recorded meeting in this workspace covers that — the question was not sent anywhere."
      : "The local model's draft could not be verified against the transcripts, so it was withheld.");
    hint.classList.add("chat-evidence-label");
    bubble.append(hint);
  } else {
    const lines = answer.answer.split("\n").filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (index > 0) bubble.append(document.createElement("br"));
      if (/^\[meeting\s*·/.test(line.trim())) {
        bubble.append(renderCitationLine(line.trim()));
      } else {
        bubble.append(el("span", undefined, line));
      }
    }
  }
  chatThread.append(bubble);

  if (!answer.refusal && answer.evidence.length > 0) {
    bubble.append(renderEvidenceBar(answer.evidence));
  }
  chatThread.scrollTop = chatThread.scrollHeight;
}

function renderCitationLine(line: string): HTMLElement {
  const cite = el("span", "chat-cite");
  cite.textContent = line;
  cite.title = "Verbatim quote from the local transcript";
  return cite;
}

function renderEvidenceBar(evidence: HubChatEvidenceSource[]): HTMLElement {
  const bar = el("div", "chat-evidence");
  bar.append(el("span", "chat-evidence-label", "SOURCE TRANSCRIPTS"));
  for (const source of evidence) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-source-chip";
    chip.textContent = `${source.meetingTitle} · ${source.meetingDate}`;
    chip.title = "Open this meeting";
    chip.addEventListener("click", () => void openDetail(source.meetingId));
    bar.append(chip);
  }
  return bar;
}

async function submitChatQuestion(): Promise<void> {
  const question = chatQuestionInput.value.trim();
  if (question.length < 2 || chatBusy) return;
  setChatBusy(true, "The local model is answering on this device…");
  appendUserBubble(question);
  try {
    const scope = chatScopeInput.checked && openMeetingId !== undefined ? [openMeetingId] : undefined;
    const answer = await meetings.askMeetingHistory(question, scope);
    appendAnswerBubble(answer);
  } catch (error: unknown) {
    const bubble = el("div", "chat-bubble assistant refusal");
    bubble.textContent = error instanceof Error ? error.message : String(error);
    chatThread.append(bubble);
  } finally {
    chatQuestionInput.value = "";
    setChatBusy(false);
    chatThread.scrollTop = chatThread.scrollHeight;
  }
}

function bindMeetingChat(): void {
  renderSuggestionChips();
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitChatQuestion();
  });
  chatScopeInput.addEventListener("change", () => {
    if (chatScopeInput.checked && openMeetingId !== undefined && openMeetingTitle.length > 0) {
      showNoticeMessage(`Answers will be grounded only in “${openMeetingTitle}”.`);
    }
  });
}

async function beginAssistedJoin(meetingId: string): Promise<void> {
  try {
    const plan: HubAssistedJoinPlan = await meetings.beginAssistedJoin(meetingId);
    const steps = plan.steps.map((step, index) => `${index + 1}. ${step}`).join(" ");
    if (plan.nextAction === "OPEN_JOIN_URL") {
      showNoticeMessage(`${plan.platformLabel}: ${steps}`);
    } else {
      showNoticeMessage(steps, plan.nextAction === "UNAVAILABLE");
    }
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

async function exportOffice(meetingId: string, kind: HubOfficeExportKind): Promise<void> {
  try {
    const result = await storage.exportOfficeDocument(meetingId, kind);
    if (result === null) return;
    showNoticeMessage(`Saved ${result.filename} (${formatBytes(result.size)}).`);
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

let historyFilter: string = "ALL";

function bindHistoryFilters(): void {
  const filters = document.getElementById("hub-history-filters");
  if (filters === null) return;
  filters.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((node) => {
    node.addEventListener("click", () => {
      historyFilter = node.dataset.history ?? "ALL";
      filters.querySelectorAll(".tasks-filter").forEach((item) => item.classList.remove("active"));
      node.classList.add("active");
      void refreshHistory();
    });
  });
}

async function refreshHistory(): Promise<void> {
  if (historyFilter === "ALL") return;
  try {
    const filter: HubHistoryFilter = {};
    if (historyFilter === "COMPLETED" || historyFilter === "INCOMPLETE") {
      filter.status = historyFilter;
    } else if (historyFilter === "MICROSOFT_GRAPH" || historyFilter === "GOOGLE_CALENDAR") {
      filter.provider = historyFilter;
    }
    const items = await meetings.listHistory(filter);
    renderList(items, recentList, "No matching history.");
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

// --- Init ---------------------------------------------------------------------

refreshButton.addEventListener("click", () => void refreshHub(true));
recordButton.addEventListener("click", () => {
  if (activeCapture !== undefined) {
    void stopCapture(activeCapture.meetingId);
  } else {
    void startStandaloneCapture();
  }
});
bindSearch();
bindMeetingChat();
bindHistoryFilters();
renderRecordButton();
void refreshHub();
syncChatScopeVisibility();
// Refresh again when the window regains focus so a capture that stopped
// elsewhere is reflected without manual reloads.
window.addEventListener("focus", () => {
  if (!detailPane.hidden || document.visibilityState === "visible") {
    void refreshHub();
  }
});

// Tasks panel asks the hub to open the originating meeting of a task.
window.addEventListener("ai-workmate:open-meeting", ((event: Event) => {
  const meetingId = (event as CustomEvent<{ meetingId?: unknown }>).detail?.meetingId;
  if (typeof meetingId === "string" && meetingId.length > 0) {
    if (window.location.hash !== "#meetings") {
      window.location.hash = "meetings";
    }
    void openDetail(meetingId);
  }
}) as EventListener);
