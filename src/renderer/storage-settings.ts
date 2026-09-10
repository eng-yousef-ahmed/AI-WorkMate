import type { CalendarConnectionStatus, BeginCalendarSignInResult } from "../calendar/CalendarConnection";
import type { RendererCalendarSyncResult } from "../calendar/CalendarModels";
import type { MicrosoftOAuthSettingsInput, GoogleOAuthSettingsInput } from "../desktop/storage-api";
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
refreshAllCalendarStatus();

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

// --- Calendar integration panels -------------------------------------------------

type CalendarPanelConfigInput = MicrosoftOAuthSettingsInput | GoogleOAuthSettingsInput;

interface CalendarPanelApi {
  getStatus(): Promise<CalendarConnectionStatus | undefined>;
  beginSignIn(): Promise<BeginCalendarSignInResult>;
  completeSignIn(input: { flowId: string; redirectUrl: string }): Promise<CalendarConnectionStatus>;
  cancelSignIn(): Promise<void>;
  disconnect(): Promise<CalendarConnectionStatus>;
  syncAuto(): Promise<RendererCalendarSyncResult>;
  saveConfig(input: CalendarPanelConfigInput): Promise<CalendarConnectionStatus>;
}

interface CalendarPanelIds {
  badge: string;
  accountName: string;
  accountEmail: string;
  connect: string;
  sync: string;
  cancel: string;
  disconnect: string;
  statusLine: string;
  manual: string;
  manualUrl: string;
  manualSubmit: string;
  config: string;
  configSave: string;
  configClientId: string;
}

interface CalendarPanelState {
  awaitingCompletion: boolean;
  flow?: BeginCalendarSignInResult;
  pollHandle?: number;
  busy: boolean;
}

function bindCalendarPanel(
  prefix: string,
  ids: CalendarPanelIds,
  api: CalendarPanelApi,
  extraConfigFields: Array<[string, string]>, // [elementId, value]
  connectLabel: string,
): void {
  const state: CalendarPanelState = { awaitingCompletion: false, busy: false };
  let lastStatus: CalendarConnectionStatus | undefined;

  const statusLine = () => $(ids.statusLine);

  const busyButtons = (busy: boolean): void => {
    $<HTMLButtonElement>(ids.sync).disabled = busy || lastStatus?.state !== "CONNECTED";
    $<HTMLButtonElement>(ids.connect).disabled = busy;
    $<HTMLButtonElement>(ids.disconnect).disabled = busy;
    $<HTMLButtonElement>(ids.configSave).disabled = busy;
  };

  const showStatusLine = (message: string, error = false): void => {
    statusLine().hidden = false;
    statusLine().classList.toggle("error-line", error);
    statusLine().textContent = message;
  };

  const renderSyncResult = (result: RendererCalendarSyncResult): void => {
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
    showStatusLine(parts.join(" · "), withErrors);
  };

  const stopPolling = (): void => {
    if (state.pollHandle !== undefined) {
      window.clearInterval(state.pollHandle);
      state.pollHandle = undefined;
    }
  };

  const ensurePolling = (): void => {
    if (state.pollHandle === undefined) {
      state.pollHandle = window.setInterval(() => {
        void api.getStatus().then(renderStatus).catch((error: unknown) => showError(error));
      }, 1500);
    }
  };

  function renderStatus(status: CalendarConnectionStatus | undefined): void {
    lastStatus = status;
    const badge = $(ids.badge);
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

    $(ids.accountName).textContent = status?.account?.displayName ?? (connected ? "Signed in" : "Not signed in");
    $(ids.accountEmail).textContent = status?.account?.email ?? (connected ? connectLabel : `Connect to sync your ${connectLabel}`);

    $<HTMLButtonElement>(ids.connect).hidden = connected || status?.state === "NOT_CONFIGURED";
    $<HTMLButtonElement>(ids.disconnect).hidden = !connected;
    $<HTMLButtonElement>(ids.cancel).hidden = !inProgress;
    busyButtons(state.busy);

    if (status?.state === "NOT_CONFIGURED") {
      statusLine().hidden = false;
      statusLine().classList.remove("error-line");
      statusLine().textContent = `Add your ${prefix === "ms" ? "Microsoft Application (client) ID" : "Google OAuth client ID"} below to enable sign-in.`;
      const config = $(ids.config);
      (config as HTMLDetailsElement).open = true;
    } else if (inProgress) {
      const flow = state.flow;
      statusLine().hidden = false;
      statusLine().classList.remove("error-line");
      statusLine().textContent = flow === undefined
        ? "Waiting for the sign-in to finish…"
        : `Waiting for ${prefix === "ms" ? "Microsoft" : "Google"} to finish signing you in (started ${formatTime(flow.startedAt)}, expires ${formatTime(flow.expiresAt)}).`;
      $(ids.manual).hidden = false;
      $<HTMLInputElement>(ids.manualUrl).value = "";
      ensurePolling();
    } else if (signIn?.state === "FAILED") {
      state.awaitingCompletion = false;
      stopPolling();
      $(ids.manual).hidden = true;
      showStatusLine(`Sign-in failed: ${signIn.error?.message ?? "Please start again."}`, true);
    } else if (connected) {
      statusLine().hidden = true;
      $(ids.manual).hidden = true;
      if (state.awaitingCompletion) {
        state.awaitingCompletion = false;
        stopPolling();
        showStatusLine("Signed in — syncing your calendar…");
        void syncNow();
      }
    } else if (state.awaitingCompletion) {
      state.awaitingCompletion = false;
      stopPolling();
      $(ids.manual).hidden = true;
      showStatusLine("The sign-in did not complete. You can try again.", true);
    } else {
      statusLine().hidden = true;
      $(ids.manual).hidden = true;
    }
  }

  async function refreshStatus(): Promise<void> {
    try {
      renderStatus(await api.getStatus());
    } catch (error: unknown) {
      showError(error);
    }
  }

  async function connect(): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    busyButtons(true);
    try {
      state.flow = await api.beginSignIn();
      state.awaitingCompletion = true;
      showStatusLine(
        `Sign-in started in your browser and should finish by ${formatTime(state.flow.expiresAt)}. ` +
          `If a browser did not open, copy this address into one: ${state.flow.authorizationUrl}`,
      );
      $(ids.manual).hidden = false;
      await refreshStatus();
    } catch (error: unknown) {
      showError(error);
    } finally {
      state.busy = false;
      busyButtons(false);
    }
  }

  async function syncNow(): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    busyButtons(true);
    try {
      renderSyncResult(await api.syncAuto());
    } catch (error: unknown) {
      showError(error);
    } finally {
      state.busy = false;
      busyButtons(false);
    }
  }

  async function cancelSignIn(): Promise<void> {
    state.awaitingCompletion = false;
    state.flow = undefined;
    stopPolling();
    try {
      await api.cancelSignIn();
      showStatusLine("Sign-in cancelled. You can start again any time.");
      await refreshStatus();
    } catch (error: unknown) {
      showError(error);
    }
  }

  async function disconnect(): Promise<void> {
    const confirmed = window.confirm(
      `Disconnect ${connectLabel}? Your local meeting data stays on this computer, but calendar synchronization stops and the saved sign-in is removed from the secure credential store.`,
    );
    if (!confirmed) return;
    state.awaitingCompletion = false;
    state.flow = undefined;
    stopPolling();
    try {
      renderStatus(await api.disconnect());
      showStatusLine(`${connectLabel} disconnected. Existing local meetings were kept.`);
    } catch (error: unknown) {
      showError(error);
    }
  }

  async function completeManual(): Promise<void> {
    const flow = state.flow;
    if (flow === undefined) {
      showError(new Error("Start a new sign-in before completing it manually."));
      return;
    }
    const redirectUrl = $<HTMLInputElement>(ids.manualUrl).value.trim();
    if (redirectUrl.length === 0) {
      showError(new Error("Paste the address your browser ended on into the field above."));
      return;
    }
    try {
      const status = await api.completeSignIn({ flowId: flow.flowId, redirectUrl });
      state.awaitingCompletion = false;
      state.flow = undefined;
      stopPolling();
      renderStatus(status);
      if (status.state === "CONNECTED") {
        showStatusLine("Signed in — syncing your calendar…");
        await syncNow();
      }
    } catch (error: unknown) {
      showError(error);
    }
  }

  async function saveConfig(): Promise<void> {
    const clientId = $<HTMLInputElement>(ids.configClientId).value.trim();
    const config: CalendarPanelConfigInput = { clientId };
    for (const [elementId, key] of extraConfigFields) {
      (config as Record<string, string>)[key] = $<HTMLInputElement>(elementId).value.trim();
    }
    if (Object.values(config).every((value) => value === "")) {
      showError(new Error(`Enter your ${prefix === "ms" ? "Application (client) ID" : "OAuth client ID"} before saving.`));
      return;
    }
    try {
      const status = await api.saveConfig(config);
      renderStatus(status);
      showStatusLine(`${connectLabel} integration settings saved.`);
    } catch (error: unknown) {
      showError(error);
    }
  }

  $(ids.connect).addEventListener("click", () => void connect());
  $(ids.sync).addEventListener("click", () => void syncNow());
  $(ids.cancel).addEventListener("click", () => void cancelSignIn());
  $(ids.disconnect).addEventListener("click", () => void disconnect());
  $(ids.manualSubmit).addEventListener("click", () => void completeManual());
  $(ids.configSave).addEventListener("click", () => void saveConfig());
  void refreshStatus();
}

bindCalendarPanel(
  "ms",
  {
    badge: "ms-badge",
    accountName: "ms-account-name",
    accountEmail: "ms-account-email",
    connect: "ms-connect-button",
    sync: "ms-sync-button",
    cancel: "ms-cancel-button",
    disconnect: "ms-disconnect-button",
    statusLine: "ms-status-line",
    manual: "ms-manual",
    manualUrl: "ms-manual-url",
    manualSubmit: "ms-manual-submit",
    config: "ms-config",
    configSave: "ms-config-save",
    configClientId: "ms-client-id",
  },
  {
    getStatus: () => calendar.getMicrosoftStatus(),
    beginSignIn: () => calendar.beginMicrosoftSignIn(),
    completeSignIn: (input) => calendar.completeMicrosoftSignIn(input),
    cancelSignIn: () => calendar.cancelMicrosoftSignIn(),
    disconnect: () => calendar.disconnectMicrosoft(),
    syncAuto: () => calendar.syncMicrosoftCalendarAuto(),
    saveConfig: (input) => calendar.saveMicrosoftOAuthConfig(input as MicrosoftOAuthSettingsInput),
  },
  [["ms-tenant", "tenant"], ["ms-redirect-uri", "redirectUri"]],
  "Microsoft 365 calendar",
);

bindCalendarPanel(
  "google",
  {
    badge: "google-badge",
    accountName: "google-account-name",
    accountEmail: "google-account-email",
    connect: "google-connect-button",
    sync: "google-sync-button",
    cancel: "google-cancel-button",
    disconnect: "google-disconnect-button",
    statusLine: "google-status-line",
    manual: "google-manual",
    manualUrl: "google-manual-url",
    manualSubmit: "google-manual-submit",
    config: "google-config",
    configSave: "google-config-save",
    configClientId: "google-client-id",
  },
  {
    getStatus: () => calendar.getGoogleStatus(),
    beginSignIn: () => calendar.beginGoogleSignIn(),
    completeSignIn: (input) => calendar.completeGoogleSignIn(input),
    cancelSignIn: () => calendar.cancelGoogleSignIn(),
    disconnect: () => calendar.disconnectGoogle(),
    syncAuto: () => calendar.syncGoogleCalendarAuto(),
    saveConfig: (input) => calendar.saveGoogleOAuthConfig(input as GoogleOAuthSettingsInput),
  },
  [["google-client-secret", "clientSecret"], ["google-redirect-uri", "redirectUri"]],
  "Google Calendar",
);

function refreshAllCalendarStatus(): void {
  // Panels refresh themselves on bind; nothing further is required here.
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

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
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
  const message = error instanceof Error ? error.message : String(error);
  const looksLikePath = /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|file:\/\/|DATA_ROOT)/i.test(message);
  showNotice(looksLikePath ? "The storage action could not be completed. Please try again." : message, true);
}
