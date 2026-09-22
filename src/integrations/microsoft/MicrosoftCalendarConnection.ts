import { randomUUID } from "node:crypto";

import type { CalendarEventProvider } from "../../calendar/CalendarModels";
import type {
  BeginCalendarSignInResult,
  CalendarConnectionSignInState,
  CalendarConnectionStatus,
  CompleteCalendarSignInInput,
} from "../../calendar/CalendarConnection";
import { CalendarConnectionError } from "../../calendar/CalendarConnection";
import type { CredentialStore } from "../../security/CredentialStore";
import type { MicrosoftOAuthApplicationConfig } from "./MicrosoftOAuthConfig";
import {
  isAllowedMicrosoftRedirectUri,
  microsoftClientId,
  microsoftRedirectUri,
} from "./MicrosoftOAuthConfig";
import { createPkceChallenge, createOAuthState, createVerifier, secureStringEqual } from "../oauth/Pkce";
import { startLoopbackCallbackServer, type LoopbackCallbackServer, type LoopbackListener, LOOPBACK_CALLBACK_TIMEOUT_MS } from "../oauth/LoopbackOAuthCallbackServer";
import { MICROSOFT_GRAPH_SCOPES } from "./MicrosoftAuth";
import { MicrosoftGraphAuthenticator } from "./MicrosoftGraphAuthenticator";
import { MicrosoftGraphCalendarProvider } from "./MicrosoftGraphCalendarProvider";
import { MicrosoftGraphClient, type MicrosoftGraphTransport } from "./MicrosoftGraphClient";
import { MicrosoftOAuthClient, MicrosoftOAuthError, type MicrosoftOAuthTransport } from "./MicrosoftOAuthClient";
import { MicrosoftTokenSessionStore, type MicrosoftOAuthSession } from "./MicrosoftTokenSessionStore";

/**
 * Main-process Microsoft 365 calendar connection: OAuth Authorization Code +
 * PKCE with a public (secret-less) desktop client. Owns the pending sign-in
 * flow (state + verifier live only in main-process memory), the localhost
 * callback listener, token exchange/refresh, account identity, disconnect,
 * and the authenticated Graph provider factory.
 */

export interface MicrosoftCalendarConnectionOptions {
  config: MicrosoftOAuthApplicationConfig;
  credentialStore: CredentialStore;
  clock?: () => Date;
  oauthTransport?: MicrosoftOAuthTransport;
  graphTransport?: MicrosoftGraphTransport;
  /** Milliseconds the sign-in flow stays valid; default 5 minutes. */
  signInTimeoutMs?: number;
  /** Injectable loopback listener factory (tests avoid real sockets). */
  loopbackListenerFactory?: (handle: (request: {
    url: string;
    host?: string;
    method?: string;
  }) => { status: number; html?: string }) => Promise<LoopbackListener>;
}

interface PendingMicrosoftSignIn {
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

export class MicrosoftCalendarConnection {
  private readonly clock: () => Date;
  private readonly oauthClient: MicrosoftOAuthClient;
  private readonly sessionStore: MicrosoftTokenSessionStore;
  private readonly signInTimeoutMs: number;
  private readonly loopbackListenerFactory:
    | ((handle: (request: { url: string; host?: string; method?: string }) => { status: number; html?: string }) => Promise<LoopbackListener>)
    | undefined;
  private pending: PendingMicrosoftSignIn | undefined;
  private cachedGraphClient: MicrosoftGraphClient | undefined;

  public constructor(private readonly options: MicrosoftCalendarConnectionOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.oauthClient = new MicrosoftOAuthClient(options.config, {
      transport: options.oauthTransport,
      clock: this.clock,
    });
    this.sessionStore = new MicrosoftTokenSessionStore(options.credentialStore, undefined, this.clock);
    this.signInTimeoutMs = options.signInTimeoutMs ?? LOOPBACK_CALLBACK_TIMEOUT_MS;
    this.loopbackListenerFactory = options.loopbackListenerFactory;
  }

  /** Sanitized connection state for renderer display. Never contains tokens. */
  public async getStatus(): Promise<CalendarConnectionStatus> {
    const clientId = this.options.config.clientId?.trim();
    if (clientId === undefined || clientId.length === 0) {
      return {
        provider: "MICROSOFT_GRAPH",
        state: "NOT_CONFIGURED",
        notConfiguredReason: "MICROSOFT_CLIENT_NOT_CONFIGURED",
      };
    }
    const session = await this.sessionStore.snapshot();
    const signIn = this.pendingSignInState();
    const status: CalendarConnectionStatus = {
      provider: "MICROSOFT_GRAPH",
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
      microsoftClientId(this.options.config); // fail fast with a clear error
    } catch (error: unknown) {
      throw asConnectionError(error);
    }
    const explicitRedirect = microsoftRedirectUri(this.options.config);
    if (!isAllowedMicrosoftRedirectUri(explicitRedirect)) {
      throw new CalendarConnectionError(
        "MICROSOFT_OAUTH_INVALID_REDIRECT_URI",
        "The configured Microsoft redirect URI must be the loopback URI http://localhost (with or without a port).",
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
    // An explicit non-loopback URI cannot be auto-captured; the user pastes
    // the browser redirect URL back into the app (manual completion).

    const pending: PendingMicrosoftSignIn = {
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
      scope: MICROSOFT_GRAPH_SCOPES.join(" "),
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
              code: "MICROSOFT_SIGNIN_EXPIRED",
              message: "The sign-in window expired. Please start again.",
            };
          }
        },
      );
    }

    return {
      flowId,
      provider: "MICROSOFT_GRAPH",
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
   * the account identity from Graph /me.
   */
  public async completeSignIn(input: CompleteCalendarSignInInput): Promise<CalendarConnectionStatus> {
    const pending = this.requirePending(input.flowId);
    const now = this.clock();
    if (new Date(pending.expiresAt).getTime() < now.getTime()) {
      await this.clearPending();
      throw new CalendarConnectionError("MICROSOFT_SIGNIN_EXPIRED", "The sign-in window expired. Please start again.", false);
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
        scope: MICROSOFT_GRAPH_SCOPES.join(" "),
      });
      if (granted.refreshToken === undefined || granted.refreshToken.length === 0) {
        const error = new CalendarConnectionError(
          "MICROSOFT_SIGNIN_NO_REFRESH_TOKEN",
          "Microsoft did not grant offline access, so the calendar cannot refresh itself. Please sign in again and consent.",
          false,
        );
        await this.failPending(error);
        throw error;
      }
      const session: MicrosoftOAuthSession = {
        accessToken: granted.accessToken,
        refreshToken: granted.refreshToken,
        accessTokenExpiresAt: granted.accessTokenExpiresAt,
        scope: granted.scope,
        updatedAt: this.clock().toISOString(),
      };
      await this.sessionStore.write(session);
      await this.refreshAccountIdentity();
      await this.clearPending();
      return this.getStatus();
    } catch (error: unknown) {
      if (error instanceof CalendarConnectionError) {
        throw error;
      }
      if (error instanceof MicrosoftOAuthError) {
        const wrapped = new CalendarConnectionError(
          "MICROSOFT_SIGNIN_EXCHANGE_FAILED",
          `The Microsoft sign-in could not be completed (${error.code}).`,
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

  /** Builds an authenticated Graph calendar provider (fails closed when signed out). */
  public createCalendarProvider(): CalendarEventProvider {
    const authenticator = this.createAuthenticator();
    return new MicrosoftGraphCalendarProvider(this.ensureGraphClient(authenticator));
  }

  public createAuthenticator(): MicrosoftGraphAuthenticator {
    return new MicrosoftGraphAuthenticator(this.options.config, this.sessionStore, {}, this.oauthClient, this.clock);
  }

  private ensureGraphClient(authenticator: MicrosoftGraphAuthenticator): MicrosoftGraphClient {
    if (this.cachedGraphClient === undefined) {
      this.cachedGraphClient = new MicrosoftGraphClient(authenticator, this.options.graphTransport);
    }
    return this.cachedGraphClient;
  }

  private async refreshAccountIdentity(): Promise<void> {
    try {
      const client = this.ensureGraphClient(this.createAuthenticator());
      const me = await client.getJson<{ id?: string; displayName?: string; mail?: string; userPrincipalName?: string }>(
        "/me?$select=id,displayName,mail,userPrincipalName",
      );
      if (typeof me.id !== "string" || me.id.length === 0) {
        return;
      }
      const session = await this.sessionStore.read();
      if (session === null) {
        return;
      }
      const account: { accountId: string; displayName?: string; email?: string; userPrincipalName?: string } = {
        accountId: me.id,
      };
      const displayName = me.displayName?.trim();
      const email = me.mail?.trim();
      const userPrincipalName = me.userPrincipalName?.trim();
      if (displayName !== undefined && displayName.length > 0) account.displayName = displayName;
      if (email !== undefined && email.length > 0) account.email = email;
      if (userPrincipalName !== undefined && userPrincipalName.length > 0) account.userPrincipalName = userPrincipalName;
      await this.sessionStore.write({ ...session, account });
    } catch {
      // Account identity is display metadata only; a failed fetch must not
      // break an otherwise successful sign-in.
    }
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
    return {
      state: "IN_PROGRESS",
      startedAt: pending.startedAt,
      expiresAt: pending.expiresAt,
    };
  }

  private requirePending(flowId: string): PendingMicrosoftSignIn {
    const pending = this.pending;
    if (pending === undefined || pending.flowId !== flowId) {
      throw new CalendarConnectionError("MICROSOFT_SIGNIN_NOT_FOUND", "No active Microsoft sign-in matches this request. Start a new sign-in.", false);
    }
    return pending;
  }

  private async failPending(error: CalendarConnectionError): Promise<void> {
    const pending = this.pending;
    if (pending !== undefined) {
      this.pending = { ...pending, server: undefined, failure: { code: error.code, message: error.message } };
      await pending.server?.close();
    }
  }

  private async clearPending(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.server !== undefined) {
      await pending.server.close();
    }
  }
}

function asConnectionError(error: unknown): CalendarConnectionError {
  if (error instanceof CalendarConnectionError) {
    return error;
  }
  const typed = error as Error & { code?: unknown };
  return new CalendarConnectionError(
    typeof typed.code === "string" ? typed.code : "MICROSOFT_OAUTH_CONFIGURATION_ERROR",
    typed instanceof Error ? typed.message : String(error),
    false,
  );
}

function isPortlessLoopbackRedirect(redirectUri: string): boolean {
  return redirectUri === "http://localhost" || redirectUri === "http://127.0.0.1";
}

function parseLoopbackPort(redirectUri: string): number | undefined {
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
      return undefined;
    }
    return url.port.length > 0 ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
}

function parseCallbackUrl(value: string): { code?: string; state?: string; providerError?: { code: string; description?: string } } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }
  const questionIndex = trimmed.indexOf("?");
  const hashIndex = trimmed.indexOf("#");
  let query = "";
  if (questionIndex !== -1) {
    query = trimmed.slice(questionIndex + 1);
  } else if (hashIndex !== -1) {
    query = trimmed.slice(hashIndex + 1);
  }
  const parameters = new URLSearchParams(query);
  const error = parameters.get("error");
  if (error !== null) {
    return {
      providerError: {
        code: error,
        description: parameters.get("error_description") ?? undefined,
      },
    };
  }
  return {
    code: parameters.get("code") ?? undefined,
    state: parameters.get("state") ?? undefined,
  };
}

function validateCallback(
  parsed: { code?: string; state?: string; providerError?: { code: string; description?: string } },
  expectedState: string,
): CalendarConnectionError | undefined {
  if (parsed.providerError !== undefined) {
    return new CalendarConnectionError(
      "MICROSOFT_SIGNIN_DENIED",
      `The Microsoft sign-in was not completed (${parsed.providerError.code}).`,
      false,
    );
  }
  if (parsed.state === undefined) {
    return new CalendarConnectionError("MICROSOFT_SIGNIN_STATE_MISSING", "The sign-in response did not include a state value.", false);
  }
  if (!secureStringEqual(parsed.state, expectedState)) {
    return new CalendarConnectionError("MICROSOFT_SIGNIN_STATE_MISMATCH", "The sign-in response did not match this sign-in request.", false);
  }
  if (parsed.code === undefined) {
    return new CalendarConnectionError("MICROSOFT_SIGNIN_CODE_MISSING", "The sign-in response did not include an authorization code.", false);
  }
  return undefined;
}
