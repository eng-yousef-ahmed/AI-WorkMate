import { randomUUID } from "node:crypto";

import type {
  BeginCalendarSignInResult,
  CalendarConnectionSignInState,
  CalendarConnectionStatus,
  CompleteCalendarSignInInput,
} from "../../calendar/CalendarConnection";
import { CalendarConnectionError } from "../../calendar/CalendarConnection";
import type { CalendarDeltaProvider, CalendarEventProvider } from "../../calendar/CalendarModels";
import type { CredentialStore } from "../../security/CredentialStore";
import type { GoogleOAuthApplicationConfig } from "./GoogleOAuthConfig";
import { GoogleOAuthConfigurationError, googleClientId, googleRedirectUri, isAllowedGoogleRedirectUri } from "./GoogleOAuthConfig";
import type { GoogleGraphAuthProvider } from "./GoogleAuth";
import { GOOGLE_CALENDAR_SCOPES } from "./GoogleAuth";
import { GoogleCalendarDeltaProvider } from "./GoogleCalendarDeltaProvider";
import { GoogleCalendarProvider } from "./GoogleCalendarProvider";
import { GoogleApiClient, type GoogleApiTransport } from "./GoogleApiClient";
import { GoogleOAuthClient, GoogleOAuthError } from "./GoogleOAuthClient";
import { GoogleTokenSessionStore, type GoogleOAuthSession } from "./GoogleTokenSessionStore";
import { GoogleGraphAuthenticator } from "./GoogleGraphAuthenticator";
import { decodeGoogleIdTokenPayload } from "./GoogleIdentity";
import { createPkceChallenge, createOAuthState, createVerifier } from "../oauth/Pkce";
import { startLoopbackCallbackServer, type LoopbackCallbackServer, type LoopbackListener } from "../oauth/LoopbackOAuthCallbackServer";
import type { OAuthFormTransport } from "../oauth/OAuthFormTransport";

/**
 * Main-process Google Calendar connection: OAuth Authorization Code + PKCE
 * with a desktop (installed-app) client. Google's client secret is optional
 * and treated as non-confidential (RFC 8252); the PKCE verifier is the real
 * protection and lives only in main-process memory during a pending flow.
 * Owns the pending sign-in flow, the localhost callback listener, token
 * exchange/refresh, account identity (from the id_token), disconnect, and
 * the authenticated Calendar provider factory.
 */

export interface GoogleCalendarConnectionOptions {
  config: GoogleOAuthApplicationConfig;
  credentialStore: CredentialStore;
  clock?: () => Date;
  oauthTransport?: OAuthFormTransport;
  apiTransport?: GoogleApiTransport;
  /** Milliseconds the sign-in flow stays valid; default 5 minutes. */
  signInTimeoutMs?: number;
  /** Injectable loopback listener factory (tests avoid real sockets). */
  loopbackListenerFactory?: (handle: (request: {
    url: string;
    host?: string;
    method?: string;
  }) => { status: number; html?: string }) => Promise<LoopbackListener>;
  /** Auth provider factory override (tests inject fake tokens). */
  authProviderFactory?: (authenticator: GoogleGraphAuthenticator) => GoogleGraphAuthProvider;
}

interface PendingGoogleSignIn {
  flowId: string;
  state: string;
  verifier: string;
  /** The exact redirect URI used in the authorization URL. */
  redirectUri: string;
  startedAt: string;
  expiresAt: string;
  server?: LoopbackCallbackServer;
  failure?: { code: string; message: string };
}

export class GoogleCalendarConnection {
  private readonly clock: () => Date;
  private readonly oauthClient: GoogleOAuthClient;
  private readonly sessionStore: GoogleTokenSessionStore;
  private readonly signInTimeoutMs: number;
  private readonly apiTransport: GoogleApiTransport | undefined;
  private readonly authProviderFactory:
    | ((authenticator: GoogleGraphAuthenticator) => GoogleGraphAuthProvider)
    | undefined;
  private readonly loopbackListenerFactory:
    | ((handle: (request: { url: string; host?: string; method?: string }) => { status: number; html?: string }) => Promise<LoopbackListener>)
    | undefined;
  private pending: PendingGoogleSignIn | undefined;
  private cachedAuthenticator: GoogleGraphAuthenticator | undefined;

  public constructor(private readonly options: GoogleCalendarConnectionOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.oauthClient = new GoogleOAuthClient(options.config, {
      transport: options.oauthTransport,
      clock: this.clock,
    });
    this.sessionStore = new GoogleTokenSessionStore(options.credentialStore, undefined, this.clock);
    this.signInTimeoutMs = options.signInTimeoutMs ?? 5 * 60 * 1000;
    this.apiTransport = options.apiTransport;
    this.authProviderFactory = options.authProviderFactory;
    this.loopbackListenerFactory = options.loopbackListenerFactory;
  }

  /** Sanitized connection state for renderer display. Never contains tokens. */
  public async getStatus(): Promise<CalendarConnectionStatus> {
    const clientId = this.options.config.clientId?.trim();
    if (clientId === undefined || clientId.length === 0) {
      return {
        provider: "GOOGLE_CALENDAR",
        state: "NOT_CONFIGURED",
        notConfiguredReason: "GOOGLE_CLIENT_NOT_CONFIGURED",
      };
    }
    const session = await this.sessionStore.snapshot();
    const signIn = this.pendingSignInState();
    const status: CalendarConnectionStatus = {
      provider: "GOOGLE_CALENDAR",
      state: session.connected ? "CONNECTED" : "DISCONNECTED",
    };
    if (session.account !== undefined) {
      const account: CalendarConnectionStatus["account"] = { accountId: session.account.accountId };
      if (session.account.displayName !== undefined) account.displayName = session.account.displayName;
      if (session.account.email !== undefined) account.email = session.account.email;
      status.account = account;
    }
    if (session.accessTokenExpiresAt !== undefined) {
      status.accessTokenExpiresAt = session.accessTokenExpiresAt;
    }
    if (signIn !== undefined) {
      status.signIn = signIn;
    }
    return status;
  }

  public async beginSignIn(): Promise<BeginCalendarSignInResult> {
    try {
      googleClientId(this.options.config); // fail fast with a clear error
    } catch (error: unknown) {
      throw asConnectionError(error);
    }
    const explicitRedirect = googleRedirectUri(this.options.config);
    if (!isAllowedGoogleRedirectUri(explicitRedirect)) {
      throw new CalendarConnectionError(
        "GOOGLE_OAUTH_INVALID_REDIRECT_URI",
        "The configured Google redirect URI must be the loopback URI http://localhost or http://127.0.0.1 (with or without a port).",
        false,
      );
    }
    await this.clearPending();
    const now = this.clock();
    const flowId = randomUUID();
    const state = createOAuthState();
    const verifier = createVerifier();
    const challenge = createPkceChallenge(verifier);
    const expiresAt = new Date(now.getTime() + this.signInTimeoutMs).toISOString();

    let redirectUri = explicitRedirect;
    let server: LoopbackCallbackServer | undefined;
    const fixedPort = parseLoopbackPort(explicitRedirect);
    if (isPortlessLoopbackRedirect(explicitRedirect) || fixedPort !== undefined) {
      server = await startLoopbackCallbackServer({
        timeoutMs: this.signInTimeoutMs,
        port: fixedPort,
        listenerFactory: this.loopbackListenerFactory,
      });
      redirectUri = server.redirectUri;
    }

    const pending: PendingGoogleSignIn = {
      flowId,
      state,
      verifier,
      redirectUri,
      startedAt: now.toISOString(),
      expiresAt,
      server,
    };
    this.pending = pending;

    const authorizationUrl = this.oauthClient.buildAuthorizationUrl({
      state,
      codeChallenge: challenge,
      redirectUri,
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      accessType: "offline",
      prompt: "select_account",
    });

    if (server !== undefined) {
      void server.callback.then(
        (callback) => {
          // Auto-captured callback; errors are recorded on the pending flow
          // and surfaced through getStatus() for the renderer.
          void this.completeSignIn({ flowId, redirectUrl: callback.redirectUrl }).catch(() => undefined);
        },
        () => {
          // Timeout/cancel while still pending: keep the record so status can
          // explain why the sign-in did not finish.
          if (this.pending?.flowId === flowId && this.pending.failure === undefined) {
            this.pending.failure = {
              code: "GOOGLE_SIGNIN_EXPIRED",
              message: "The sign-in window expired. Please start again.",
            };
          }
        },
      );
    }

    return {
      flowId,
      provider: "GOOGLE_CALENDAR",
      authorizationUrl,
      redirectUri,
      startedAt: pending.startedAt,
      expiresAt: pending.expiresAt,
      autoCapture: server !== undefined,
    };
  }

  /**
   * Finishes a sign-in with the browser redirect URL (loopback capture or a
   * manually pasted address). Validates state, exchanges the code with the
   * PKCE verifier, persists the session in the encrypted vault, and records
   * the account identity from the id_token.
   */
  public async completeSignIn(input: CompleteCalendarSignInInput): Promise<CalendarConnectionStatus> {
    const pending = this.requirePending(input.flowId);
    const now = this.clock();
    if (new Date(pending.expiresAt).getTime() < now.getTime()) {
      await this.clearPending();
      throw new CalendarConnectionError("GOOGLE_SIGNIN_EXPIRED", "The sign-in window expired. Please start again.", false);
    }
    const parsed = parseCallbackUrl(input.redirectUrl);
    const validationError = validateCallback(parsed, pending.state);
    if (validationError !== undefined) {
      await this.failPending(validationError);
      throw validationError;
    }
    const code = parsed.code as string;
    try {
      const granted = await this.oauthClient.exchangeCodeForToken({
        code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      });
      if (granted.refreshToken === undefined || granted.refreshToken.length === 0) {
        const error = new CalendarConnectionError(
          "GOOGLE_SIGNIN_NO_REFRESH_TOKEN",
          "Google did not grant offline access, so the calendar cannot refresh itself. Please sign in again and consent.",
          false,
        );
        await this.failPending(error);
        throw error;
      }
      const session: GoogleOAuthSession = {
        accessToken: granted.accessToken,
        refreshToken: granted.refreshToken,
        accessTokenExpiresAt: granted.accessTokenExpiresAt,
        scope: granted.scope,
        updatedAt: this.clock().toISOString(),
      };
      const identity = decodeGoogleIdTokenPayload(granted.idToken ?? "");
      if (identity !== undefined) {
        session.account = identity;
      }
      await this.sessionStore.write(session);
      await this.clearPending();
      return this.getStatus();
    } catch (error: unknown) {
      if (error instanceof CalendarConnectionError) {
        throw error;
      }
      if (error instanceof GoogleOAuthError) {
        const wrapped = new CalendarConnectionError(
          "GOOGLE_SIGNIN_EXCHANGE_FAILED",
          `The Google sign-in could not be completed (${error.code}).`,
          error.retryable,
        );
        await this.failPending(wrapped);
        throw wrapped;
      }
      throw error;
    }
  }

  /** Cancels any in-progress sign-in (browser flow stays open but dies there). */
  public async cancelSignIn(): Promise<void> {
    await this.clearPending();
  }

  /** Removes the session and any pending flow. */
  public async disconnect(): Promise<CalendarConnectionStatus> {
    await this.clearPending();
    await this.sessionStore.clear();
    return this.getStatus();
  }

  /**
   * Builds an authenticated, delta-capable Google Calendar provider facade
   * (fails closed when signed out) for the shared sync coordinator.
   */
  public createCalendarProvider(): CalendarEventProvider & CalendarDeltaProvider {
    const authenticator = this.createAuthenticator();
    const authProvider = this.authProviderFactory !== undefined ? this.authProviderFactory(authenticator) : authenticator;
    const client = new GoogleApiClient(authProvider, this.apiTransport);
    const provider = new GoogleCalendarProvider(client);
    const delta = new GoogleCalendarDeltaProvider(client, provider);
    return {
      listEvents: (request) => provider.listEvents(request),
      getEventById: (request) => provider.getEventById(request),
      getDelta: (request) => delta.getDelta(request),
    };
  }

  public createAuthenticator(): GoogleGraphAuthenticator {
    if (this.cachedAuthenticator === undefined) {
      this.cachedAuthenticator = new GoogleGraphAuthenticator(this.options.config, this.sessionStore, {}, this.oauthClient, this.clock);
    }
    return this.cachedAuthenticator;
  }

  private async clearPending(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.server !== undefined) {
      await pending.server.close().catch(() => undefined);
    }
  }

  private async failPending(error: CalendarConnectionError): Promise<void> {
    if (this.pending !== undefined) {
      this.pending.failure = { code: error.code, message: error.message };
    }
    await this.clearPending();
  }

  private requirePending(flowId: string): PendingGoogleSignIn {
    const pending = this.pending;
    if (pending === undefined || pending.flowId !== flowId) {
      throw new CalendarConnectionError(
        "GOOGLE_SIGNIN_FLOW_NOT_FOUND",
        "This sign-in flow no longer exists. Start a new sign-in.",
        false,
      );
    }
    return pending;
  }

  private pendingSignInState(): CalendarConnectionSignInState | undefined {
    const pending = this.pending;
    if (pending === undefined) {
      return undefined;
    }
    if (pending.failure !== undefined) {
      return {
        state: "FAILED",
        startedAt: pending.startedAt,
        expiresAt: pending.expiresAt,
        error: pending.failure,
      };
    }
    const expired = new Date(pending.expiresAt).getTime() < this.clock().getTime();
    if (expired) {
      return {
        state: "FAILED",
        startedAt: pending.startedAt,
        expiresAt: pending.expiresAt,
        error: { code: "GOOGLE_SIGNIN_EXPIRED", message: "The sign-in window expired. Please start again." },
      };
    }
    return {
      state: "IN_PROGRESS",
      startedAt: pending.startedAt,
      expiresAt: pending.expiresAt,
    };
  }
}

function asConnectionError(error: unknown): CalendarConnectionError {
  if (error instanceof CalendarConnectionError) {
    return error;
  }
  if (error instanceof GoogleOAuthConfigurationError) {
    return new CalendarConnectionError(error.code, error.message, error.retryable);
  }
  if (error instanceof Error) {
    return new CalendarConnectionError("GOOGLE_SIGNIN_UNAVAILABLE", error.message, false);
  }
  return new CalendarConnectionError("GOOGLE_SIGNIN_UNAVAILABLE", "The Google sign-in could not be started.", false);
}

export function parseLoopbackPort(redirectUri: string): number | undefined {
  try {
    const url = new URL(redirectUri);
    if (url.port.length === 0) {
      return undefined;
    }
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function isPortlessLoopbackRedirect(redirectUri: string): boolean {
  return redirectUri === "http://localhost" || redirectUri === "http://127.0.0.1";
}

export function parseCallbackUrl(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  try {
    const url = new URL(value);
    for (const [key, entry] of url.searchParams.entries()) {
      if (!(key in output)) {
        output[key] = entry;
      }
    }
    if (url.hash.length > 1) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      for (const [key, entry] of fragment.entries()) {
        if (!(key in output)) {
          output[key] = entry;
        }
      }
    }
  } catch {
    const question = value.indexOf("?");
    const query = question === -1 ? value : value.slice(question + 1);
    const params = new URLSearchParams(query);
    for (const [key, entry] of params.entries()) {
      if (!(key in output)) {
        output[key] = entry;
      }
    }
  }
  return output;
}

export function validateCallback(
  parsed: Record<string, string>,
  expectedState: string,
): CalendarConnectionError | undefined {
  const error = parsed.error;
  if (error !== undefined) {
    return new CalendarConnectionError(
      "GOOGLE_SIGNIN_DENIED",
      `Google did not authorize the calendar access (${error}).`,
      false,
    );
  }
  const code = parsed.code;
  const state = parsed.state;
  if (code === undefined || state === undefined) {
    return new CalendarConnectionError(
      "GOOGLE_SIGNIN_INVALID_CALLBACK",
      "The sign-in callback is missing the authorization code or state.",
      false,
    );
  }
  if (!secureCompare(state, expectedState)) {
    return new CalendarConnectionError(
      "GOOGLE_SIGNIN_STATE_MISMATCH",
      "The sign-in callback state did not match. The sign-in was cancelled for your security.",
      false,
    );
  }
  return undefined;
}

function secureCompare(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}
