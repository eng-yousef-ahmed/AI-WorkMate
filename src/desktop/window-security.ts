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
