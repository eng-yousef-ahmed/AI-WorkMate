import { InsufficientDiskSpaceError } from "./errors";
import type { LocalStorageService } from "./LocalStorageService";

export interface RecordingDiskMonitorOptions {
  criticalFreeBytes: number;
  intervalMs?: number;
  onCritical: (availableBytes: number | null) => void;
}

/** Monitors DATA_ROOT while a capture engine writes its temporary recording. */
export class RecordingDiskMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  public constructor(
    private readonly storage: LocalStorageService,
    private readonly options: RecordingDiskMonitorOptions,
  ) {}

  public async start(): Promise<void> {
    if (this.options.criticalFreeBytes < 0 || !Number.isFinite(this.options.criticalFreeBytes)) {
      throw new InsufficientDiskSpaceError(null, this.options.criticalFreeBytes);
    }
    await this.check();
    if (this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.check();
    }, this.options.intervalMs ?? 2_000);
    this.timer.unref();
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const available = await this.storage.getAvailableBytes();
    if (available !== null && available <= this.options.criticalFreeBytes) {
      this.options.onCritical(available);
      this.stop();
    }
  }
}
