import type { RuntimeRendererAPI } from "../desktop/runtime-api";
import type { AutomationRendererAPI } from "../desktop/storage-api";
import type { CalendarRendererAPI } from "../desktop/storage-api";
import type { MeetingsRendererAPI } from "../desktop/storage-api";
import type { NotificationsRendererAPI } from "../desktop/storage-api";
import type { StorageRendererAPI } from "../desktop/storage-api";
import type { TasksRendererAPI } from "../desktop/storage-api";

declare global {
  interface Window {
    aiWorkMate: {
      storage: StorageRendererAPI;
      calendar: CalendarRendererAPI;
      meetings: MeetingsRendererAPI;
      tasks: TasksRendererAPI;
      automation: AutomationRendererAPI;
      notifications: NotificationsRendererAPI;
      runtime: RuntimeRendererAPI;
    };
  }
}

export {};
