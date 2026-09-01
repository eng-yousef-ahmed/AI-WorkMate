import type { StorageSnapshot } from "../domain/models";

const storage = window.aiWorkMate.storage;
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
  $("data-location").textContent = snapshot.dataLocation;
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
    showNotice(`Backup restored and verified into ${result.destination}. The active location was not changed.`);
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
