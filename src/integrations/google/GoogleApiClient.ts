import { GoogleAuthError, GOOGLE_CALENDAR_SCOPES, type GoogleGraphAuthProvider } from "./GoogleAuth";

export interface GoogleApiRequest {
  method: "GET";
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface GoogleApiResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface GoogleApiTransport {
  send(request: GoogleApiRequest): Promise<GoogleApiResponse>;
}

export interface GoogleApiRetryOptions {
  /** Total attempts including the first (default 4). */
  maxAttempts?: number;
  /** Base exponential backoff in ms (default 250). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 8000). */
  maxDelayMs?: number;
  /** Honor Retry-After headers when present (default true). */
  honorRetryAfter?: boolean;
  /** Cap on honored Retry-After seconds (default 60). */
  maxRetryAfterSeconds?: number;
  /** Injectable sleeper for deterministic tests. */
  sleeper?: (milliseconds: number) => Promise<void>;
}

export interface GoogleApiClientOptions {
  baseUrl?: string;
  scopes?: readonly string[];
  retry?: GoogleApiRetryOptions;
}

export class GoogleApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * Authenticated JSON client for Google APIs. Wraps the auth provider and the
 * transport in a shared retry policy: transient HTTP errors (408/409/429/5xx)
 * and network-level failures are retried with capped exponential backoff that
 * honors Retry-After; auth failures, malformed payloads, and aborts surface
 * immediately.
 */
export class GoogleApiClient {
  private readonly baseUrl: string;
  private readonly scopes: readonly string[];
  private readonly retry: Required<GoogleApiRetryOptions>;

  public constructor(
    private readonly authProvider: GoogleGraphAuthProvider,
    private readonly transport: GoogleApiTransport = new FetchGoogleApiTransport(),
    options: GoogleApiClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://www.googleapis.com/calendar/v3").replace(/\/$/, "");
    this.scopes = options.scopes ?? GOOGLE_CALENDAR_SCOPES;
    const retry = options.retry ?? {};
    this.retry = {
      maxAttempts: retry.maxAttempts ?? 4,
      baseDelayMs: retry.baseDelayMs ?? 250,
      maxDelayMs: retry.maxDelayMs ?? 8000,
      honorRetryAfter: retry.honorRetryAfter ?? true,
      maxRetryAfterSeconds: retry.maxRetryAfterSeconds ?? 60,
      sleeper: retry.sleeper ?? defaultSleeper,
    };
  }

  public async getJson<T>(pathOrAbsoluteUrl: string, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    return this.withRetry(signal, async () => {
      assertNotAborted(signal);
      let accessToken: string;
      try {
        const token = await this.authProvider.getAccessToken({ scopes: this.scopes, signal });
        accessToken = token.accessToken;
      } catch (error: unknown) {
        if (error instanceof GoogleAuthError) {
          throw new GoogleApiError(error.code, error.message, undefined, error.retryable);
        }
        throw error;
      }
      assertNotAborted(signal);
      let response: GoogleApiResponse;
      try {
        response = await this.transport.send({
          method: "GET",
          url: this.resolveUrl(pathOrAbsoluteUrl),
          signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
        });
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        // Transport-level failures (DNS, connect reset, TLS) are retryable.
        throw new GoogleApiError(
          "GOOGLE_API_NETWORK_ERROR",
          `The Google Calendar API could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          true,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw googleApiErrorFromResponse(response);
      }
      return response.body as T;
    });
  }

  private async withRetry<T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        return await attempt();
      } catch (error: unknown) {
        if (!(error instanceof GoogleApiError)) {
          throw error;
        }
        if (signal?.aborted === true || !error.retryable || attempts >= this.retry.maxAttempts) {
          throw error;
        }
        const delay = this.computeRetryDelay(error, attempts);
        await this.retry.sleeper(delay);
      }
    }
  }

  private computeRetryDelay(error: GoogleApiError, attempts: number): number {
    let delay: number;
    if (this.retry.honorRetryAfter && error.retryAfterSeconds !== undefined) {
      delay = Math.min(error.retryAfterSeconds * 1000, this.retry.maxRetryAfterSeconds * 1000);
    } else {
      delay = Math.min(this.retry.baseDelayMs * 2 ** (attempts - 1), this.retry.maxDelayMs);
    }
    return Math.max(0, delay);
  }

  private resolveUrl(pathOrAbsoluteUrl: string): string {
    if (pathOrAbsoluteUrl.startsWith("https://")) {
      return pathOrAbsoluteUrl;
    }
    return `${this.baseUrl}${pathOrAbsoluteUrl.startsWith("/") ? "" : "/"}${pathOrAbsoluteUrl}`;
  }
}

export class FetchGoogleApiTransport implements GoogleApiTransport {
  public async send(request: GoogleApiRequest): Promise<GoogleApiResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return {
      status: response.status,
      headers: {
        "retry-after": response.headers.get("retry-after") ?? undefined,
      },
      body,
    };
  }
}

async function defaultSleeper(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function googleApiErrorFromResponse(response: GoogleApiResponse): GoogleApiError {
  const parsed = parseGoogleApiErrorBody(response.body);
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new GoogleApiError(
    parsed.reason ?? `HTTP_${response.status}`,
    parsed.message ?? `The Google Calendar API request failed with HTTP ${response.status}.`,
    response.status,
    retryable,
    response.status === 429 ? retryAfterSeconds(response.headers["retry-after"]) : undefined,
  );
}

function parseGoogleApiErrorBody(body: unknown): { reason?: string; message?: string } {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : undefined;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "object" && entry !== null) {
        const reason = (entry as Record<string, unknown>).reason;
        if (typeof reason === "string") {
          return { reason, message };
        }
      }
    }
  }
  return { message };
}

function retryAfterSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
  }
  return undefined;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error("The Google Calendar request was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
