import type {
  HubAnalysisDocument,
  HubCaptureCapabilities,
  HubChatAnswer,
  HubChatEvidenceSource,
  HubMeetingSummary,
  HubTranscriptContent,
  MeetingDetail,
  MeetingHubOverview,
  TranscriptSearchHit,
} from "../domain/hub";

const meetings = window.aiWorkMate.meetings;

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
const captureStatus = $("hub-capture-status");

let capabilities: HubCaptureCapabilities | undefined;
let openMeetingId: string | undefined;
let openMeetingTitle = "";
let busy = false;

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

function showNoticeMessage(message: string, error = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.add("visible");
  window.setTimeout(() => notice.classList.remove("visible"), error ? 8000 : 3500);
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
    actions.append(button("Join", "button mini", () => {
      void meetings.openLinkedUrl(summary.meetingId, "JOIN")
        .then(() => showNoticeMessage("Opening the meeting link in your browser."))
        .catch((error: unknown) => showErrorMessage(error));
    }));
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
  renderList(next.recent, recentList, "No meeting history yet — record your first meeting to begin.");
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

async function refreshHub(): Promise<void> {
  if (busy) return;
  busy = true;
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
  } catch (error: unknown) {
    showErrorMessage(error);
  } finally {
    busy = false;
  }
}

// --- Capture controls --------------------------------------------------------

async function startCapture(meetingId: string): Promise<void> {
  try {
    await meetings.startCapture({ meetingId, microphone: true, systemLoopback: true, screen: false });
    showNoticeMessage("Recording started. Meeting audio stays on this device.");
  } catch (error: unknown) {
    showErrorMessage(error);
  }
  await refreshHub();
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
    const [detail, analysis] = await Promise.all([
      meetings.getDetail(meetingId),
      meetings.getAnalysis(meetingId).catch(() => undefined),
    ]);
    openMeetingId = meetingId;
    openMeetingTitle = detail.meeting.title;
    renderDetailPane(detail, analysis);
    syncChatScopeVisibility();
  } catch (error: unknown) {
    showErrorMessage(error);
  }
}

function renderDetailPane(detail: MeetingDetail, analysis: HubAnalysisDocument | undefined): void {
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
  if (summary.isActive) {
    actions.append(button("Stop recording", "button mini danger", () => void stopCapture(summary.meetingId)));
    actions.append(button("Cancel recording", "button mini ghost", () => void abortCapture(summary.meetingId)));
  } else if (captureSupported && summary.status !== "CANCELLED") {
    actions.append(button("Record meeting", "button mini primary", () => void startCapture(summary.meetingId)));
  }
  if (summary.calendar?.joinUrl !== undefined && summary.status !== "CANCELLED") {
    actions.append(button("Join meeting", "button mini", () => {
      void meetings.openLinkedUrl(summary.meetingId, "JOIN")
        .then(() => showNoticeMessage("Opening the meeting link in your browser."))
        .catch((error: unknown) => showErrorMessage(error));
    }));
  }
  const canProcess = summary.hasRecording && !summary.hasAnalysis && !summary.isActive &&
    (summary.status === "COMPLETED" || summary.status === "INCOMPLETE" || summary.status === "FAILED");
  if (canProcess) {
    actions.append(button("Transcribe & analyze", "button mini primary", () => void processMeeting(summary.meetingId)));
  }
  header.append(actions);
  detailPane.append(header);

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
  try {
    showNoticeMessage("Transcription and analysis started (local models by default).");
    await meetings.processMeeting(meetingId, false);
    await renderDetail(meetingId);
  } catch (error: unknown) {
    showErrorMessage(error);
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

// --- Init ---------------------------------------------------------------------

$("hub-refresh-button").addEventListener("click", () => void refreshHub());
bindSearch();
bindMeetingChat();
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
    void openDetail(meetingId);
    $("meetings").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}) as EventListener);
