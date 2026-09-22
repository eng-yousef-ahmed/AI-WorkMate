/**
 * Application registration configuration for the Microsoft 365 calendar
 * integration. This file carries NO secrets: the app is a public desktop
 * client (Authorization Code + PKCE, no client secret). It is stored under
 * the Electron userData directory (outside DATA_ROOT) and is only edited by
 * the end user who owns the Azure app registration.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MicrosoftOAuthApplicationConfig {
  /** "common", "organizations", "consumers", a tenant GUID, or a verified domain. */
  tenant?: string;
  /** Application (client) ID of the public Azure AD app registration. */
  clientId?: string;
  /**
   * Loopback redirect URI. Defaults to the Azure special value
   * `http://localhost` (Azure accepts any port for it); an explicit
   * `http://localhost:<port>`/127.0.0.1 URI may be supplied for
   * registrations that pinned a port.
   */
  redirectUri?: string;
}

export const MICROSOFT_DEFAULT_TENANT = "common";
export const MICROSOFT_LOOPBACK_REDIRECT_URI = "http://localhost";

export function normalizeMicrosoftOAuthConfig(
  raw: Partial<MicrosoftOAuthApplicationConfig> | undefined,
): MicrosoftOAuthApplicationConfig {
  const config = raw ?? {};
  const tenant = config.tenant === undefined ? undefined : config.tenant.trim();
  const clientId = config.clientId === undefined ? undefined : config.clientId.trim();
  const redirectUri = config.redirectUri === undefined ? undefined : config.redirectUri.trim();
  const normalized: MicrosoftOAuthApplicationConfig = {};
  if (tenant !== undefined && tenant.length > 0) {
    if (!isValidMicrosoftTenant(tenant)) {
      throw new MicrosoftOAuthConfigurationError(
        "MICROSOFT_OAUTH_INVALID_TENANT",
        "The Microsoft tenant must be 'common', 'organizations', 'consumers', a tenant GUID, or a verified domain name.",
      );
    }
    normalized.tenant = tenant;
  }
  if (clientId !== undefined && clientId.length > 0) {
    if (!isValidMicrosoftClientId(clientId)) {
      throw new MicrosoftOAuthConfigurationError(
        "MICROSOFT_OAUTH_INVALID_CLIENT_ID",
        "The Microsoft application (client) ID must be a non-empty string without spaces.",
      );
    }
    normalized.clientId = clientId;
  }
  if (redirectUri !== undefined && redirectUri.length > 0) {
    if (!isAllowedMicrosoftRedirectUri(redirectUri)) {
      throw new MicrosoftOAuthConfigurationError(
        "MICROSOFT_OAUTH_INVALID_REDIRECT_URI",
        "The Microsoft redirect URI must be the loopback URI http://localhost (with or without a port).",
      );
    }
    normalized.redirectUri = redirectUri;
  }
  return normalized;
}

export function microsoftTenant(config: MicrosoftOAuthApplicationConfig): string {
  return config.tenant ?? MICROSOFT_DEFAULT_TENANT;
}

export function microsoftClientId(config: MicrosoftOAuthApplicationConfig): string {
  if (config.clientId === undefined || config.clientId.length === 0) {
    throw new MicrosoftOAuthConfigurationError(
      "MICROSOFT_CLIENT_NOT_CONFIGURED",
      "A Microsoft application (client) ID is required. Register a public desktop app in Azure and enter its client ID in Settings.",
      false,
    );
  }
  return config.clientId;
}

export function microsoftRedirectUri(config: MicrosoftOAuthApplicationConfig): string {
  const explicit = config.redirectUri?.trim();
  if (explicit === undefined || explicit.length === 0) {
    return MICROSOFT_LOOPBACK_REDIRECT_URI;
  }
  return explicit;
}

export function isValidMicrosoftTenant(value: string): boolean {
  if (value === "common" || value === "organizations" || value === "consumers") {
    return true;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value) ||
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(value);
}

export function isValidMicrosoftClientId(value: string): boolean {
  return value.length <= 120 && !/\s/.test(value);
}

/** Only loopback http URIs are accepted; nothing else may receive auth codes. */
export function isAllowedMicrosoftRedirectUri(value: string): boolean {
  if (value === MICROSOFT_LOOPBACK_REDIRECT_URI) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      !url.username && !url.password &&
      (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}

export class MicrosoftOAuthConfigurationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MicrosoftOAuthConfigurationError";
  }
}

/** Loads the user-edited OAuth config JSON from the Electron userData area. */
export async function loadMicrosoftOAuthConfig(filePath: string): Promise<MicrosoftOAuthApplicationConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new MicrosoftOAuthConfigurationError(
      "MICROSOFT_OAUTH_CONFIG_CORRUPT",
      "The Microsoft OAuth configuration file contains invalid JSON. Fix or delete the file and restart.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MicrosoftOAuthConfigurationError(
      "MICROSOFT_OAUTH_CONFIG_CORRUPT",
      "The Microsoft OAuth configuration file must contain a JSON object.",
    );
  }
  return normalizeMicrosoftOAuthConfig(parsed as Partial<MicrosoftOAuthApplicationConfig>);
}

/** Persists the user-edited OAuth config JSON (atomic, no secrets involved). */
export async function saveMicrosoftOAuthConfig(filePath: string, config: MicrosoftOAuthApplicationConfig): Promise<void> {
  const normalized = normalizeMicrosoftOAuthConfig(config);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.microsoft-oauth-config.tmp-${randomUUID()}`);
  await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
