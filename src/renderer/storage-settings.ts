import type { CalendarConnectionStatus, BeginCalendarSignInResult } from "../calendar/CalendarConnection";
import type { RendererCalendarSyncResult } from "../calendar/CalendarModels";
import type { MicrosoftOAuthSettingsInput } from "../desktop/storage-api";
import type { StorageSnapshot } from "../domain/models";

const storage = window.aiWorkMate.storage;
const calendar = window.aiWorkMate.calendar;
const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing renderer element: ${id}`);
  return element as T;
};

const notice = $("notice");
const policyDescriptions: Record<string, string> = {
  LOCAL_ONLY: "Only a local AI provider may process content. Cloud providers are blocked by policy.",
  CLOUD_ALLOWED: "Cloud providers may process selected content when enabled. The provider and transmission are shown first.",
  ASK_EACH_TIME: "You will be told what content leaves this computer, why, and which provider receives it before each cloud request.",
};

void loadSnapshot();

$("refresh-button").addEventListener("click", () => void loadSnapshot());
$("open-folder-button").addEventListener("click", () => void runAction(storage.openDataFolder(), "Data folder opened."));
$("verify-button").addEventListener("click", () => void verify(false));
$("repair-button").addEventListener("click", () => void verify(true));
$("backup-button").addEventListener("click", () => void createBackup());
$("restore-button").addEventListener("click", () => void restoreBackup());
$("change-location-button").addEventListener("click", () => void changeLocation());
$("ai-policy").addEventListener("change", (event) => {
  const policy = (event.target as HTMLSelectElement).value as "LOCAL_ONLY" | "CLOUD_ALLOWED" | "ASK_EACH_TIME";
  void runAction(storage.setAiProcessingPolicy(policy), "AI processing policy updated.").then(() => updatePolicyDescription(policy));
});

// --- Microsoft 365 calendar integration ------------------------------------

const CALENDAR_POLL_MS = 1500;

interface CalendarUiState {
  awaitingCompletion: boolean;
  flow?: BeginCalendarSignInResult;
  pollHandle?: number;
  busy: boolean;
}

const calendarUi: CalendarUiState = { awaitingCompletion: false, busy: false };
let lastCalendarStatus: CalendarConnectionStatus | undefined;

$("calendar-connect-button").addEventListener("click", () => void connectMicrosoftCalendar());
$("calendar-sync-button").addEventListener("click", () => void syncCalendarNow());
$("calendar-cancel-button").addEventListener("click", () => void cancelMicrosoftSignIn());
$("calendar-disconnect-button").addEventListener("click", () => void disconnectMicrosoftCalendar());
$("calendar-manual-submit").addEventListener("click", () => void completeManualSignIn());
$("calendar-config-save").addEventListener("click", () => void saveOAuthSettings());
void refreshCalendarStatus();

async function connectMicrosoftCalendar(): Promise<void> {
  if (calendarUi.busy) return;
  calendarUi.busy = true;
  setCalendarButtonsBusy(true);
  try {
    calendarUi.flow = await calendar.beginMicrosoftSignIn();
    calendarUi.awaitingCompletion = true;
    showCalendarStatusLine(
      `Sign-in started in your browser and should finish by ${formatTime(calendarUi.flow.expiresAt)}. ` +
        `If a browser did not open, copy this address into one: ${calendarUi.flow.authorizationUrl}`,
    );
    $("calendar-manual").hidden = false;
    await refreshCalendarStatus();
  } catch (error: unknown) {
    showError(error);
  } finally {
    calendarUi.busy = false;
    setCalendarButtonsBusy(false);
  }
}

async function refreshCalendarStatus(): Promise<void> {
  let status: CalendarConnectionStatus | undefined;
  try {
    status = await calendar.getMicrosoftStatus();
  } catch (error: unknown) {
    showError(error);
    return;
  }
  lastCalendarStatus = status;
  renderCalendarStatus(status);
}

function renderCalendarStatus(status: CalendarConnectionStatus | undefined): void {
  const badge = $("calendar-badge");
  badge.className = "calendar-badge";
  const connected = status?.state === "CONNECTED";
  const signIn = status?.signIn;
  const inProgress = signIn?.state === "IN_PROGRESS";

  if (status === undefined) {
    badge.textContent = "Unavailable";
    badge.classList.add("neutral");
  } else if (status.state === "NOT_CONFIGURED") {
    badge.textContent = "Setup required";
    badge.classList.add("warn");
  } else if (connected) {
    badge.textContent = "Connected";
    badge.classList.add("ok");
  } else {
    badge.textContent = "Disconnected";
    badge.classList.add("neutral");
  }

  $("calendar-account-name").textContent = status?.account?.displayName ?? (connected ? "Signed in" : "Not signed in");
  $("calendar-account-email").textContent = status?.account?.email ??
    (connected ? "Microsoft 365 calendar" : "Connect to sync your calendar locally");

  $("calendar-connect-button").hidden = connected || status?.state === "NOT_CONFIGURED";
  $("calendar-disconnect-button").hidden = !connected;
  $("calendar-cancel-button").hidden = !inProgress;
  $<HTMLButtonElement>("calendar-sync-button").disabled = !connected || calendarUi.busy;
  $<HTMLButtonElement>("calendar-config-save").disabled = calendarUi.busy;

  if (status?.state === "NOT_CONFIGURED") {
    $("calendar-status-line").hidden = false;
    $("calendar-status-line").classList.remove("error-line");
    $("calendar-status-line").textContent =
      "Add your Microsoft Application (client) ID below to enable sign-in. The app registration must be a public (native) client with the loopback redirect URI http://localhost.";
    const config = $("calendar-config");
    (config as HTMLDetailsElement).open = true;
  } else if (inProgress) {
    const flow = calendarUi.flow;
    $("calendar-status-line").hidden = false;
    $("calendar-status-line").classList.remove("error-line");
    $("calendar-status-line").textContent = flow === undefined
      ? "Waiting for the Microsoft sign-in to finish…"
      : `Waiting for Microsoft to finish signing you in (started ${formatTime(flow.startedAt)}, expires ${formatTime(flow.expiresAt)}).`;
    $("calendar-manual").hidden = false;
    $<HTMLInputElement>("calendar-manual-url").value = "";
    ensureCalendarPolling();
  } else if (signIn?.state === "FAILED") {
    calendarUi.awaitingCompletion = false;
    stopCalendarPolling();
    $("calendar-manual").hidden = true;
    showCalendarStatusLine(`Sign-in failed: ${signIn.error?.message ?? "Please start again."}`, true);
  } else if (connected) {
    $("calendar-status-line").hidden = true;
    $("calendar-manual").hidden = true;
    if (calendarUi.awaitingCompletion) {
      calendarUi.awaitingCompletion = false;
      stopCalendarPolling();
      showCalendarStatusLine("Signed in to Microsoft 365 — syncing your calendar…", false);
      void syncCalendarNow();
    }
  } else if (calendarUi.awaitingCompletion) {
    // The flow ended without a session: cancelled, expired, or rejected.
    calendarUi.awaitingCompletion = false;
    stopCalendarPolling();
    $("calendar-manual").hidden = true;
    showCalendarStatusLine("The Microsoft sign-in did not complete. You can try again.", true);
  } else {
    $("calendar-status-line").hidden = true;
    $("calendar-manual").hidden = true;
  }
  const expiry = status?.accessTokenExpiresAt;
  if (connected && expiry !== undefined) {
    $("calendar-sync-button").title = `Access token refreshes automatically around ${formatTime(expiry)}.`;
  }
}

function ensureCalendarPolling(): void {
  if (calendarUi.pollHandle === undefined) {
    calendarUi.pollHandle = window.setInterval(() => {
      void calendar.getMicrosoftStatus().then(renderCalendarStatus).catch((error: unknown) => showError(error));
    }, CALENDAR_POLL_MS);
  }
}

function stopCalendarPolling(): void {
  if (calendarUi.pollHandle !== undefined) {
    window.clearInterval(calendarUi.pollHandle);
    calendarUi.pollHandle = undefined;
  }
}

function setCalendarButtonsBusy(busy: boolean): void {
  $<HTMLButtonElement>("calendar-sync-button").disabled = busy || lastCalendarStatus?.state !== "CONNECTED";
  $<HTMLButtonElement>("calendar-connect-button").disabled = busy;
  $<HTMLButtonElement>("calendar-disconnect-button").disabled = busy;
  $<HTMLButtonElement>("calendar-config-save").disabled = busy;
}

async function cancelMicrosoftSignIn(): Promise<void> {
  calendarUi.awaitingCompletion = false;
  calendarUi.flow = undefined;
  stopCalendarPolling();
  try {
    await calendar.cancelMicrosoftSignIn();
    showCalendarStatusLine("Sign-in cancelled. You can start again any time.");
    await refreshCalendarStatus();
  } catch (error: unknown) {
    showError(error);
  }
}

async function syncCalendarNow(): Promise<void> {
  if (calendarUi.busy) return;
  calendarUi.busy = true;
  setCalendarButtonsBusy(true);
  try {
    const result = await calendar.syncMicrosoftCalendarAuto();
    renderSyncResult(result);
  } catch (error: unknown) {
    showError(error);
  } finally {
    calendarUi.busy = false;
    setCalendarButtonsBusy(false);
  }
}

function renderSyncResult(result: RendererCalendarSyncResult): void {
  const parts: string[] = [];
  parts.push(`${result.mode ?? "SYNC"} sync finished`);
  parts.push(`${result.createdCount} created`);
  parts.push(`${result.updatedCount} updated`);
  if (result.unchangedCount > 0) parts.push(`${result.unchangedCount} unchanged`);
  if ((result.deletedCount ?? 0) > 0) parts.push(`${result.deletedCount} deleted`);
  if ((result.movedOutCount ?? 0) > 0) parts.push(`${result.movedOutCount} moved out`);
  if (result.cancelledCount > 0) parts.push(`${result.cancelledCount} cancelled`);
  const withErrors = result.errorCount > 0;
  if (withErrors) parts.push(`${result.errorCount} error(s)`);
  showCalendarStatusLine(parts.join(" · "), withErrors);
}

async function completeManualSignIn(): Promise<void> {
  const flow = calendarUi.flow;
  if (flow === undefined) {
    showError(new Error("Start a new sign-in before completing it manually."));
    return;
  }
  const redirectUrl = $<HTMLInputElement>("calendar-manual-url").value.trim();
  if (redirectUrl.length === 0) {
    showError(new Error("Paste the address your browser ended on into the field above."));
    return;
  }
  try {
    const status = await calendar.completeMicrosoftSignIn({ flowId: flow.flowId, redirectUrl });
    calendarUi.awaitingCompletion = false;
    calendarUi.flow = undefined;
    stopCalendarPolling();
    renderCalendarStatus(status);
    if (status.state === "CONNECTED") {
      showCalendarStatusLine("Signed in to Microsoft 365 — syncing your calendar…", false);
      await syncCalendarNow();
    }
  } catch (error: unknown) {
    showError(error);
  }
}

async function disconnectMicrosoftCalendar(): Promise<void> {
  const confirmed = window.confirm(
    "Disconnect Microsoft 365? Your local meeting data stays on this computer, but calendar synchronization stops and the saved sign-in is removed from the secure credential store.",
  );
  if (!confirmed) return;
  calendarUi.awaitingCompletion = false;
  calendarUi.flow = undefined;
  stopCalendarPolling();
  try {
    const status = await calendar.disconnectMicrosoft();
    renderCalendarStatus(status);
    showCalendarStatusLine("Microsoft 365 disconnected. Existing local meetings were kept.");
  } catch (error: unknown) {
    showError(error);
  }
}

async function saveOAuthSettings(): Promise<void> {
  const input: MicrosoftOAuthSettingsInput = {
    clientId: $<HTMLInputElement>("ms-client-id").value.trim(),
    tenant: $<HTMLInputElement>("ms-tenant").value.trim(),
    redirectUri: $<HTMLInputElement>("ms-redirect-uri").value.trim(),
  };
  if (input.clientId === "" && input.tenant === "" && input.redirectUri === "") {
    showError(new Error("Enter at least your Microsoft Application (client) ID before saving."));
    return;
  }
  try {
    const status = await calendar.saveMicrosoftOAuthConfig(input);
    renderCalendarStatus(status);
    showCalendarStatusLine("Microsoft 365 integration settings saved.");
  } catch (error: unknown) {
    showError(error);
  }
}

function showCalendarStatusLine(message: string, error = false): void {
  const line = $("calendar-status-line");
  line.hidden = false;
  line.textContent = message;
  line.classList.toggle("error-line", error);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

// --- Storage snapshot --------------------------------------------------------

async function loadSnapshot(): Promise<void> {
  try {
    const snapshot = await storage.getSnapshot();
    renderSnapshot(snapshot);
    showNotice("Storage statistics refreshed.");
  } catch (error: unknown) {
    showError(error);
  }
}

function renderSnapshot(snapshot: StorageSnapshot): void {
  $("data-location").textContent = snapshot.dataLocation.label;
  $("last-check").textContent = snapshot.lastIntegrityCheckAt
    ? `Last verified ${formatDate(snapshot.lastIntegrityCheckAt)}`
    : "Integrity has not been checked yet";
  $("total-size").textContent = formatBytes(snapshot.stats.totalBytes);
  $("recordings-size").textContent = formatBytes(snapshot.stats.recordingsBytes);
  $("audio-size").textContent = formatBytes(snapshot.stats.audioBytes);
  $("transcripts-size").textContent = formatBytes(snapshot.stats.transcriptsBytes);
  $("documents-size").textContent = formatBytes(snapshot.stats.documentsBytes);
  $("database-size").textContent = formatBytes(snapshot.stats.databaseBytes);
  $("file-count").textContent = `${snapshot.stats.fileCount.toLocaleString()} files`;
  $("meeting-count").textContent = `${snapshot.stats.meetingCount.toLocaleString()} meetings`;
  $("availability").textContent = snapshot.stats.availableBytes === null
    ? "Available space unavailable"
    : `${formatBytes(snapshot.stats.availableBytes)} available`;
  setBar("recordings-bar", snapshot.stats.recordingsBytes, snapshot.stats.totalBytes);
  setBar("audio-bar", snapshot.stats.audioBytes, snapshot.stats.totalBytes);
  setBar("transcripts-bar", snapshot.stats.transcriptsBytes, snapshot.stats.totalBytes);
  setBar("documents-bar", snapshot.stats.documentsBytes, snapshot.stats.totalBytes);
  const policy = $("ai-policy") as HTMLSelectElement;
  policy.value = snapshot.aiProcessingPolicy;
  updatePolicyDescription(snapshot.aiProcessingPolicy);
}

async function changeLocation(): Promise<void> {
  try {
    const preview = await storage.prepareLocationChange();
    if (preview.canceled || preview.requestId === undefined) return;
    const bytes = formatBytes(preview.bytesToMove ?? 0);
    const approved = window.confirm(
      `Move ${preview.meetingCount ?? 0} meetings and ${bytes} of local data to the selected folder?\n\n` +
        "The current location will be preserved until the copy is verified. Choose Cancel to leave the current location unchanged.",
    );
    if (!approved) {
      showNotice("Location unchanged. Existing data was not moved.");
      return;
    }
    await storage.confirmLocationChange(preview.requestId, true);
    await loadSnapshot();
    showNotice("Data location changed after successful migration verification.");
  } catch (error: unknown) {
    showError(error);
  }
}

async function verify(repair: boolean): Promise<void> {
  try {
    const report = repair ? await storage.repairStorage() : await storage.verifyStorage();
    if (report.issues.length === 0) {
      showNotice(repair ? "Index repaired and storage is healthy." : "Storage verified. No integrity issues found.");
    } else {
      showNotice(`${report.issues.length} storage issue(s) found. Unknown files were preserved.`, true);
    }
    await loadSnapshot();
  } catch (error: unknown) {
    showError(error);
  }
}

async function createBackup(): Promise<void> {
  try {
    const result = await storage.createBackup();
    if (result === null) return;
    showNotice(`Backup created locally (${formatBytes(result.size)}).`);
  } catch (error: unknown) {
    showError(error);
  }
}

async function restoreBackup(): Promise<void> {
  try {
    const result = await storage.restoreBackup();
    if (result === null) return;
    showNotice(`Backup restored and verified into the selected folder. The active location was not changed.`);
  } catch (error: unknown) {
    showError(error);
  }
}

function updatePolicyDescription(policy: string): void {
  $("policy-description").textContent = policyDescriptions[policy] ?? "Choose how AI processing may use external services.";
}

async function runAction(action: Promise<unknown>, success: string): Promise<void> {
  try {
    await action;
    showNotice(success);
  } catch (error: unknown) {
    showError(error);
  }
}

function setBar(id: string, value: number, total: number): void {
  const percentage = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  $<HTMLElement>(id).style.width = `${percentage}%`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function showNotice(message: string, error = false): void {
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.add("visible");
}

function showError(error: unknown): void {
  showNotice(error instanceof Error ? error.message : String(error), true);
}
