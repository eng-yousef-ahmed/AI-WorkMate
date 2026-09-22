import assert from "node:assert/strict";
import { test } from "node:test";

import type { MicrosoftGraphAuthProvider } from "../src/integrations/microsoft/MicrosoftAuth";
import {
  MicrosoftGraphClient,
  type MicrosoftGraphRequest,
  type MicrosoftGraphResponse,
  type MicrosoftGraphTransport,
} from "../src/integrations/microsoft/MicrosoftGraphClient";

function fakeAuth(): MicrosoftGraphAuthProvider {
  return {
    getAccessToken: async () => ({
      accessToken: "token-1",
      expiresAt: "2026-09-09T13:00:00.000Z",
      scopes: ["User.Read", "Calendars.Read", "offline_access"],
    }),
  };
}

function recordingTransport(responses: Array<MicrosoftGraphResponse | Error>): {
  transport: MicrosoftGraphTransport;
  requests: MicrosoftGraphRequest[];
  failNext: (error: Error) => void;
} {
  const requests: MicrosoftGraphRequest[] = [];
  let queue = [...responses];
  return {
    transport: {
      send: async (request) => {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("no scripted response left");
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    },
    requests,
    failNext: (error) => {
      queue = [error, ...queue];
    },
  };
}

function okResponse(body: unknown, status = 200): MicrosoftGraphResponse {
  return { status, headers: {}, body };
}

test("transient failures are retried with backoff and then succeed", async () => {
  const delays: number[] = [];
  const recorded = recordingTransport([
    okResponse({ error: { code: "serviceUnavailable", message: "busy" } }, 503),
    okResponse({ value: ["ok"] }),
  ]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, {
    retry: {
      baseDelayMs: 100,
      sleeper: async (delay) => {
        delays.push(delay);
      },
    },
  });
  const result = await client.getJson<{ value: string[] }>("/me/events");
  assert.deepEqual(result.value, ["ok"]);
  assert.equal(recorded.requests.length, 2);
  assert.deepEqual(delays, [100]);
});

test("rate limits honor Retry-After up to the configured cap", async () => {
  const delays: number[] = [];
  const recorded = recordingTransport([
    { status: 429, headers: { "retry-after": "2" }, body: {} },
    { status: 429, headers: { "retry-after": "120" }, body: {} },
    okResponse({ value: ["ok"] }),
  ]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, {
    retry: {
      maxRetryAfterSeconds: 1,
      sleeper: async (delay) => {
        delays.push(delay);
      },
    },
  });
  await client.getJson<{ value: string[] }>("/me/events");
  assert.equal(recorded.requests.length, 3);
  assert.deepEqual(delays, [1000, 1000]); // both capped at 1s
});

test("non-retryable errors are not retried", async () => {
  const recorded = recordingTransport([
    okResponse({ error: { code: "invalidRequest", message: "bad" } }, 400),
  ]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, { retry: { sleeper: async () => { throw new Error("must not sleep"); } } });
  await assert.rejects(client.getJson("/me/events"), (error: unknown) => {
    const graphError = error as Error & { code?: string };
    assert.equal(graphError.code, "invalidRequest");
    return true;
  });
  assert.equal(recorded.requests.length, 1);
});

test("retry stops at maxAttempts and surfaces the final error", async () => {
  const recorded = recordingTransport([
    okResponse({}, 503),
    okResponse({}, 503),
    okResponse({}, 503),
  ]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, {
    retry: { maxAttempts: 3, sleeper: async () => undefined },
  });
  await assert.rejects(client.getJson("/me/events"), /HTTP 503/);
  assert.equal(recorded.requests.length, 3);
});

test("aborted requests are never retried", async () => {
  const controller = new AbortController();
  const recorded = recordingTransport([okResponse({}, 503), okResponse({ value: 1 })]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, { retry: { sleeper: async () => undefined } });
  controller.abort();
  await assert.rejects(client.getJson("/me/events", controller.signal), /cancelled|aborted|AbortError/i);
  assert.equal(recorded.requests.length, 0);
});

test("network transport errors are retried like other transient failures", async () => {
  const recorded = recordingTransport([new Error("ECONNRESET"), okResponse({ ok: true })]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport, { retry: { sleeper: async () => undefined } });
  const result = await client.getJson<{ ok: boolean }>("/me/events");
  assert.equal(result.ok, true);
  assert.equal(recorded.requests.length, 2);
});

test("delta paging follows nextLinks and captures the final deltaLink", async () => {
  const calls: string[] = [];
  const client = new MicrosoftGraphClient(fakeAuth(), {
    send: async (request) => {
      calls.push(request.url);
      if (request.url.includes("page=1")) {
        return okResponse({
          value: [{ id: "a" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/page=2",
        });
      }
      if (request.url.includes("page=2")) {
        return okResponse({
          value: [{ id: "b" }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?$deltatoken=xyz",
        });
      }
      return okResponse({ value: [] });
    },
  });
  const page = await client.getDeltaPages<{ id: string }>("/me/calendarView/delta?page=1");
  assert.deepEqual(page.values.map((entry) => entry.id), ["a", "b"]);
  assert.equal(page.deltaLink, "https://graph.microsoft.com/v1.0/delta?$deltatoken=xyz");
  assert.equal(calls.length, 2);
});

test("invalid page payloads fail closed", async () => {
  const client = new MicrosoftGraphClient(fakeAuth(), {
    send: async () => okResponse({ value: "not-an-array" }),
  });
  await assert.rejects(client.getDeltaPages("/me/events"), /invalid value collection/);
});

test("every Graph request carries the bearer token from the auth provider", async () => {
  const recorded = recordingTransport([okResponse({ ok: true })]);
  const client = new MicrosoftGraphClient(fakeAuth(), recorded.transport);
  await client.getJson("/me");
  assert.equal(recorded.requests[0]?.headers.authorization, "Bearer token-1");
});
