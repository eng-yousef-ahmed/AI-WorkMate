import assert from "node:assert/strict";
import { test } from "node:test";

import { CalendarConnectionError } from "../src/calendar/CalendarConnection";
import type { CalendarEventProvider } from "../src/calendar/CalendarModels";
import { GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT } from "../src/integrations/google/GoogleAuth";
import { GoogleCalendarConnection } from "../src/integrations/google/GoogleCalendarConnection";
import { GoogleApiError, type GoogleApiRequest, type GoogleApiResponse } from "../src/integrations/google/GoogleApiClient";
import { GoogleSessionCorruptError } from "../src/integrations/google/GoogleTokenSessionStore";
import { GOOGLE_AUTHORIZATION_ENDPOINT } from "../src/integrations/google/GoogleOAuthConfig";
import type { OAuthFormResponse } from "../src/integrations/oauth/OAuthFormTransport";
import { createDispatchableLoopbackFactory, createFakeCredentialStore } from "./helpers";

const CLIENT_ID = "example.apps.googleusercontent.com";

function idToken(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ iss: "https://accounts.google.com", aud: "accounts.google.com", exp: Math.floor(Date.now() / 1000) + 3600, ...payload })}.sig`;
}

function tokenResponse(overrides: Record<string, unknown> = {}): OAuthFormResponse {
  return {
    status: 200,
    body: {
      access_token: "ya29.access-1",
      refresh_token: "1//refresh-1",
      expires_in: 3599,
      scope: "openid email profile https://www.googleapis.com/auth/calendar.readonly",
      token_type: "Bearer",
      id_token: idToken({ sub: "google-user-1", email: "ada@gmail.com", email_verified: true, name: "Ada Lovelace" }),
      ...overrides,
    },
  };
}

function connectionHarness(options: {
  oauth?: { postForm: (url: string, form: Record<string, string>) => Promise<OAuthFormResponse> };
  api?: { send: (request: GoogleApiRequest) => Promise<GoogleApiResponse> };
  clientId?: string;
  clock?: () => Date;
} = {}) {
  const credentials = createFakeCredentialStore();
  const loopback = createDispatchableLoopbackFactory();
  const oauthForms: Array<{ url: string; form: Record<string, string> }> = [];
  const apiRequests: GoogleApiRequest[] = [];
  const oauthTransport = options.oauth ?? {
    postForm: async (url: string, form: Record<string, string>) => {
      oauthForms.push({ url, form });
      if (form.grant_type === "authorization_code") return tokenResponse();
      if (form.grant_type === "refresh_token") return tokenResponse({ access_token: "ya29.refreshed" });
      return { status: 400, body: { error: "unsupported_grant_type" } };
    },
  };
  const apiTransport = options.api ?? {
    send: async (request: GoogleApiRequest) => {
      apiRequests.push(request);
      return { status: 200, headers: {}, body: { items: [] } } satisfies GoogleApiResponse;
    },
  };
  const connection = new GoogleCalendarConnection({
    config: { clientId: options.clientId ?? CLIENT_ID },
    credentialStore: credentials.store,
    clock: options.clock ?? (() => new Date("2026-09-09T12:00:00.000Z")),
    oauthTransport,
    apiTransport,
    loopbackListenerFactory: loopback.listenerFactory,
  });
  return { connection, credentials, loopback, oauthForms, apiRequests };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("condition not reached in time");
}

async function completeSignIn(connection: GoogleCalendarConnection, flowId: string, state: string, code = "the-code"): Promise<void> {
  const status = await connection.completeSignIn({
    flowId,
    redirectUrl: `http://localhost:41730/?code=${code}&state=${encodeURIComponent(state)}`,
  });
  assert.equal(status.state, "CONNECTED");
}

test("beginSignIn builds a Google PKCE URL and captures the loopback callback end-to-end", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  assert.equal(begin.provider, "GOOGLE_CALENDAR");
  assert.equal(begin.autoCapture, true);
  assert.equal(begin.expiresAt > "2026-09-09T12:00:00.000Z", true);

  const url = new URL(begin.authorizationUrl);
  assert.equal(url.origin + url.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  const state = url.searchParams.get("state") as string;
  const challenge = url.searchParams.get("code_challenge") as string;
  assert.ok(state);
  assert.ok(challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile https://www.googleapis.com/auth/calendar.readonly");

  const listener = harness.loopback.created;
  assert.ok(listener);
  const response = listener.dispatch({ url: `/?code=the-code&state=${encodeURIComponent(state)}`, host: "localhost:41730" });
  assert.equal(response.status, 200);

  await waitFor(async () => (await harness.connection.getStatus()).state === "CONNECTED");

  const exchange = harness.oauthForms.find((entry) => entry.form.grant_type === "authorization_code");
  assert.ok(exchange);
  assert.equal(exchange.form.code, "the-code");
  assert.ok(exchange.form.code_verifier);
  assert.equal(exchange.form.client_id, CLIENT_ID);
  assert.equal("client_secret" in exchange.form, false);

  const status = await harness.connection.getStatus();
  assert.equal(status.state, "CONNECTED");
  assert.equal(status.account?.email, "ada@gmail.com");
  assert.equal(status.account?.displayName, "Ada Lovelace");
  assert.equal(status.account?.accountId, "google-user-1");
});

test("rejects mismatched state, denied callbacks, missing codes, and unknown flows", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;

  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin.flowId, redirectUrl: "http://localhost:41730/?code=x&state=wrong-state" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_STATE_MISMATCH",
  );

  const begin2 = await harness.connection.beginSignIn();
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin2.flowId, redirectUrl: `http://localhost:41730/?error=access_denied&state=${encodeURIComponent(state)}` }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_DENIED",
  );

  const begin3 = await harness.connection.beginSignIn();
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin3.flowId, redirectUrl: "http://localhost:41730/?state=only-state" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_INVALID_CALLBACK",
  );

  await assert.rejects(
    harness.connection.completeSignIn({ flowId: "unknown-flow", redirectUrl: "http://localhost/?code=x&state=y" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_FLOW_NOT_FOUND",
  );
});

test("manual completion persists an encrypted session with account identity; disconnect clears it", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;
  await completeSignIn(harness.connection, begin.flowId, state);

  const raw = harness.credentials.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT);
  assert.ok(raw);
  assert.equal(raw.includes("ya29.access-1"), true);

  const afterDisconnect = await harness.connection.disconnect();
  assert.equal(afterDisconnect.state, "DISCONNECTED");
  assert.equal(harness.credentials.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT), undefined);
});

test("a corrupt vault blob is removed on read and status reports DISCONNECTED", async () => {
  const harness = connectionHarness();
  await harness.credentials.store.set(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT, "{corrupt");
  const sessionStore = (harness.connection as unknown as { sessionStore: { read(): Promise<unknown> } }).sessionStore;
  await assert.rejects(sessionStore.read(), GoogleSessionCorruptError);
  assert.equal(harness.credentials.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT), undefined);
  assert.equal((await harness.connection.getStatus()).state, "DISCONNECTED");
});

test("exchange failures surface as GOOGLE_SIGNIN_EXCHANGE_FAILED and never store a session", async () => {
  const harness = connectionHarness({
    oauth: { postForm: async () => ({ status: 400, body: { error: "invalid_grant", error_description: "code expired" } }) },
  });
  const begin = await harness.connection.beginSignIn();
  const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin.flowId, redirectUrl: `http://localhost:41730/?code=bad&state=${encodeURIComponent(state)}` }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_EXCHANGE_FAILED",
  );
  assert.equal(harness.credentials.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT), undefined);
});

test("without offline access the sign-in is refused", async () => {
  const harness = connectionHarness({
    oauth: { postForm: async () => tokenResponse({ refresh_token: undefined }) },
  });
  const begin = await harness.connection.beginSignIn();
  const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin.flowId, redirectUrl: `http://localhost:41730/?code=c&state=${encodeURIComponent(state)}` }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_NO_REFRESH_TOKEN",
  );
});

test("expired flows and missing client ids fail clearly", async () => {
  let now = new Date("2026-09-09T12:00:00.000Z");
  const harness = connectionHarness({ clock: () => now });
  const begin = await harness.connection.beginSignIn();
  now = new Date("2026-09-09T12:06:00.000Z"); // past the 5-minute window
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin.flowId, redirectUrl: "http://localhost:41730/?code=c&state=s" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_SIGNIN_EXPIRED",
  );

  const unconfigured = connectionHarness({ clientId: "" });
  assert.equal((await unconfigured.connection.getStatus()).state, "NOT_CONFIGURED");
  await assert.rejects(
    unconfigured.connection.beginSignIn(),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "GOOGLE_CLIENT_NOT_CONFIGURED",
  );
});

test("createCalendarProvider fails closed without a session and serves events once signed in", async () => {
  const harness = connectionHarness();
  await assert.rejects(
    harness.connection.createCalendarProvider().listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" }),
    (error: unknown) => error instanceof GoogleApiError && error.code === "GOOGLE_AUTHENTICATION_REQUIRED",
  );

  const sessionHarness = connectionHarness();
  const begin = await sessionHarness.connection.beginSignIn();
  const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;
  await completeSignIn(sessionHarness.connection, begin.flowId, state);

  // A signed-in provider fetches through the injected API transport.
  const apiCalls: GoogleApiRequest[] = [];
  const apiHarness = connectionHarness({
    api: {
      send: async (request) => {
        apiCalls.push(request);
        if (request.url.includes("calendars/primary/events")) {
          return {
            status: 200,
            headers: {},
            body: {
              items: [{
                id: "evt-1",
                status: "confirmed",
                summary: "From Google",
                start: { dateTime: "2026-09-10T09:00:00Z" },
                end: { dateTime: "2026-09-10T10:00:00Z" },
              }],
            },
          };
        }
        return { status: 404, headers: {}, body: { error: { code: 404, message: "not found" } } };
      },
    },
  });
  const begin2 = await apiHarness.connection.beginSignIn();
  const state2 = new URL(begin2.authorizationUrl).searchParams.get("state") as string;
  await completeSignIn(apiHarness.connection, begin2.flowId, state2);
  const provider: CalendarEventProvider = apiHarness.connection.createCalendarProvider();
  const deltaProvider = provider as CalendarEventProvider & { getDelta: (request: { startTime: string; endTime: string; deltaLink?: string }) => Promise<unknown> };

  const events = await provider.listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, "From Google");
  assert.equal(events[0]?.provider, "GOOGLE_CALENDAR");
  assert.equal(apiCalls.length, 1);

  // Delta path exists on the same facade (no cursor → windowed full request).
  await assert.doesNotReject(deltaProvider.getDelta({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" }));
  assert.equal(apiCalls.length, 2);
});
