import type { GoogleOAuthApplicationConfig } from "./GoogleOAuthConfig";
import { googleRedirectUri } from "./GoogleOAuthConfig";
import { GOOGLE_CALENDAR_SCOPES, GoogleAuthError, type GoogleAccessToken, type GoogleAuthRequest, type GoogleGraphAuthProvider } from "./GoogleAuth";
import { GoogleOAuthClient, GoogleOAuthError, isFatalGoogleRefreshError, type GoogleGrantedToken } from "./GoogleOAuthClient";
import type { GoogleOAuthSession, GoogleTokenSessionStore } from "./GoogleTokenSessionStore";

/**
 * Production {@link GoogleGraphAuthProvider}: serves access tokens from the
 * secure session store, refreshing through the Google token endpoint just
 * before expiry. Refresh is single-flight so concurrent Calendar API calls
 * share one token refresh. Fatal refresh failures (revoked/expired refresh
 * token) clear the session and fail closed with
 * GOOGLE_AUTHENTICATION_REQUIRED — never a silent re-prompt and never a
 * fabricated token.
 */

export interface GoogleGraphAuthenticatorOptions {
  /** Seconds before expiry at which a refresh is triggered. */
  refreshMarginSeconds?: number;
}

const DEFAULT_REFRESH_MARGIN_SECONDS = 5 * 60;

export class GoogleGraphAuthenticator implements GoogleGraphAuthProvider {
  private readonly oauthClient: GoogleOAuthClient;
  private readonly refreshMarginSeconds: number;
  private readonly clock: () => Date;
  private refreshInFlight: Promise<GoogleGrantedToken> | undefined;

  public constructor(
    private readonly config: GoogleOAuthApplicationConfig,
    private readonly sessionStore: GoogleTokenSessionStore,
    options: GoogleGraphAuthenticatorOptions = {},
    oauthClient?: GoogleOAuthClient,
    clock: () => Date = () => new Date(),
  ) {
    this.oauthClient = oauthClient ?? new GoogleOAuthClient(config);
    this.refreshMarginSeconds = options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    this.clock = clock;
  }

  public async getAccessToken(_request: GoogleAuthRequest): Promise<GoogleAccessToken> {
    let session: GoogleOAuthSession | null;
    try {
      session = await this.sessionStore.read();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "GoogleSessionCorruptError") {
        throw new GoogleAuthError("GOOGLE_AUTHENTICATION_REQUIRED", "The stored Google Calendar sign-in was invalid. Please sign in again.", false);
      }
      throw error;
    }
    if (session === null) {
      throw new GoogleAuthError(
        "GOOGLE_AUTHENTICATION_REQUIRED",
        "Google authentication is required before calendar synchronization can contact the Google Calendar API.",
        false,
      );
    }
    if (!this.needsRefresh(session)) {
      return {
        accessToken: session.accessToken,
        expiresAt: session.accessTokenExpiresAt,
        scopes: GOOGLE_CALENDAR_SCOPES,
      };
    }
    const granted = await this.refreshSingleFlight(session);
    return {
      accessToken: granted.accessToken,
      expiresAt: granted.accessTokenExpiresAt,
      scopes: GOOGLE_CALENDAR_SCOPES,
    };
  }

  /** Refreshes now (outside the single-flight lock) — used by connection status. */
  public async forceRefresh(): Promise<GoogleGrantedToken> {
    const session = await this.sessionStore.read();
    if (session === null) {
      throw new GoogleAuthError("GOOGLE_AUTHENTICATION_REQUIRED", "There is no Google Calendar sign-in to refresh.", false);
    }
    return this.refreshSingleFlight(session);
  }

  private needsRefresh(session: GoogleOAuthSession): boolean {
    const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
    if (Number.isNaN(expiresAt)) {
      return true;
    }
    return expiresAt <= this.clock().getTime() + this.refreshMarginSeconds * 1000;
  }

  private async refreshSingleFlight(session: GoogleOAuthSession): Promise<GoogleGrantedToken> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }
    const attempt = this.doRefresh(session).finally(() => {
      this.refreshInFlight = undefined;
    });
    this.refreshInFlight = attempt;
    return attempt;
  }

  private async doRefresh(session: GoogleOAuthSession): Promise<GoogleGrantedToken> {
    let granted: GoogleGrantedToken;
    try {
      granted = await this.oauthClient.refreshAccessToken({
        refreshToken: session.refreshToken,
        redirectUri: googleRedirectUri(this.config),
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      });
    } catch (error: unknown) {
      if (!(error instanceof GoogleOAuthError)) {
        throw error;
      }
      if (isFatalGoogleRefreshError(error)) {
        // The refresh token is dead; stop trying and fail closed.
        await this.sessionStore.clear().catch(() => undefined);
        throw new GoogleAuthError(
          "GOOGLE_AUTHENTICATION_REQUIRED",
          "The Google Calendar sign-in expired. Please sign in again.",
          false,
        );
      }
      throw error;
    }
    if (granted.refreshToken === undefined || granted.refreshToken.length === 0) {
      // Google keeps returning the same refresh token on refreshes; when it
      // stops, preserve the existing one rather than losing offline access.
      granted = { ...granted, refreshToken: session.refreshToken };
    }
    await this.sessionStore.write({
      accessToken: granted.accessToken,
      refreshToken: granted.refreshToken as string,
      accessTokenExpiresAt: granted.accessTokenExpiresAt,
      scope: granted.scope ?? session.scope,
      account: session.account,
      updatedAt: this.clock().toISOString(),
    });
    return granted;
  }
}
