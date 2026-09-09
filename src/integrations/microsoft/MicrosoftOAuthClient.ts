import type { MicrosoftOAuthApplicationConfig } from "./MicrosoftOAuthConfig";
import { microsoftTenant } from "./MicrosoftOAuthConfig";
import { MICROSOFT_GRAPH_SCOPES } from "./MicrosoftAuth";

/**
 * OAuth 2.0 Authorization Code + PKCE transport for Microsoft identity
 * platform v2.0 endpoints. This is a PUBLIC client: no client secret exists,
 * so nothing secret ever leaves the machine. HTTP is injected so tests never
 * touch the network; the production default uses global fetch.
 */

export interface MicrosoftOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires (Microsoft default: 3600). */
  expiresIn: number;
  /** Space-delimited scopes actually granted. */
  scope?: string;
  tokenType: string;
}

export interface MicrosoftOAuthFormResponse {
  status: number;
  body: unknown;
}

export interface MicrosoftOAuthTransport {
  postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<MicrosoftOAuthFormResponse>;
}

export interface MicrosoftOAuthClientOptions {
  transport?: MicrosoftOAuthTransport;
  clock?: () => Date;
}

export interface MicrosoftAuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  /** Space-delimited scopes; defaults to the least-privilege Graph set. */
  scope?: string;
  /** Extra prompt value such as "select_account" or "consent". */
  prompt?: string;
}

export interface MicrosoftCodeExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  scope?: string;
}

export interface MicrosoftRefreshRequest {
  refreshToken: string;
  redirectUri: string;
  scope?: string;
}

export interface MicrosoftGrantedToken {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string;
  scope?: string;
}

export class MicrosoftOAuthClient {
  private readonly transport: MicrosoftOAuthTransport;
  private readonly clock: () => Date;

  public constructor(
    private readonly config: MicrosoftOAuthApplicationConfig,
    options: MicrosoftOAuthClientOptions = {},
  ) {
    this.transport = options.transport ?? new FetchMicrosoftOAuthTransport();
    this.clock = options.clock ?? (() => new Date());
  }

  public buildAuthorizationUrl(request: MicrosoftAuthorizationRequest): string {
    const clientId = requireClientId(this.config);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: request.redirectUri,
      response_mode: "query",
      scope: request.scope ?? MICROSOFT_GRAPH_SCOPES.join(" "),
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      state: request.state,
    });
    if (request.prompt !== undefined) {
      params.set("prompt", request.prompt);
    }
    return `${authority(this.config)}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  public async exchangeCodeForToken(request: MicrosoftCodeExchangeRequest): Promise<MicrosoftGrantedToken> {
    const clientId = requireClientId(this.config);
    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
      scope: request.scope ?? MICROSOFT_GRAPH_SCOPES.join(" "),
    };
    const token = await this.postTokenRequest(form);
    return grantedTokenFrom(token, this.clock());
  }

  public async refreshAccessToken(request: MicrosoftRefreshRequest): Promise<MicrosoftGrantedToken> {
    const clientId = requireClientId(this.config);
    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      redirect_uri: request.redirectUri,
      scope: request.scope ?? MICROSOFT_GRAPH_SCOPES.join(" "),
    };
    const token = await this.postTokenRequest(form);
    return grantedTokenFrom(token, this.clock());
  }

  private async postTokenRequest(form: Record<string, string>): Promise<MicrosoftOAuthTokenResponse> {
    const url = `${authority(this.config)}/oauth2/v2.0/token`;
    let response: MicrosoftOAuthFormResponse;
    try {
      response = await this.transport.postForm(url, form);
    } catch (error: unknown) {
      throw new MicrosoftOAuthHttpError("MICROSOFT_OAUTH_NETWORK_ERROR", "The Microsoft sign-in service could not be reached.", true, undefined, error);
    }
    if (response.status < 200 || response.status >= 300) {
      throw microsoftOAuthErrorFromResponse(response);
    }
    return parseTokenResponse(response.body, url);
  }
}

function grantedTokenFrom(token: MicrosoftOAuthTokenResponse, now: Date): MicrosoftGrantedToken {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    scope: token.scope,
  };
}

export class FetchMicrosoftOAuthTransport implements MicrosoftOAuthTransport {
  public async postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<MicrosoftOAuthFormResponse> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      body.set(key, value);
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal,
      redirect: "error",
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  }
}

export class MicrosoftOAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | undefined,
    public readonly description?: string,
    public readonly aadstsCode?: string,
  ) {
    super(message);
    this.name = "MicrosoftOAuthError";
  }
}

export class MicrosoftOAuthHttpError extends MicrosoftOAuthError {
  public constructor(
    code: string,
    message: string,
    retryable: boolean,
    status: number | undefined,
    cause: unknown,
  ) {
    super(code, message, retryable, status);
    this.name = "MicrosoftOAuthHttpError";
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Refresh-token failures that permanently invalidate the session. When the
 * identity platform reports one of these the app must stop refreshing and ask
 * the user to sign in again.
 */
export const FATAL_REFRESH_AADSTS_CODES = new Set([
  "AADSTS700082",  // refresh token expired
  "AADSTS70008",   // inactivity / max lifetime exceeded
  "AADSTS7000215", // invalid client secret (public-client config drift)
  "AADSTS50173",   // password change required
  "AADSTS54005",   // password expired
  "AADSTS50076",   // re-auth (multi-factor / conditional access)
]);

export function isFatalMicrosoftRefreshError(error: MicrosoftOAuthError): boolean {
  if (error.code !== "invalid_grant") {
    return false;
  }
  const aadsts = extractAadstsCode(error.description);
  return aadsts === undefined || FATAL_REFRESH_AADSTS_CODES.has(aadsts);
}

export function extractAadstsCode(description: string | undefined): string | undefined {
  if (description === undefined) {
    return undefined;
  }
  const match = /(AADSTS\d{5,})/.exec(description);
  return match?.[1];
}

export function microsoftOAuthErrorFromResponse(response: MicrosoftOAuthFormResponse): MicrosoftOAuthError {
  const parsed = parseOAuthErrorBody(response.body);
  const status = response.status;
  const description = parsed.description ?? (typeof response.body === "string" ? response.body.slice(0, 500) : undefined);
  const aadsts = extractAadstsCode(description);
  const message = parsed.error !== undefined
    ? `${parsed.error}${description === undefined ? "" : `: ${description}`}`.slice(0, 500)
    : `The Microsoft sign-in service responded with HTTP ${status}.`;
  const retryable = status === 408 || status === 429 || status >= 500;
  return new MicrosoftOAuthError(
    parsed.error ?? `HTTP_${status}`,
    message,
    retryable,
    status,
    description,
    aadsts,
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

function parseTokenResponse(body: unknown, url: string): MicrosoftOAuthTokenResponse {
  if (typeof body !== "object" || body === null) {
    throw new MicrosoftOAuthError("MICROSOFT_OAUTH_MALFORMED_RESPONSE", `The Microsoft token endpoint (${url}) returned a malformed response.`, false, undefined);
  }
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  const scope = record.scope;
  const tokenType = record.token_type;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new MicrosoftOAuthError("MICROSOFT_OAUTH_MALFORMED_RESPONSE", `The Microsoft token endpoint (${url}) returned no access token.`, false, undefined);
  }
  const response: MicrosoftOAuthTokenResponse = {
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
  return response;
}

function authority(config: MicrosoftOAuthApplicationConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant(config))}`;
}

function requireClientId(config: MicrosoftOAuthApplicationConfig): string {
  const clientId = config.clientId?.trim();
  if (clientId === undefined || clientId.length === 0) {
    throw new Error("MICROSOFT_CLIENT_NOT_CONFIGURED: a Microsoft application (client) ID is required.");
  }
  return clientId;
}
