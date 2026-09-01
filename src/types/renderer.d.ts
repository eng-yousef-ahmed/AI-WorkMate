import type { StorageRendererAPI } from "../desktop/storage-api";

declare global {
  interface Window {
    aiWorkMate: {
      storage: StorageRendererAPI;
    };
  }
}

export {};
