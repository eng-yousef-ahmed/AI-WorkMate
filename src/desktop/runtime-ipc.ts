import { LocalLlmError } from "../ai/LocalLlmErrors";
import {
  isRuntimeComponentId,
  type LocalRuntimeSetupService,
  type RuntimeInstallResult,
  type RuntimeSetupSnapshot,
} from "../runtime/LocalRuntimeSetupService";
import { StorageError } from "../storage/errors";
import { TranscriptionError } from "../transcription/TranscriptionEngine";
import { sanitizeRendererIpcError } from "./ipc-sanitize";
import { RUNTIME_IPC_CHANNELS } from "./runtime-api";
import { secureHandler, type IpcMainLike } from "./storage-ipc";

export { RUNTIME_IPC_CHANNELS, type RuntimeRendererAPI } from "./runtime-api";

export interface RuntimeIpcDependencies {
  ipcMain: IpcMainLike;
  setup: LocalRuntimeSetupService;
  getAuthorizedWebContentsId: () => number | undefined;
  getAuthorizedRendererUrl: () => string;
}

export function registerRuntimeIpc({
  ipcMain,
  setup,
  getAuthorizedWebContentsId,
  getAuthorizedRendererUrl,
}: RuntimeIpcDependencies): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(
      channel,
      secureHandler(async (...args: unknown[]) => {
        try {
          return await listener(...args);
        } catch (error: unknown) {
          throw sanitizeRendererIpcError(error, "The local runtime action could not be completed. Please try again.", {
            isAllowed: (candidate) => candidate instanceof TranscriptionError || candidate instanceof LocalLlmError,
          });
        }
      }, getAuthorizedWebContentsId, getAuthorizedRendererUrl),
    );
  };

  handle(RUNTIME_IPC_CHANNELS.getSnapshot, async (): Promise<RuntimeSetupSnapshot> => setup.getSnapshot());

  handle(RUNTIME_IPC_CHANNELS.install, async (_event: unknown, component: unknown, replaceCorrupted: unknown): Promise<RuntimeInstallResult> => {
    if (!isRuntimeComponentId(component)) {
      throw new StorageError("Unknown local runtime component.");
    }
    if (replaceCorrupted !== undefined && typeof replaceCorrupted !== "boolean") {
      throw new StorageError("Invalid local runtime install request.");
    }
    return setup.install({
      component,
      ...(replaceCorrupted === true ? { replaceCorrupted: true } : {}),
    });
  });
}
