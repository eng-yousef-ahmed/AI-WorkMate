import assert from "node:assert/strict";
import { test } from "node:test";

import { CalendarConnectionError } from "../src/calendar/CalendarConnection";
import { MICROSOFT_CREDENTIAL_SERVICE, MICROSOFT_TOKEN_CACHE_ACCOUNT } from "../src/integrations/microsoft/MicrosoftAuth";
import { MicrosoftCalendarConnection } from "../src/integrations/microsoft/MicrosoftCalendarConnection";
import type { MicrosoftOAuthFormResponse, MicrosoftOAuthTransport } from "../src/integrations/microsoft/MicrosoftOAuthClient";
import { createPkceChallenge } from "../src/integrations/oauth/Pkce";
import type { MicrosoftGraphRequest, MicrosoftGraphTransport } from "../src/integrations/microsoft/MicrosoftGraphClient";
import { createDispatchableLoopbackFactory, createFakeCredentialStore } from "./helpers";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_NOW = new Date("2026-09-09T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-09-09T12:00:00.000Z";

function tokenResponse(overrides: Record<string, unknown> = {}): MicrosoftOAuthFormResponse {
  return {
    status: 200,
    body: {
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_in: 3600,
      scope: "User.Read Calendars.Read offline_access",
      token_type: "Bearer",
      ...overrides,
    },
  };
}

function connectionHarness(options: {
  oauth?: MicrosoftOAuthTransport;
  graph?: MicrosoftGraphTransport;
  clientId?: string;
  configOverrides?: Record<string, string>;
} = {}) {
  const credentials = createFakeCredentialStore();
  const loopback = createDispatchableLoopbackFactory();
  const oauthForms: Array<{ url: string; form: Record<string, string> }> = [];
  const graphRequests: MicrosoftGraphRequest[] = [];
  const oauthTransport: MicrosoftOAuthTransport = options.oauth ?? {
    postForm: async (url, form) => {
      oauthForms.push({ url, form });
      if (form.grant_type === "authorization_code") {
        return tokenResponse();
      }
      if (form.grant_type === "refresh_token") {
        return tokenResponse({ access_token: "access-token-refreshed", refresh_token: "refresh-token-refreshed" });
      }
      return { status: 400, body: { error: "unsupported_grant_type" } };
    },
  };
  const graphTransport: MicrosoftGraphTransport = options.graph ?? {
    send: async (request) => {
      graphRequests.push(request);
      if (request.url.includes("/me?")) {
        return {
          status: 200,
          headers: {},
          body: { id: "user-42", displayName: "Ada Lovelace", mail: "ada@example.com", userPrincipalName: "ada@example.com" },
        };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
  };
  const connection = new MicrosoftCalendarConnection({
    config: {
      clientId: options.clientId ?? CLIENT_ID,
      ...options.configOverrides,
    },
    credentialStore: credentials.store,
    clock: () => FIXED_NOW,
    oauthTransport,
    graphTransport,
    loopbackListenerFactory: loopback.listenerFactory,
  });
  return { connection, credentials, loopback, oauthForms, graphRequests };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("condition not reached in time");
}

test("beginSignIn builds a PKCE authorization URL and captures the loopback callback end-to-end", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  assert.equal(begin.provider, "MICROSOFT_GRAPH");
  assert.equal(begin.autoCapture, true);
  assert.equal(begin.redirectUri, "http://localhost:41730/");
  assert.equal(begin.expiresAt > FIXED_NOW_ISO, true);

  const url = new URL(begin.authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:41730/");
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  assert.ok(state);
  assert.ok(challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "User.Read Calendars.Read offline_access");
  assert.equal(url.searchParams.get("response_mode"), "query");

  // Simulate the browser redirect arriving at the loopback listener.
  const listener = harness.loopback.created;
  assert.ok(listener);
  const response = listener.dispatch({ url: `/?code=the-auth-code&state=${encodeURIComponent(state)}`, host: "localhost:41730" });
  assert.equal(response.status, 200);

  await waitFor(async () => (await harness.connection.getStatus()).state === "CONNECTED");

  // The token request used the PKCE verifier matching the URL challenge.
  const exchange = harness.oauthForms.find((entry) => entry.form.grant_type === "authorization_code");
  assert.ok(exchange);
  assert.equal(exchange.form.code, "the-auth-code");
  assert.equal(exchange.form.client_id, CLIENT_ID);
  assert.equal(createPkceChallenge(exchange.form.code_verifier ?? ""), challenge);

  const status = await harness.connection.getStatus();
  assert.equal(status.state, "CONNECTED");
  assert.equal(status.provider, "MICROSOFT_GRAPH");
  assert.deepEqual(status.account, { accountId: "user-42", displayName: "Ada Lovelace", email: "ada@example.com" });
  assert.equal(status.signIn, undefined);
  assert.equal(JSON.stringify(status).includes("access-token"), false);
  assert.equal(JSON.stringify(status).includes("refresh-token"), false);

  // The account fetch used the freshly granted access token.
  const meRequest = harness.graphRequests.find((request) => request.url.includes("/me?"));
  assert.ok(meRequest);
  assert.equal(meRequest.headers.authorization, "Bearer access-token-1");
  assert.equal(harness.loopback.closeCalls >= 1, true);
});

test("a manually pasted redirect URL completes the sign-in with state validation", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const url = new URL(begin.authorizationUrl);
  const state = url.searchParams.get("state") as string;

  const status = await harness.connection.completeSignIn({
    flowId: begin.flowId,
    redirectUrl: `http://localhost:41730/?code=manual-code&state=${encodeURIComponent(state)}`,
  });
  assert.equal(status.state, "CONNECTED");
  assert.equal(harness.oauthForms.some((entry) => entry.form.code === "manual-code"), true);
});

test("sign-in rejects a mismatched state and never exchanges the code", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  await assert.rejects(
    harness.connection.completeSignIn({
      flowId: begin.flowId,
      redirectUrl: "http://localhost:41730/?code=evil-code&state=attacker-state",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CalendarConnectionError);
      assert.equal(error.code, "MICROSOFT_SIGNIN_STATE_MISMATCH");
      return true;
    },
  );
  assert.equal(harness.oauthForms.length, 0);
  const status = await harness.connection.getStatus();
  assert.equal(status.state, "DISCONNECTED");
  assert.equal(status.signIn?.state, "FAILED");
  assert.equal(status.signIn?.error?.code, "MICROSOFT_SIGNIN_STATE_MISMATCH");
  await harness.connection.cancelSignIn();
});

test("sign-in rejects provider denials and missing state", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: begin.flowId, redirectUrl: "http://localhost:41730/?error=access_denied" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "MICROSOFT_SIGNIN_DENIED",
  );
  const beginAgain = await harness.connection.beginSignIn();
  await assert.rejects(
    harness.connection.completeSignIn({ flowId: beginAgain.flowId, redirectUrl: "http://localhost:41730/?code=no-state-code" }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "MICROSOFT_SIGNIN_STATE_MISSING",
  );
  await harness.connection.cancelSignIn();
});

test("sign-in fails cleanly when Microsoft returns no refresh token", async () => {
  const harness = connectionHarness({
    oauth: {
      postForm: async () => tokenResponse({ refresh_token: undefined }),
    },
  });
  const begin = await harness.connection.beginSignIn();
  const url = new URL(begin.authorizationUrl);
  const state = url.searchParams.get("state") as string;
  await assert.rejects(
    harness.connection.completeSignIn({
      flowId: begin.flowId,
      redirectUrl: `http://localhost:41730/?code=code-no-offline&state=${encodeURIComponent(state)}`,
    }),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "MICROSOFT_SIGNIN_NO_REFRESH_TOKEN",
  );
  const status = await harness.connection.getStatus();
  assert.equal(status.state, "DISCONNECTED");
  await harness.connection.cancelSignIn();
});

test("disconnect clears the vault and pending flows", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const url = new URL(begin.authorizationUrl);
  const state = url.searchParams.get("state") as string;
  await harness.connection.completeSignIn({
    flowId: begin.flowId,
    redirectUrl: `http://localhost:41730/?code=c&state=${encodeURIComponent(state)}`,
  });
  assert.equal((await harness.connection.getStatus()).state, "CONNECTED");

  const status = await harness.connection.disconnect();
  assert.equal(status.state, "DISCONNECTED");
  assert.equal(harness.credentials.values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), false);
});

test("status reports NOT_CONFIGURED before a client id is entered", async () => {
  const harness = connectionHarness({ clientId: "" });
  const status = await harness.connection.getStatus();
  assert.equal(status.state, "NOT_CONFIGURED");
  assert.equal(status.notConfiguredReason, "MICROSOFT_CLIENT_NOT_CONFIGURED");
  await assert.rejects(harness.connection.beginSignIn(), (error: unknown) => {
    assert.ok(error instanceof CalendarConnectionError);
    assert.equal(error.code, "MICROSOFT_CLIENT_NOT_CONFIGURED");
    return true;
  });
});

test("beginSignIn rejects flows that lack a loopback redirect", async () => {
  const harness = connectionHarness({ configOverrides: { redirectUri: "https://app.example.com/callback" } });
  await assert.rejects(
    harness.connection.beginSignIn(),
    (error: unknown) => error instanceof CalendarConnectionError && error.code === "MICROSOFT_OAUTH_INVALID_REDIRECT_URI",
  );
});

test("expired sessions refresh through the token endpoint with single-flight", async () => {
  const harness = connectionHarness();
  // Expire the stored session by writing an old one directly into the vault.
  const vault = harness.credentials.values;
  const session = {
    accessToken: "stale-access-token",
    refreshToken: "stale-refresh-token",
    accessTokenExpiresAt: "2026-09-09T10:00:00.000Z",
    scope: "User.Read Calendars.Read offline_access",
    updatedAt: "2026-09-09T10:00:00.000Z",
  };
  vault.set(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`, JSON.stringify(session));

  const authenticator = harness.connection.createAuthenticator();
  const token = await authenticator.getAccessToken({ scopes: ["User.Read", "Calendars.Read"] });
  assert.equal(token.accessToken, "access-token-refreshed");
  const refreshed = JSON.parse(vault.get(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`) as string) as {
    refreshToken: string;
  };
  assert.equal(refreshed.refreshToken, "refresh-token-refreshed");
});

test("a fatal refresh failure clears the session and fails closed", async () => {
  const harness = connectionHarness({
    oauth: {
      postForm: async () => ({
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
        },
      }),
    },
  });
  harness.credentials.values.set(
    `${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`,
    JSON.stringify({
      accessToken: "stale",
      refreshToken: "stale-refresh",
      accessTokenExpiresAt: "2026-09-09T10:00:00.000Z",
      scope: "User.Read Calendars.Read offline_access",
      updatedAt: "2026-09-09T10:00:00.000Z",
    }),
  );
  const authenticator = harness.connection.createAuthenticator();
  await assert.rejects(
    authenticator.getAccessToken({ scopes: ["User.Read"] }),
    (error: unknown) => {
      const graphAuthError = error as Error & { code?: string };
      assert.equal(graphAuthError.code, "MICROSOFT_AUTHENTICATION_REQUIRED");
      return true;
    },
  );
  assert.equal(harness.credentials.values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), false);
  const status = await harness.connection.getStatus();
  assert.equal(status.state, "DISCONNECTED");
});

test("transient refresh failures keep the session for a later retry", async () => {
  const harness = connectionHarness({
    oauth: {
      postForm: async () => ({ status: 503, body: {} }),
    },
  });
  harness.credentials.values.set(
    `${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`,
    JSON.stringify({
      accessToken: "stale",
      refreshToken: "stale-refresh",
      accessTokenExpiresAt: "2026-09-09T10:00:00.000Z",
      scope: "User.Read Calendars.Read offline_access",
      updatedAt: "2026-09-09T10:00:00.000Z",
    }),
  );
  const authenticator = harness.connection.createAuthenticator();
  await assert.rejects(
    authenticator.getAccessToken({ scopes: ["User.Read"] }),
    (error: unknown) => {
      const graphAuthError = error as Error & { code?: string; retryable?: boolean };
      assert.equal(graphAuthError.code, "MICROSOFT_TOKEN_REFRESH_FAILED");
      assert.equal(graphAuthError.retryable, true);
      return true;
    },
  );
  assert.equal(harness.credentials.values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), true);
  const status = await harness.connection.getStatus();
  assert.equal(status.state, "CONNECTED"); // session still present for retry
});

test("fresh sessions serve the cached access token without network calls", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const url = new URL(begin.authorizationUrl);
  const state = url.searchParams.get("state") as string;
  await harness.connection.completeSignIn({
    flowId: begin.flowId,
    redirectUrl: `http://localhost:41730/?code=c&state=${encodeURIComponent(state)}`,
  });
  const authenticator = harness.connection.createAuthenticator();
  const token = await authenticator.getAccessToken({ scopes: ["User.Read"] });
  assert.equal(token.accessToken, "access-token-1");
  const refreshAttempts = harness.oauthForms.filter((entry) => entry.form.grant_type === "refresh_token");
  assert.equal(refreshAttempts.length, 0);
});

test("provider assembly fails closed when signed out", async () => {
  const harness = connectionHarness();
  const provider = harness.connection.createCalendarProvider();
  await assert.rejects(
    provider.listEvents({ startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z" }),
    (error: unknown) => {
      const graphError = error as Error & { code?: string };
      assert.equal(graphError.code, "MICROSOFT_AUTHENTICATION_REQUIRED");
      return true;
    },
  );
});

test("loopback callback expiry is reflected in status while sign-in is pending", async () => {
  const harness = connectionHarness();
  const begin = await harness.connection.beginSignIn();
  const status = await harness.connection.getStatus();
  assert.equal(status.signIn?.state, "IN_PROGRESS");
  assert.equal(status.signIn?.expiresAt, begin.expiresAt);
  assert.equal(status.state, "DISCONNECTED");
  await harness.connection.cancelSignIn();
});
