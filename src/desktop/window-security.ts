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

export function isAuthorizedRendererNavigation(url: string, rendererUrl: string): boolean {
  return url === rendererUrl;
}

export function denyWindowOpen(): { action: "deny" } {
  return { action: "deny" };
}
