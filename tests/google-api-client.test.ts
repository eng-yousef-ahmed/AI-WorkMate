import assert from "node:assert/strict";
import { test } from "node:test";

import type { GoogleGraphAuthProvider } from "../src/integrations/google/GoogleAuth";
import { GoogleAuthError } from "../src/integrations/google/GoogleAuth";
import { GoogleApiClient, GoogleApiError, type GoogleApiRequest, type GoogleApiResponse, type GoogleApiTransport } from "../src/integrations/google/GoogleApiClient";

const FAKE_AUTH: GoogleGraphAuthProvider = {
  getAccessToken: async () => ({ accessToken: "ya29.token-1", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }),
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string | undefined> = {}): GoogleApiResponse {
  return { status, headers, body };
}

function recordingTransport(handler: (request: GoogleApiRequest, index: number) => GoogleApiResponse): {
  transport: GoogleApiTransport;
  requests: GoogleApiRequest[];
} {
  const requests: GoogleApiRequest[] = [];
  return {
    transport: { send: async (request) => {
      requests.push(request);
      return handler(request, requests.length);
    } },
    requests,
  };
}

function clientWith(retry: Record<string, unknown> = {}): {
  client: GoogleApiClient;
  requests: GoogleApiRequest[];
} {
  const recorded = recordingTransport(() => jsonResponse(200, { kind: "calendar#events" }));
  const client = new GoogleApiClient(FAKE_AUTH, recorded.transport, {
    retry: { sleeper: async () => undefined, maxAttempts: 4, baseDelayMs: 100, ...retry },
  });
  return { client, requests: recorded.requests };
}

test("sends an authenticated GET with the bearer token and parses JSON bodies", async () => {
  const { client, requests } = clientWith();
  const body = await client.getJson<{ kind: string }>("/calendars/primary/events");
  assert.equal(body.kind, "calendar#events");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.authorization, "Bearer ya29.token-1");
  assert.equal(requests[0]?.url, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
});

test("retries transient HTTP failures (429 with capped Retry-After and 503 backoff)", async () => {
  let calls = 0;
  const recorded = recordingTransport(() => {
    calls += 1;
    if (calls === 1) return jsonResponse(429, { error: { code: 429, message: "rate" } }, { "retry-after": "1" });
    if (calls === 2) return jsonResponse(503, { error: { code: 503, message: "backend" } });
    return jsonResponse(200, { kind: "calendar#events" });
  });
  const delays: number[] = [];
  const client = new GoogleApiClient(FAKE_AUTH, recorded.transport, {
    retry: { maxAttempts: 3, baseDelayMs: 500, maxRetryAfterSeconds: 60, sleeper: async (ms) => { delays.push(ms); } },
  });
  await client.getJson("/events");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 1000]); // Retry-After honored, then 500ms*2^1 backoff
});

test("honors retry caps and never retries permanent errors or 410 stale tokens", async () => {
  const attempts429: number[] = [];
  const transport429 = recordingTransport(() => {
    attempts429.push(1);
    return jsonResponse(429, { error: { code: 429, message: "rate" } }, { "retry-after": "999" });
  });
  const capped = new GoogleApiClient(FAKE_AUTH, transport429.transport, {
    retry: { maxAttempts: 3, maxRetryAfterSeconds: 1, sleeper: async () => undefined },
  });
  await assert.rejects(capped.getJson("/events"), (error: unknown) => error instanceof GoogleApiError && error.status === 429);
  assert.equal(attempts429.length, 3);

  // 410 GONE (stale syncToken) is NOT retryable: it must surface immediately
  // so the coordinator can self-heal with a full sync.
  const attempts410: number[] = [];
  const transport410 = recordingTransport(() => {
    attempts410.push(1);
    return jsonResponse(410, {
      error: {
        code: 410,
        message: "The requested sync token is no longer valid.",
        errors: [{ domain: "global", reason: "syncTokenInvalid", message: "The requested sync token is no longer valid." }],
      },
    });
  });
  const client410 = new GoogleApiClient(FAKE_AUTH, transport410.transport, {
    retry: { maxAttempts: 4, sleeper: async () => undefined },
  });
  await assert.rejects(client410.getJson("/events"), (error: unknown) =>
    error instanceof GoogleApiError && error.status === 410 && error.code === "syncTokenInvalid" && error.retryable === false);
  assert.equal(attempts410.length, 1);

  const nonRetryable = recordingTransport(() => jsonResponse(400, { error: { code: 400, message: "invalid argument" } }));
  const client400 = new GoogleApiClient(FAKE_AUTH, nonRetryable.transport, {
    retry: { maxAttempts: 4, sleeper: async () => undefined },
  });
  await assert.rejects(client400.getJson("/events"), (error: unknown) => error instanceof GoogleApiError && error.code === "HTTP_400");
  assert.equal(nonRetryable.requests.length, 1);
});

test("stops retrying at maxAttempts and surfaces the final error", async () => {
  const attempts: number[] = [];
  const recorded = recordingTransport(() => {
    attempts.push(1);
    return jsonResponse(503, { error: { code: 503, message: "backendError" } });
  });
  const client = new GoogleApiClient(FAKE_AUTH, recorded.transport, {
    retry: { maxAttempts: 3, baseDelayMs: 1000, sleeper: async () => undefined },
  });
  await assert.rejects(client.getJson("/events"), (error: unknown) => error instanceof GoogleApiError && error.code === "HTTP_503");
  assert.equal(attempts.length, 3);
});

test("retries network-level transport failures and honors abort", async () => {
  let calls = 0;
  const recorded = recordingTransport(() => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed: getaddrinfo ENOTFOUND www.googleapis.com");
    return jsonResponse(200, {});
  });
  const client = new GoogleApiClient(FAKE_AUTH, recorded.transport, {
    retry: { sleeper: async () => undefined },
  });
  await client.getJson("/events");
  assert.equal(calls, 2);

  const controller = new AbortController();
  controller.abort();
  const abortClient = new GoogleApiClient(FAKE_AUTH, recordingTransport(() => jsonResponse(200, {})).transport);
  await assert.rejects(abortClient.getJson("/events", controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("auth failures fail closed and are never retried", async () => {
  const authProvider: GoogleGraphAuthProvider = {
    getAccessToken: async () => {
      throw new GoogleAuthError("GOOGLE_AUTHENTICATION_REQUIRED", "Sign in required.", false);
    },
  };
  const recorded = recordingTransport(() => jsonResponse(200, {}));
  const client = new GoogleApiClient(authProvider, recorded.transport, { retry: { sleeper: async () => undefined } });
  await assert.rejects(client.getJson("/events"), (error: unknown) =>
    error instanceof GoogleApiError && error.code === "GOOGLE_AUTHENTICATION_REQUIRED" && error.retryable === false);
  assert.equal(recorded.requests.length, 0);
});
