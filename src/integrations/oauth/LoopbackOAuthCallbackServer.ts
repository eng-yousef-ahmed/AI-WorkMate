import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One-shot loopback OAuth callback listener. Binds to 127.0.0.1 so no remote
 * host can reach it, validates the Host header, accepts exactly one callback,
 * and then closes. The full redirected URL (with code + state) is delivered to
 * the caller so the owning provider flow can validate `state` before exchange.
 * The request-handling logic is plain and injectable so tests exercise real
 * parsing without real sockets.
 */

export interface LoopbackCallback {
  /** The exact URL the provider redirected the browser to. */
  redirectUrl: string;
  /** `error`/`error_description` when the provider refused authorization. */
  providerError?: { code: string; description?: string };
}

export interface LoopbackCallbackServer {
  readonly redirectUri: string;
  readonly port: number;
  /** Resolves with the single captured callback, or rejects on timeout/cancel/close. */
  readonly callback: Promise<LoopbackCallback>;
  close(): Promise<void>;
}

export interface LoopbackHttpRequest {
  url: string;
  host?: string;
  method?: string;
}

export interface LoopbackHttpResponse {
  status: number;
  html?: string;
}

/** Low-level listener abstraction; the default binds a real HTTP socket. */
export interface LoopbackListener {
  readonly port: number;
  readonly redirectUri: string;
  close(): Promise<void>;
}

export interface LoopbackCallbackServerOptions {
  /** Milliseconds to wait for the browser callback before failing. */
  timeoutMs?: number;
  /** Optional external abort (app quit or user cancel). */
  signal?: AbortSignal;
  /** Path the provider redirects to; default "/". */
  path?: string;
  /** Fixed port for providers that require one; default 0 (ephemeral). */
  port?: number;
  /** Injectable listener factory for tests that avoid real sockets. */
  listenerFactory?: (handle: (request: LoopbackHttpRequest) => LoopbackHttpResponse) => Promise<LoopbackListener>;
}

export const LOOPBACK_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export async function startLoopbackCallbackServer(options: LoopbackCallbackServerOptions = {}): Promise<LoopbackCallbackServer> {
  const callbackPath = normalizeCallbackPath(options.path);
  const timeoutMs = options.timeoutMs ?? LOOPBACK_CALLBACK_TIMEOUT_MS;

  let resolveCallback: (value: LoopbackCallback) => void = () => undefined;
  let rejectCallback: (reason: unknown) => void = () => undefined;
  const callback = new Promise<LoopbackCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Mark the promise handled even before a consumer attaches, so an early
  // close can never surface as an unhandledRejection; consumers still receive
  // the rejection through their own handlers.
  void callback.catch(() => undefined);

  let settled = false;
  let listener: LoopbackListener | undefined;
  let timer: NodeJS.Timeout | undefined;

  const closeListener = async (): Promise<void> => {
    const current = listener;
    listener = undefined;
    if (current !== undefined) {
      await current.close().catch(() => undefined);
    }
  };

  const rejectOnce = async (error: Error): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onAbort);
    await closeListener();
    rejectCallback(error);
  };

  const resolveOnce = (value: LoopbackCallback): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", onAbort);
    resolveCallback(value);
    void closeListener();
  };

  const onAbort = (): void => {
    void rejectOnce(createLoopbackError("LOOPBACK_CALLBACK_CANCELLED", "The calendar sign-in was cancelled.", false));
  };

  if (options.signal?.aborted === true) {
    throw createLoopbackError("LOOPBACK_CALLBACK_CANCELLED", "The calendar sign-in was cancelled.", false);
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      void rejectOnce(createLoopbackError("LOOPBACK_CALLBACK_TIMEOUT", "The calendar sign-in window expired. Please try again.", false));
    }, timeoutMs);
  }

  const factory = options.listenerFactory ?? ((handle: (request: LoopbackHttpRequest) => LoopbackHttpResponse) =>
    createHttpLoopbackListener(options.port ?? 0, callbackPath, handle));
  let bound: LoopbackListener;
  try {
    bound = await factory((request: LoopbackHttpRequest) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        return { status: 405 };
      }
      const parsed = parseLoopbackCallback(request);
      if (!parsed.accepted) {
        return { status: parsed.status };
      }
      // Defer so the HTTP response can be written before the listener closes.
      queueMicrotask(() => resolveOnce(parsed.callback));
      return {
        status: 200,
        html: parsed.callback.providerError === undefined ? LOOPBACK_SUCCESS_HTML : LOOPBACK_DENIED_HTML,
      };
    });
  } catch (error: unknown) {
    options.signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    throw error;
  }
  listener = bound;

  return {
    redirectUri: bound.redirectUri,
    port: bound.port,
    callback,
    close: async () => {
      await rejectOnce(createLoopbackError("LOOPBACK_CALLBACK_CLOSED", "The sign-in callback listener was closed.", false));
    },
  };
}

function normalizeCallbackPath(path: string | undefined): string {
  const clean = path?.trim();
  if (clean === undefined || clean === "" || clean === "/") {
    return "/";
  }
  return clean.startsWith("/") ? clean : `/${clean}`;
}

/** Hosts the browser may legitimately use to reach the loopback listener. */
const ALLOWED_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) {
    return false;
  }
  const host = hostHeader.toLowerCase().trim();
  const hostOnly = host.startsWith("[") ? host.slice(1, -1) : host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
  return ALLOWED_LOOPBACK_HOSTS.has(hostOnly);
}

export function parseLoopbackCallback(
  request: LoopbackHttpRequest,
): { accepted: true; callback: LoopbackCallback } | { accepted: false; status: number } {
  const questionIndex = request.url.indexOf("?");
  const path = questionIndex === -1 ? request.url : request.url.slice(0, questionIndex);
  const query = questionIndex === -1 ? "" : request.url.slice(questionIndex + 1);
  if (!isAllowedLoopbackHost(request.host)) {
    return { accepted: false, status: 403 };
  }
  if (path !== "/") {
    return { accepted: false, status: 404 };
  }
  const parameters = new URLSearchParams(query);
  const error = parameters.get("error");
  if (error !== null) {
    return {
      accepted: true,
      callback: {
        redirectUrl: request.url,
        providerError: {
          code: error,
          description: parameters.get("error_description") ?? undefined,
        },
      },
    };
  }
  if (parameters.get("code") === null || parameters.get("state") === null) {
    return { accepted: false, status: 400 };
  }
  return { accepted: true, callback: { redirectUrl: request.url } };
}

function createHttpLoopbackListener(
  port: number,
  callbackPath: string,
  handle: (request: LoopbackHttpRequest) => LoopbackHttpResponse,
): Promise<LoopbackListener> {
  const server: Server = createServer((request, response) => {
    const result = handle({
      url: request.url ?? "/",
      host: request.headers.host,
      method: request.method,
    });
    response.statusCode = result.status;
    response.setHeader("content-type", result.html === undefined ? "text/plain; charset=utf-8" : "text/html; charset=utf-8");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(result.html ?? statusText(result.status));
  });
  const close = (): Promise<void> =>
    new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  return new Promise<LoopbackListener>((resolveListener, rejectListener) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListener(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolveListener({
        port: address.port,
        redirectUri: `http://localhost:${address.port}${callbackPath}`,
        close,
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function statusText(status: number): string {
  switch (status) {
    case 400: return "Bad request.";
    case 403: return "Forbidden.";
    case 404: return "Not found.";
    case 405: return "Method not allowed.";
    default: return "Request failed.";
  }
}

export function createLoopbackError(code: string, message: string, retryable: boolean): Error {
  const error = new Error(message);
  error.name = "LoopbackOAuthError";
  Object.assign(error, { code, retryable });
  return error;
}

export function isLoopbackOAuthError(error: unknown): error is Error & { code: string; retryable: boolean } {
  return error instanceof Error && error.name === "LoopbackOAuthError" &&
    typeof (error as Error & { code?: unknown }).code === "string";
}

export const LOOPBACK_SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>AI WorkMate</title></head>" +
  "<body style=\"font-family: system-ui; display:flex;align-items:center;justify-content:center;height:90vh;\">" +
  "<div style=\"text-align:center;\"><h2>AI WorkMate</h2><p>Calendar sign-in complete. You can close this window.</p></div>" +
  "</body></html>";

export const LOOPBACK_DENIED_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>AI WorkMate</title></head>" +
  "<body style=\"font-family: system-ui; display:flex;align-items:center;justify-content:center;height:90vh;\">" +
  "<div style=\"text-align:center;\"><h2>AI WorkMate</h2><p>Calendar sign-in could not be completed. Close this window and try again.</p></div>" +
  "</body></html>";
