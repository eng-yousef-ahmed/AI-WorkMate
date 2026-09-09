import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { HubAutomationPreferences } from "../domain/hub";
import { DataRootValidationError } from "../storage/errors";
import { normalizeAbsolutePath } from "../storage/LocalStorageService";

export const DEFAULT_AUTOMATION_PREFERENCES: HubAutomationPreferences = {
  meetingDetection: true,
  meetingPreparation: false,
  meetingPreparationMinutes: 15,
  meetingSummaries: false,
  assignedTaskNotifications: false,
  overdueReminders: false,
  dailyMeetingReports: false,
  unresolvedFollowupReminders: false,
  captureMicrophone: true,
  captureSystemLoopback: true,
  captureScreen: false,
};

const MIN_PREPARATION_MINUTES = 1;
const MAX_PREPARATION_MINUTES = 120;

/**
 * User-controlled automation and capture preferences stored outside DATA_ROOT
 * (Electron userData). Contains no meeting content, credentials, or tokens.
 */
export class AutomationPreferencesStore {
  private readonly configPath: string;
  private readonly clock: () => Date;

  public constructor(configPath: string, clock: () => Date = () => new Date()) {
    this.configPath = normalizeAbsolutePath(configPath);
    this.clock = clock;
  }

  public get path(): string {
    return this.configPath;
  }

  public async read(): Promise<HubAutomationPreferences> {
    try {
      const value = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
      return normalizeAutomationPreferences(value);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { ...DEFAULT_AUTOMATION_PREFERENCES };
      }
      if (error instanceof SyntaxError) {
        throw new DataRootValidationError("The automation preferences file is not valid JSON.", { cause: error });
      }
      throw error;
    }
  }

  public async write(patch: Partial<HubAutomationPreferences>): Promise<HubAutomationPreferences> {
    const next = normalizeAutomationPreferences({ ...(await this.read()), ...patch });
    await mkdir(dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.tmp-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ ...next, updatedAt: this.clock().toISOString() }, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.configPath);
      return next;
    } catch (error: unknown) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function normalizeAutomationPreferences(value: unknown): HubAutomationPreferences {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const minutes = typeof record.meetingPreparationMinutes === "number" && Number.isFinite(record.meetingPreparationMinutes)
    ? Math.trunc(record.meetingPreparationMinutes)
    : DEFAULT_AUTOMATION_PREFERENCES.meetingPreparationMinutes;
  return {
    meetingDetection: record.meetingDetection !== false,
    meetingPreparation: record.meetingPreparation === true,
    meetingPreparationMinutes: Math.min(MAX_PREPARATION_MINUTES, Math.max(MIN_PREPARATION_MINUTES, minutes)),
    meetingSummaries: record.meetingSummaries === true,
    assignedTaskNotifications: record.assignedTaskNotifications === true,
    overdueReminders: record.overdueReminders === true,
    dailyMeetingReports: record.dailyMeetingReports === true,
    unresolvedFollowupReminders: record.unresolvedFollowupReminders === true,
    captureMicrophone: record.captureMicrophone !== false,
    captureSystemLoopback: record.captureSystemLoopback !== false,
    captureScreen: record.captureScreen === true,
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
