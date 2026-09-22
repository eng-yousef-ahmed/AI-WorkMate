export interface SecureRendererPreferences {
  preload: string;
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  webviewTag: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
}

export function createSecureRendererPreferences(preload: string): SecureRendererPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

/**
 * True when `actual` and `expected` name the same local renderer file.
 *
 * Packaged Windows builds often disagree on drive-letter case (`C:` vs `c:`),
 * percent-encoding (`Program%20Files`), and `localhost` vs empty host, so a
 * raw string compare of `pathToFileURL` vs `senderFrame.url` rejects the real
 * window. Remote (`https:`) and other files stay rejected.
 */
export function rendererUrlsEquivalent(actual: string, expected: string): boolean {
  if (actual === expected) {
    return true;
  }
  const left = normalizeRendererFileUrl(actual);
  const right = normalizeRendererFileUrl(expected);
  return left !== undefined && right !== undefined && left === right;
}

export function isAuthorizedRendererNavigation(url: string, rendererUrl: string): boolean {
  return rendererUrlsEquivalent(url, rendererUrl);
}

function normalizeRendererFileUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    const host = parsed.hostname === "localhost" ? "" : parsed.hostname.toLowerCase();
    const path = decodeURIComponent(parsed.pathname).replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
    return `file://${host}${path}`;
  } catch {
    return undefined;
  }
}

export function denyWindowOpen(): { action: "deny" } {
  return { action: "deny" };
}

/**
 * Minimal history-navigation surface of `WebContents` (structural so tests
 * can substitute a fake). Sidebar hash links push real Chromium history
 * entries and the renderer syncs via the existing `hashchange`/`popstate`
 * listeners — Electron just provides no default Back/Forward to drive that
 * stack on Windows (Alt+Left/Right, mouse Back/Forward buttons).
 */
export interface WorkspaceHistoryNavigator {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

/**
 * Drives the SAME Chromium history stack for Windows `app-command`
 * (`browser-backward`/`browser-forward`, from mouse buttons and some
 * keyboard chords). Returns true when a navigation was performed and the
 * caller must `preventDefault()` the event. Never navigates when there is
 * no history entry, and never introduces a second navigation system: the
 * renderer keeps syncing via `hashchange`/`popstate`.
 */
export function handleWorkspaceAppCommand(command: string, navigator: WorkspaceHistoryNavigator): boolean {
  if (command === "browser-backward") {
    if (!navigator.canGoBack()) {
      return false;
    }
    navigator.goBack();
    return true;
  }
  if (command === "browser-forward") {
    if (!navigator.canGoForward()) {
      return false;
    }
    navigator.goForward();
    return true;
  }
  return false;
}

/** Subset of Electron's `Input` needed for Alt+Arrow history chords. */
export interface WorkspaceKeyInput {
  type: string;
  key: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
}

/**
 * Drives the SAME Chromium history stack for Windows Alt+Left (Back) and
 * Alt+Right (Forward). Returns true when a navigation was performed and the
 * caller must `preventDefault()` the `before-input-event`. Ctrl/Meta
 * combinations and non-arrow keys are never claimed.
 */
export function handleWorkspaceAltArrow(input: WorkspaceKeyInput, navigator: WorkspaceHistoryNavigator): boolean {
  if (input.type !== "keyDown" || !input.alt || input.control || input.meta) {
    return false;
  }
  if (input.key === "ArrowLeft") {
    if (!navigator.canGoBack()) {
      return false;
    }
    navigator.goBack();
    return true;
  }
  if (input.key === "ArrowRight") {
    if (!navigator.canGoForward()) {
      return false;
    }
    navigator.goForward();
    return true;
  }
  return false;
}
