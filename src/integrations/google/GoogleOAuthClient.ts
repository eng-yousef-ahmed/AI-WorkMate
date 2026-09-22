import type { OAuthFormResponse, OAuthFormTransport } from "../oauth/OAuthFormTransport";
import { FetchOAuthFormTransport } from "../oauth/OAuthFormTransport";
import type { GoogleOAuthApplicationConfig } from "./GoogleOAuthConfig";
import { googleClientId, GOOGLE_AUTHORIZATION_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "./GoogleOAuthConfig";
import { GOOGLE_CALENDAR_SCOPES } from "./GoogleAuth";

/**
 * OAuth 2.0 Authorization Code + PKCE transport for Google OAuth. Google's
 * desktop-client secret is treated as non-confidential (RFC 8252): PKCE makes
 * the flow safe without it, and none is required. HTTP is injected so tests
 * never touch the network; the production default uses global fetch.
 */

export interface GoogleOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires (Google default: 3600). */
  expiresIn: number;
  /** Space-delimited scopes actually granted. */
  scope?: string;
  tokenType: string;
  /** JWT id_token carrying the Google account identity. */
  idToken?: string;
}

export interface GoogleOAuthClientOptions {
  transport?: OAuthFormTransport;
  clock?: () => Date;
}

export interface GoogleAuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  /** Space-delimited scopes; defaults to the least-privilege calendar set. */
  scope?: string;
  /** account selection prompt values: "select_account" | "consent" | "login". */
  prompt?: string;
  loginHint?: string;
  /** Opaque accessibility/UX token; not secret. */
  accessType?: "offline" | "online";
}

export interface GoogleCodeExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scope?: string;
}

export interface GoogleRefreshRequest {
  refreshToken: string;
  redirectUri: string;
  scope?: string;
}

export interface GoogleGrantedToken {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string;
  scope?: string;
  idToken?: string;
}

export class GoogleOAuthClient {
  private readonly transport: OAuthFormTransport;
  private readonly clock: () => Date;

  public constructor(
    private readonly config: GoogleOAuthApplicationConfig,
    options: GoogleOAuthClientOptions = {},
  ) {
    this.transport = options.transport ?? new FetchOAuthFormTransport();
    this.clock = options.clock ?? (() => new Date());
  }

  public buildAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const clientId = googleClientId(this.config);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: request.redirectUri,
      scope: request.scope ?? GOOGLE_CALENDAR_SCOPES.join(" "),
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      state: request.state,
      access_type: request.accessType ?? "offline",
      prompt: request.prompt ?? "select_account",
    });
    if (request.loginHint !== undefined) {
      params.set("login_hint", request.loginHint);
    }
    return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  public async exchangeCodeForToken(request: GoogleCodeExchangeRequest): Promise<GoogleGrantedToken> {
    const clientId = googleClientId(this.config);
    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
    };
    const scope = request.scope ?? GOOGLE_CALENDAR_SCOPES.join(" ");
    const token = await this.postTokenRequest(form, scope);
    return grantedTokenFrom(token, this.clock());
  }

  public async refreshAccessToken(request: GoogleRefreshRequest): Promise<GoogleGrantedToken> {
    const clientId = googleClientId(this.config);
    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      redirect_uri: request.redirectUri,
    };
    const scope = request.scope ?? GOOGLE_CALENDAR_SCOPES.join(" ");
    const token = await this.postTokenRequest(form, scope);
    return grantedTokenFrom(token, this.clock());
  }

  private async postTokenRequest(form: Record<string, string>, scope: string): Promise<GoogleOAuthTokenResponse> {
    // Google's client secret is optional for installed apps (RFC 8252 §8.5);
    // when the user supplied one it is forwarded for maximum compatibility.
    const clientSecret = this.config.clientSecret?.trim();
    if (clientSecret !== undefined && clientSecret.length > 0) {
      form.client_secret = clientSecret;
    }
    if (form.scope === undefined) {
      form.scope = scope;
    }
    let response: OAuthFormResponse;
    try {
      response = await this.transport.postForm(GOOGLE_TOKEN_ENDPOINT, form);
    } catch (error: unknown) {
      throw new GoogleOAuthHttpError("GOOGLE_OAUTH_NETWORK_ERROR", "The Google sign-in service could not be reached.", true, undefined, error);
    }
    if (response.status < 200 || response.status >= 300) {
      throw googleOAuthErrorFromResponse(response);
    }
    return parseTokenResponse(response.body);
  }
}

function grantedTokenFrom(token: GoogleOAuthTokenResponse, now: Date): GoogleGrantedToken {
  const granted: GoogleGrantedToken = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    scope: token.scope,
  };
  if (typeof token.idToken === "string" && token.idToken.length > 0) {
    granted.idToken = token.idToken;
  }
  return granted;
}

export class GoogleOAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | undefined,
    public readonly description?: string,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export class GoogleOAuthHttpError extends GoogleOAuthError {
  public constructor(
    code: string,
    message: string,
    retryable: boolean,
    status: number | undefined,
    cause: unknown,
  ) {
    super(code, message, retryable, status);
    this.name = "GoogleOAuthHttpError";
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Refresh failures that permanently invalidate the Google session. */
export const FATAL_GOOGLE_REFRESH_ERRORS = new Set([
  "invalid_grant",      // refresh token revoked, expired, or never issued
  "unauthorized_client", // client no longer allowed for the granted token
]);

export function isFatalGoogleRefreshError(error: GoogleOAuthError): boolean {
  return error.code !== undefined && FATAL_GOOGLE_REFRESH_ERRORS.has(error.code);
}

export function googleOAuthErrorFromResponse(response: OAuthFormResponse): GoogleOAuthError {
  const parsed = parseOAuthErrorBody(response.body);
  const description = parsed.description ?? (typeof response.body === "string" ? response.body.slice(0, 500) : undefined);
  const message = parsed.error !== undefined
    ? `${parsed.error}${description === undefined ? "" : `: ${description}`}`.slice(0, 500)
    : `The Google sign-in service responded with HTTP ${response.status}.`;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new GoogleOAuthError(
    parsed.error ?? `HTTP_${response.status}`,
    message,
    retryable,
    response.status,
    description,
  );
}

function parseOAuthErrorBody(body: unknown): { error?: string; description?: string } {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  const description = record.error_description ?? record.errorDescription;
  return {
    error: typeof error === "string" ? error : undefined,
    description: typeof description === "string" ? description : undefined,
  };
}

function parseTokenResponse(body: unknown): GoogleOAuthTokenResponse {
  if (typeof body !== "object" || body === null) {
    throw new GoogleOAuthError("GOOGLE_OAUTH_MALFORMED_RESPONSE", "The Google token endpoint returned a malformed response.", false, undefined);
  }
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  const scope = record.scope;
  const tokenType = record.token_type;
  const idToken = record.id_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GoogleOAuthError("GOOGLE_OAUTH_MALFORMED_RESPONSE", "The Google token endpoint returned no access token.", false, undefined);
  }
  const response: GoogleOAuthTokenResponse = {
    accessToken,
    tokenType: typeof tokenType === "string" ? tokenType : "Bearer",
    expiresIn: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 3600,
  };
  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    response.refreshToken = refreshToken;
  }
  if (typeof scope === "string" && scope.length > 0) {
    response.scope = scope;
  }
  if (typeof idToken === "string" && idToken.length > 0) {
    response.idToken = idToken;
  }
  return response;
}
