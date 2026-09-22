/**
 * Least-privilege delegated scopes for the Google Calendar integration.
 * `openid`/`profile`/`email` identify the signed-in Google account so the
 * account picker and identity display work; the calendar scope is read-only.
 * No write, no contacts, no drive, no mail.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GOOGLE_CREDENTIAL_SERVICE = "google-calendar";
export const GOOGLE_TOKEN_CACHE_ACCOUNT = "google-token-session";

export const GOOGLE_CALENDAR_ID_PRIMARY = "primary";

export interface GoogleAccessToken {
  accessToken: string;
  expiresAt?: string;
  scopes: readonly string[];
}

export interface GoogleAuthRequest {
  scopes: readonly string[];
  signal?: AbortSignal;
}

export interface GoogleGraphAuthProvider {
  getAccessToken(request: GoogleAuthRequest): Promise<GoogleAccessToken>;
}

/**
 * Fail-closed auth boundary used until a real Google OAuth session provides
 * an auth provider. It never fabricates tokens and never reads DATA_ROOT.
 */
export class GoogleAuthenticationRequiredProvider implements GoogleGraphAuthProvider {
  public async getAccessToken(_request: GoogleAuthRequest): Promise<GoogleAccessToken> {
    throw new GoogleAuthError(
      "GOOGLE_AUTHENTICATION_REQUIRED",
      "Google authentication is required before calendar synchronization can contact the Google Calendar API.",
      false,
    );
  }
}

export class GoogleAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}
