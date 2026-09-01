import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ElectronSafeStorageCredentialStore } from "../security/CredentialStore";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { registerStorageIpc, type DialogLike, type IpcMainLike, type ShellLike } from "./storage-ipc";
import { createSecureRendererPreferences, denyWindowOpen, isAuthorizedRendererNavigation } from "./window-security";

let runtime: StorageRuntime | undefined;
let mainWindow: BrowserWindow | undefined;
let ipcRegistered = false;

async function bootstrap(): Promise<void> {
  if (runtime === undefined) {
    const userDataPath = app.getPath("userData");
    const config = new StorageConfigService(join(userDataPath, "storage-config.json"));
    const credentialStore = new ElectronSafeStorageCredentialStore(safeStorage, join(userDataPath, "credential-vault.json"));
    runtime = new StorageRuntime(config, () => new Date(), credentialStore, {
      installationDirectory: dirname(app.getPath("exe")),
    });
  }
  const configured = await runtime.initialize();
  if (!configured) {
    const firstRunSelection = await dialog.showOpenDialog({
      title: "Choose where AI WorkMate should store your data",
      message: "Meeting recordings, transcripts, analysis, and the local database stay in this folder.",
      properties: ["openDirectory", "createDirectory"],
    });
    const selected = firstRunSelection.filePaths[0];
    if (firstRunSelection.canceled || selected === undefined) {
      app.quit();
      return;
    }
    await runtime.configureFirstRun(selected);
  }

  // Scan at startup, but do not block access to a user's data if one artifact
  // is unreadable; the Storage Settings page can run the scan/repair on demand.
  try {
    await runtime.verifyStorage();
  } catch (error: unknown) {
    console.error("AI WorkMate startup storage scan could not complete", error);
  }

  const rendererPath = join(__dirname, "../renderer/storage-settings.html");
  const rendererUrl = pathToFileURL(rendererPath).toString();
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: "AI WorkMate",
    webPreferences: createSecureRendererPreferences(join(__dirname, "preload.js")),
  });
  configureWindowSecurity(mainWindow, rendererUrl);
  if (!ipcRegistered) {
    registerStorageIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      dialog: dialog as unknown as DialogLike,
      shell: shell as unknown as ShellLike,
      runtime,
      getAuthorizedWebContentsId: () => mainWindow?.webContents.id,
      getAuthorizedRendererUrl: () => rendererUrl,
    });
    ipcRegistered = true;
  }
  await mainWindow.loadFile(rendererPath);
}

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  window.webContents.setWindowOpenHandler(() => denyWindowOpen());
  const rejectNavigation = (event: Electron.Event, url: string): void => {
    if (!isAuthorizedRendererNavigation(url, rendererUrl)) {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", rejectNavigation);
  // Electron's current type declarations omit this documented frame event.
  const frameNavigation = window.webContents as unknown as {
    on(event: "will-frame-navigate", listener: (event: Electron.Event, url: string) => void): void;
  };
  frameNavigation.on("will-frame-navigate", rejectNavigation);
  window.webContents.on("will-redirect", rejectNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

app.whenReady().then(() => bootstrap()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  void dialog.showMessageBox({ type: "error", title: "AI WorkMate could not start", message });
  app.quit();
});

app.on("window-all-closed", () => {
  runtime?.store?.close();
  mainWindow = undefined;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtime !== undefined) {
    void bootstrap();
  }
});
