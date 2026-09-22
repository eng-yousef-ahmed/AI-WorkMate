import {
  MICROSOFT_GRAPH_SCOPES,
  MicrosoftGraphAuthError,
  type MicrosoftGraphAuthProvider,
} from "./MicrosoftAuth";

export interface MicrosoftGraphRequest {
  method: "GET";
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface MicrosoftGraphResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface MicrosoftGraphTransport {
  send(request: MicrosoftGraphRequest): Promise<MicrosoftGraphResponse>;
}

export interface MicrosoftGraphRetryOptions {
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

export interface MicrosoftGraphClientOptions {
  baseUrl?: string;
  scopes?: readonly string[];
  retry?: MicrosoftGraphRetryOptions;
}

export interface MicrosoftGraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

export interface MicrosoftGraphDeltaPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export class MicrosoftGraphError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MicrosoftGraphError";
  }
}

export class MicrosoftGraphClient {
  private readonly baseUrl: string;
  private readonly scopes: readonly string[];
  private readonly retry: Required<MicrosoftGraphRetryOptions>;

  public constructor(
    private readonly authProvider: MicrosoftGraphAuthProvider,
    private readonly transport: MicrosoftGraphTransport = new FetchMicrosoftGraphTransport(),
    options: MicrosoftGraphClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
    this.scopes = options.scopes ?? MICROSOFT_GRAPH_SCOPES;
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
        if (error instanceof MicrosoftGraphAuthError) {
          throw new MicrosoftGraphError(error.code, error.message, undefined, error.retryable);
        }
        throw error;
      }
      assertNotAborted(signal);
      let response: MicrosoftGraphResponse;
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
        throw new MicrosoftGraphError(
          "MICROSOFT_GRAPH_NETWORK_ERROR",
          `Microsoft Graph could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          true,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw microsoftGraphErrorFromResponse(response);
      }
      return response.body as T;
    });
  }

  /** Follows @odata.nextLink pages and captures the final @odata.deltaLink. */
  public async getDeltaPages<T>(firstPathOrAbsoluteUrl: string, signal?: AbortSignal): Promise<{ values: T[]; deltaLink?: string }> {
    const values: T[] = [];
    let nextUrl: string | undefined = firstPathOrAbsoluteUrl;
    let deltaLink: string | undefined;
    while (nextUrl !== undefined) {
      const page: MicrosoftGraphDeltaPage<T> = await this.getJson<MicrosoftGraphDeltaPage<T>>(nextUrl, signal);
      if (page.value !== undefined && !Array.isArray(page.value)) {
        throw new MicrosoftGraphError("INVALID_GRAPH_PAGE", "Microsoft Graph returned a page with an invalid value collection.", undefined, false);
      }
      values.push(...(page.value ?? []));
      if (typeof page["@odata.deltaLink"] === "string" && page["@odata.deltaLink"].length > 0) {
        deltaLink = page["@odata.deltaLink"];
      }
      nextUrl = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    }
    return { values, deltaLink };
  }

  public async getAllPages<T>(firstPathOrAbsoluteUrl: string, signal?: AbortSignal): Promise<T[]> {
    const page = await this.getDeltaPages<T>(firstPathOrAbsoluteUrl, signal);
    return page.values;
  }

  private async withRetry<T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        return await attempt();
      } catch (error: unknown) {
        if (!(error instanceof MicrosoftGraphError)) {
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

  private computeRetryDelay(error: MicrosoftGraphError, attempts: number): number {
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

export class FetchMicrosoftGraphTransport implements MicrosoftGraphTransport {
  public async send(request: MicrosoftGraphRequest): Promise<MicrosoftGraphResponse> {
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
        "request-id": response.headers.get("request-id") ?? undefined,
        "retry-after": response.headers.get("retry-after") ?? undefined,
      },
      body,
    };
  }
}

async function defaultSleeper(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function microsoftGraphErrorFromResponse(response: MicrosoftGraphResponse): MicrosoftGraphError {
  const graphError = parseGraphError(response.body);
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new MicrosoftGraphError(
    graphError.code ?? `HTTP_${response.status}`,
    graphError.message ?? `Microsoft Graph request failed with HTTP ${response.status}.`,
    response.status,
    retryable,
    response.status === 429 ? retryAfterSeconds(response.headers["retry-after"]) : undefined,
  );
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

function parseGraphError(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return {};
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error("Microsoft Graph request was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
