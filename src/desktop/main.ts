import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MicrosoftCalendarConnection } from "../integrations/microsoft/MicrosoftCalendarConnection";
import {
  loadMicrosoftOAuthConfig,
  normalizeMicrosoftOAuthConfig,
  saveMicrosoftOAuthConfig,
  type MicrosoftOAuthApplicationConfig,
} from "../integrations/microsoft/MicrosoftOAuthConfig";
import { GoogleCalendarConnection } from "../integrations/google/GoogleCalendarConnection";
import {
  loadGoogleOAuthConfig,
  normalizeGoogleOAuthConfig,
  saveGoogleOAuthConfig,
  type GoogleOAuthApplicationConfig,
} from "../integrations/google/GoogleOAuthConfig";
import { ElectronSafeStorageCredentialStore } from "../security/CredentialStore";
import { StorageConfigService } from "../storage/StorageConfigService";
import { StorageRuntime } from "../storage/StorageRuntime";
import { registerCalendarIpc, type GoogleOAuthConfigInput, type MicrosoftOAuthConfigInput } from "./calendar-ipc";
import { registerMeetingsIpc } from "./meetings-ipc";
import { registerTasksIpc } from "./tasks-ipc";
import { registerStorageIpc, type DialogLike, type IpcMainLike, type ShellLike } from "./storage-ipc";
import { createSecureRendererPreferences, denyWindowOpen, isAuthorizedRendererNavigation } from "./window-security";

let runtime: StorageRuntime | undefined;
let userDataPath = "";
let oauthConfigPath = "";
let googleOAuthConfigPath = "";
let microsoftCredentialStore: ElectronSafeStorageCredentialStore | undefined;
let mainWindow: BrowserWindow | undefined;
let ipcRegistered = false;

async function bootstrap(): Promise<void> {
  if (runtime === undefined) {
    userDataPath = app.getPath("userData");
    const config = new StorageConfigService(join(userDataPath, "storage-config.json"));
    microsoftCredentialStore = new ElectronSafeStorageCredentialStore(safeStorage, join(userDataPath, "credential-vault.json"));
    oauthConfigPath = join(userDataPath, "microsoft-oauth.json");
    googleOAuthConfigPath = join(userDataPath, "google-oauth.json");
    runtime = new StorageRuntime(config, () => new Date(), microsoftCredentialStore, {
      installationDirectory: dirname(app.getPath("exe")),
    }, {
      microsoftCalendarConnection: await createMicrosoftCalendarConnection(),
      googleCalendarConnection: await createGoogleCalendarConnection(),
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
    registerCalendarIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      runtime,
      getAuthorizedWebContentsId: () => mainWindow?.webContents.id,
      getAuthorizedRendererUrl: () => rendererUrl,
      openExternal: async (url: string) => {
        await shell.openExternal(url);
      },
      saveMicrosoftOAuthApplicationConfig: async (input: MicrosoftOAuthConfigInput) => {
        await saveOAuthConfig(input);
      },
      saveGoogleOAuthApplicationConfig: async (input: GoogleOAuthConfigInput) => {
        await saveGoogleConfig(input);
      },
    });
    registerMeetingsIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      runtime,
      getAuthorizedWebContentsId: () => mainWindow?.webContents.id,
      getAuthorizedRendererUrl: () => rendererUrl,
      openExternal: async (url: string) => {
        await shell.openExternal(url);
      },
    });
    registerTasksIpc({
      ipcMain: ipcMain as unknown as IpcMainLike,
      runtime,
      getAuthorizedWebContentsId: () => mainWindow?.webContents.id,
      getAuthorizedRendererUrl: () => rendererUrl,
    });
    ipcRegistered = true;
  }
  await mainWindow.loadFile(rendererPath);
}

/**
 * Creates the Microsoft 365 connection manager. The application (client) ID
 * comes from the user-editable `microsoft-oauth.json` under userData (outside
 * DATA_ROOT); `AI_WORKMATE_MICROSOFT_CLIENT_ID` fills it in only when the file
 * has none (e.g. first-run development). The file is the source of truth.
 */
async function createMicrosoftCalendarConnection(): Promise<MicrosoftCalendarConnection> {
  if (microsoftCredentialStore === undefined) {
    throw new Error("bootstrap order: credential store must exist before the calendar connection.");
  }
  const config = await loadOAuthConfig(oauthConfigPath);
  return new MicrosoftCalendarConnection({ config, credentialStore: microsoftCredentialStore });
}

/**
 * Creates the Google Calendar connection manager from the user-editable
 * `google-oauth.json` under userData (outside DATA_ROOT). The Google OAuth
 * client secret is optional and non-confidential (PKCE desktop client).
 */
async function createGoogleCalendarConnection(): Promise<GoogleCalendarConnection> {
  if (microsoftCredentialStore === undefined) {
    throw new Error("bootstrap order: credential store must exist before the calendar connection.");
  }
  const config = await loadGoogleConfig(googleOAuthConfigPath);
  return new GoogleCalendarConnection({ config, credentialStore: microsoftCredentialStore });
}

async function loadGoogleConfig(configPath: string): Promise<GoogleOAuthApplicationConfig> {
  try {
    return await loadGoogleOAuthConfig(configPath);
  } catch (error: unknown) {
    // A corrupt config file must not prevent the app from starting; it is
    // reported as NOT_CONFIGURED and can be corrected from Settings.
    console.error("AI WorkMate could not read the Google OAuth config", error);
    return {};
  }
}

/** Validates and persists the Google OAuth settings, then swaps the live connection. */
async function saveGoogleConfig(input: GoogleOAuthConfigInput): Promise<void> {
  const current = await loadGoogleOAuthConfig(googleOAuthConfigPath);
  const next: GoogleOAuthApplicationConfig = { ...current };
  if (input.clientId !== undefined) next.clientId = input.clientId;
  if (input.clientSecret !== undefined) next.clientSecret = input.clientSecret;
  if (input.redirectUri !== undefined) next.redirectUri = input.redirectUri;
  const normalized = normalizeGoogleOAuthConfig(next); // throws on invalid values
  await saveGoogleOAuthConfig(googleOAuthConfigPath, normalized);
  if (runtime !== undefined) {
    await runtime.setGoogleCalendarConnection(await createGoogleCalendarConnection());
  }
}

async function loadOAuthConfig(configPath: string): Promise<MicrosoftOAuthApplicationConfig> {
  let config: MicrosoftOAuthApplicationConfig;
  try {
    config = await loadMicrosoftOAuthConfig(configPath);
  } catch (error: unknown) {
    // A corrupt config file must not prevent the app from starting; it is
    // reported as NOT_CONFIGURED and can be corrected from Settings.
    console.error("AI WorkMate could not read the Microsoft OAuth config", error);
    config = {};
  }
  const environmentClientId = process.env.AI_WORKMATE_MICROSOFT_CLIENT_ID?.trim();
  if (config.clientId === undefined && environmentClientId !== undefined && environmentClientId.length > 0) {
    config.clientId = environmentClientId;
  }
  return normalizeMicrosoftOAuthConfig(config);
}

/** Validates and persists the OAuth settings, then swaps the live connection. */
async function saveOAuthConfig(input: MicrosoftOAuthConfigInput): Promise<void> {
  const current = await loadMicrosoftOAuthConfig(oauthConfigPath);
  const next: MicrosoftOAuthApplicationConfig = { ...current };
  if (input.clientId !== undefined) next.clientId = input.clientId;
  if (input.tenant !== undefined) next.tenant = input.tenant;
  if (input.redirectUri !== undefined) next.redirectUri = input.redirectUri;
  const normalized = normalizeMicrosoftOAuthConfig(next); // throws on invalid values
  await saveMicrosoftOAuthConfig(oauthConfigPath, normalized);
  if (runtime !== undefined) {
    await runtime.setMicrosoftCalendarConnection(await createMicrosoftCalendarConnection());
  }
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
  void runtime?.close();
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
