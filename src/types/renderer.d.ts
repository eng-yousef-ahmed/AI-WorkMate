import type { CalendarRendererAPI } from "../desktop/storage-api";
import type { StorageRendererAPI } from "../desktop/storage-api";

declare global {
  interface Window {
    aiWorkMate: {
      storage: StorageRendererAPI;
      calendar: CalendarRendererAPI;
    };
  }
}

export {};
