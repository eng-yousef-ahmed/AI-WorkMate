import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Application registration configuration for the Google Calendar
 * integration. Google issues a client secret even for desktop clients, but
 * for this Authorization Code + PKCE public-client flow the secret is treated
 * as non-confidential (per RFC 8252 §8.4 the secret of an installed app is
 * not a secret) and is never required. The config file lives under the
 * Electron userData directory (outside DATA_ROOT) and is edited only by the
 * end user who owns the Google Cloud OAuth client.
 */

export interface GoogleOAuthApplicationConfig {
  /** OAuth 2.0 client ID, e.g. "...apps.googleusercontent.com". */
  clientId?: string;
  /** (Optional) Google Cloud OAuth client secret. PKCE makes it unnecessary. */
  clientSecret?: string;
  /**
   * Loopback redirect URI. Defaults to `http://127.0.0.1` (Google accepts
   * any localhost/127.0.0.1 port for desktop clients); an explicit
   * `http://localhost:<port>` or `http://127.0.0.1:<port>` may be supplied.
   */
  redirectUri?: string;
}

export const GOOGLE_DEFAULT_TENANT = undefined; // personal Google accounts
export const GOOGLE_LOOPBACK_REDIRECT_URI = "http://127.0.0.1";
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_AUDIENCE = "accounts.google.com";

export class GoogleOAuthConfigurationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "GoogleOAuthConfigurationError";
  }
}

export function normalizeGoogleOAuthConfig(raw: Partial<GoogleOAuthApplicationConfig> | undefined): GoogleOAuthApplicationConfig {
  const config = raw ?? {};
  const clientId = config.clientId === undefined ? undefined : config.clientId.trim();
  const clientSecret = config.clientSecret === undefined ? undefined : config.clientSecret.trim();
  const redirectUri = config.redirectUri === undefined ? undefined : config.redirectUri.trim();
  const normalized: GoogleOAuthApplicationConfig = {};
  if (clientId !== undefined && clientId.length > 0) {
    if (!isValidGoogleClientId(clientId)) {
      throw new GoogleOAuthConfigurationError(
        "GOOGLE_OAUTH_INVALID_CLIENT_ID",
        "The Google OAuth client ID must end in '.apps.googleusercontent.com' and contain no spaces.",
      );
    }
    normalized.clientId = clientId;
  }
  if (clientSecret !== undefined && clientSecret.length > 0) {
    if (!/^\S+$/.test(clientSecret) || clientSecret.length > 256) {
      throw new GoogleOAuthConfigurationError(
        "GOOGLE_OAUTH_INVALID_CLIENT_SECRET",
        "The Google OAuth client secret must be a non-empty string without spaces.",
      );
    }
    normalized.clientSecret = clientSecret;
  }
  if (redirectUri !== undefined && redirectUri.length > 0) {
    if (!isAllowedGoogleRedirectUri(redirectUri)) {
      throw new GoogleOAuthConfigurationError(
        "GOOGLE_OAUTH_INVALID_REDIRECT_URI",
        "The Google redirect URI must be a loopback http://localhost or http://127.0.0.1 URI (with or without a port).",
      );
    }
    normalized.redirectUri = redirectUri;
  }
  return normalized;
}

export function googleClientId(config: GoogleOAuthApplicationConfig): string {
  if (config.clientId === undefined || config.clientId.length === 0) {
    throw new GoogleOAuthConfigurationError(
      "GOOGLE_CLIENT_NOT_CONFIGURED",
      "A Google OAuth client ID is required. Create a Desktop OAuth client in Google Cloud Console and enter its client ID in Settings.",
      false,
    );
  }
  return config.clientId;
}

export function googleRedirectUri(config: GoogleOAuthApplicationConfig): string {
  const explicit = config.redirectUri?.trim();
  if (explicit === undefined || explicit.length === 0) {
    return GOOGLE_LOOPBACK_REDIRECT_URI;
  }
  return explicit;
}

export function isValidGoogleClientId(value: string): boolean {
  return value.length <= 200 && !/\s/.test(value) && /\.apps\.googleusercontent\.com$/i.test(value);
}

/** Only loopback http URIs may receive Google auth codes. */
export function isAllowedGoogleRedirectUri(value: string): boolean {
  if (value === "http://localhost" || value === "http://127.0.0.1") {
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

/** Loads the user-edited OAuth config JSON from the Electron userData area. */
export async function loadGoogleOAuthConfig(filePath: string): Promise<GoogleOAuthApplicationConfig> {
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
    throw new GoogleOAuthConfigurationError(
      "GOOGLE_OAUTH_CONFIG_CORRUPT",
      "The Google OAuth configuration file contains invalid JSON. Fix or delete the file and restart.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoogleOAuthConfigurationError(
      "GOOGLE_OAUTH_CONFIG_CORRUPT",
      "The Google OAuth configuration file must contain a JSON object.",
    );
  }
  return normalizeGoogleOAuthConfig(parsed as Partial<GoogleOAuthApplicationConfig>);
}

/** Persists the user-edited OAuth config JSON (atomic; clientSecret is optional and non-confidential). */
export async function saveGoogleOAuthConfig(filePath: string, config: GoogleOAuthApplicationConfig): Promise<void> {
  const normalized = normalizeGoogleOAuthConfig(config);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.google-oauth-config.tmp-${randomUUID()}`);
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
