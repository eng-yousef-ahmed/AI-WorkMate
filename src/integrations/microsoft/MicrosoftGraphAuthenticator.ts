import type { MicrosoftOAuthApplicationConfig } from "./MicrosoftOAuthConfig";
import { microsoftRedirectUri } from "./MicrosoftOAuthConfig";
import { MICROSOFT_GRAPH_SCOPES, MicrosoftGraphAuthError, type MicrosoftAccessToken, type MicrosoftAuthRequest, type MicrosoftGraphAuthProvider } from "./MicrosoftAuth";
import { isFatalMicrosoftRefreshError, MicrosoftOAuthClient, MicrosoftOAuthError, type MicrosoftGrantedToken } from "./MicrosoftOAuthClient";
import type { MicrosoftOAuthSession, MicrosoftTokenSessionStore } from "./MicrosoftTokenSessionStore";

/**
 * Production {@link MicrosoftGraphAuthProvider}: serves access tokens from the
 * secure session store, refreshing through the public-client PKCE token
 * endpoint just before expiry. Refresh is single-flight so concurrent Graph
 * calls share one token refresh. Fatal refresh failures (revoked/expired
 * refresh token) clear the session and fail closed with
 * MICROSOFT_AUTHENTICATION_REQUIRED — never a silent re-prompt and never a
 * fabricated token.
 */

export interface MicrosoftGraphAuthenticatorOptions {
  /** Seconds before expiry at which a refresh is triggered. */
  refreshMarginSeconds?: number;
}

const DEFAULT_REFRESH_MARGIN_SECONDS = 5 * 60;

export class MicrosoftGraphAuthenticator implements MicrosoftGraphAuthProvider {
  private readonly oauthClient: MicrosoftOAuthClient;
  private readonly refreshMarginSeconds: number;
  private readonly clock: () => Date;
  private refreshInFlight: Promise<MicrosoftGrantedToken> | undefined;

  public constructor(
    private readonly config: MicrosoftOAuthApplicationConfig,
    private readonly sessionStore: MicrosoftTokenSessionStore,
    options: MicrosoftGraphAuthenticatorOptions = {},
    oauthClient?: MicrosoftOAuthClient,
    clock: () => Date = () => new Date(),
  ) {
    this.oauthClient = oauthClient ?? new MicrosoftOAuthClient(config);
    this.refreshMarginSeconds = options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    this.clock = clock;
  }

  public async getAccessToken(_request: MicrosoftAuthRequest): Promise<MicrosoftAccessToken> {
    let session: MicrosoftOAuthSession | null;
    try {
      session = await this.sessionStore.read();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "MicrosoftSessionCorruptError") {
        throw new MicrosoftGraphAuthError("MICROSOFT_AUTHENTICATION_REQUIRED", "The stored Microsoft 365 sign-in was invalid. Please sign in again.", false);
      }
      throw error;
    }
    if (session === null) {
      throw new MicrosoftGraphAuthError(
        "MICROSOFT_AUTHENTICATION_REQUIRED",
        "Microsoft 365 authentication is required before calendar synchronization can contact Microsoft Graph.",
        false,
      );
    }
    if (!this.needsRefresh(session)) {
      return {
        accessToken: session.accessToken,
        expiresAt: session.accessTokenExpiresAt,
        scopes: MICROSOFT_GRAPH_SCOPES,
      };
    }
    const granted = await this.refreshSingleFlight(session);
    return {
      accessToken: granted.accessToken,
      expiresAt: granted.accessTokenExpiresAt,
      scopes: MICROSOFT_GRAPH_SCOPES,
    };
  }

  /** Refreshes now (outside the single-flight lock) — used by connection status. */
  public async forceRefresh(): Promise<MicrosoftGrantedToken> {
    const session = await this.sessionStore.read();
    if (session === null) {
      throw new MicrosoftGraphAuthError("MICROSOFT_AUTHENTICATION_REQUIRED", "There is no Microsoft 365 sign-in to refresh.", false);
    }
    return this.refreshSingleFlight(session);
  }

  private refreshSingleFlight(session: MicrosoftOAuthSession): Promise<MicrosoftGrantedToken> {
    if (this.refreshInFlight === undefined) {
      this.refreshInFlight = this.doRefresh(session).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(session: MicrosoftOAuthSession): Promise<MicrosoftGrantedToken> {
    try {
      const granted = await this.oauthClient.refreshAccessToken({
        refreshToken: session.refreshToken,
        redirectUri: microsoftRedirectUri(this.config),
        scope: MICROSOFT_GRAPH_SCOPES.join(" "),
      });
      const updated: MicrosoftOAuthSession = {
        accessToken: granted.accessToken,
        refreshToken: granted.refreshToken ?? session.refreshToken,
        accessTokenExpiresAt: granted.accessTokenExpiresAt,
        scope: granted.scope ?? session.scope,
        updatedAt: this.clock().toISOString(),
      };
      if (session.account !== undefined) {
        updated.account = session.account;
      }
      await this.sessionStore.write(updated);
      return granted;
    } catch (error: unknown) {
      if (error instanceof MicrosoftOAuthError) {
        if (isFatalMicrosoftRefreshError(error)) {
          await this.sessionStore.clear();
          throw new MicrosoftGraphAuthError(
            "MICROSOFT_AUTHENTICATION_REQUIRED",
            "The Microsoft 365 sign-in has expired or was revoked. Please sign in again.",
            false,
          );
        }
        throw new MicrosoftGraphAuthError(
          "MICROSOFT_TOKEN_REFRESH_FAILED",
          "The Microsoft 365 token could not be refreshed. The calendar will retry later.",
          error.retryable,
        );
      }
      throw error;
    }
  }

  private needsRefresh(session: MicrosoftOAuthSession): boolean {
    const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
    if (Number.isNaN(expiresAt)) {
      return true;
    }
    return this.clock().getTime() >= expiresAt - this.refreshMarginSeconds * 1000;
  }
}
