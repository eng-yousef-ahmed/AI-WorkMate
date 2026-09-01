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

export interface MicrosoftGraphClientOptions {
  baseUrl?: string;
  scopes?: readonly string[];
}

export interface MicrosoftGraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

export class MicrosoftGraphError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MicrosoftGraphError";
  }
}

export class MicrosoftGraphClient {
  private readonly baseUrl: string;
  private readonly scopes: readonly string[];

  public constructor(
    private readonly authProvider: MicrosoftGraphAuthProvider,
    private readonly transport: MicrosoftGraphTransport = new FetchMicrosoftGraphTransport(),
    options: MicrosoftGraphClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
    this.scopes = options.scopes ?? MICROSOFT_GRAPH_SCOPES;
  }

  public async getJson<T>(pathOrAbsoluteUrl: string, signal?: AbortSignal): Promise<T> {
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
    const response = await this.transport.send({
      method: "GET",
      url: this.resolveUrl(pathOrAbsoluteUrl),
      signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw microsoftGraphErrorFromResponse(response);
    }
    return response.body as T;
  }

  public async getAllPages<T>(firstPathOrAbsoluteUrl: string, signal?: AbortSignal): Promise<T[]> {
    const values: T[] = [];
    let nextUrl: string | undefined = firstPathOrAbsoluteUrl;
    while (nextUrl !== undefined) {
      assertNotAborted(signal);
      const page: MicrosoftGraphCollection<T> = await this.getJson<MicrosoftGraphCollection<T>>(nextUrl, signal);
      if (page.value !== undefined && !Array.isArray(page.value)) {
        throw new MicrosoftGraphError("INVALID_GRAPH_PAGE", "Microsoft Graph returned a page with an invalid value collection.", undefined, false);
      }
      values.push(...(page.value ?? []));
      nextUrl = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
    }
    return values;
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

function microsoftGraphErrorFromResponse(response: MicrosoftGraphResponse): MicrosoftGraphError {
  const graphError = parseGraphError(response.body);
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new MicrosoftGraphError(
    graphError.code ?? `HTTP_${response.status}`,
    graphError.message ?? `Microsoft Graph request failed with HTTP ${response.status}.`,
    response.status,
    retryable,
  );
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
