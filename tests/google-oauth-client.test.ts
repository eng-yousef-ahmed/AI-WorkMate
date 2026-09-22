import assert from "node:assert/strict";
import { test } from "node:test";

import { GoogleOAuthClient, GoogleOAuthError, isFatalGoogleRefreshError, googleOAuthErrorFromResponse } from "../src/integrations/google/GoogleOAuthClient";
import { GOOGLE_AUTHORIZATION_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../src/integrations/google/GoogleOAuthConfig";
import type { OAuthFormResponse } from "../src/integrations/oauth/OAuthFormTransport";

const CLIENT_ID = "example.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-secret";
const FIXED_NOW = new Date("2026-09-09T12:00:00.000Z");

function fakeTransport(handler: (url: string, form: Record<string, string>) => OAuthFormResponse): { transport: { postForm: (url: string, form: Record<string, string>) => Promise<OAuthFormResponse> }; calls: Array<{ url: string; form: Record<string, string> }> } {
  const calls: Array<{ url: string; form: Record<string, string> }> = [];
  return {
    transport: {
      postForm: async (url, form) => {
        calls.push({ url, form });
        return handler(url, form);
      },
    },
    calls,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}): OAuthFormResponse {
  return {
    status: 200,
    body: {
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3599,
      scope: "openid email profile https://www.googleapis.com/auth/calendar.readonly",
      token_type: "Bearer",
      id_token: "header.payload.sig",
      ...overrides,
    },
  };
}

test("builds a PKCE authorization URL against Google endpoints with offline access", () => {
  const client = new GoogleOAuthClient({ clientId: CLIENT_ID });
  const url = new URL(client.buildAuthorizationUrl({
    state: "state-1",
    codeChallenge: "challenge-1",
    redirectUri: "http://localhost:43210/",
  }));
  assert.equal(url.origin + url.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:43210/");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.readonly"));
  assert.ok(scopes.includes("openid"));
});

test("exchanges a code without a client secret and sends the PKCE verifier", async () => {
  const harness = fakeTransport(() => tokenResponse());
  const client = new GoogleOAuthClient({ clientId: CLIENT_ID }, { transport: harness.transport, clock: () => FIXED_NOW });

  const granted = await client.exchangeCodeForToken({
    code: "the-code",
    codeVerifier: "the-verifier",
    redirectUri: "http://localhost:43210/",
  });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]?.url, GOOGLE_TOKEN_ENDPOINT);
  const form = harness.calls[0]?.form ?? {};
  assert.equal(form.client_id, CLIENT_ID);
  assert.equal(form.grant_type, "authorization_code");
  assert.equal(form.code, "the-code");
  assert.equal(form.code_verifier, "the-verifier");
  assert.equal("client_secret" in form, false);
  assert.equal(granted.accessToken, "ya29.access");
  assert.equal(granted.refreshToken, "1//refresh");
  assert.equal(granted.accessTokenExpiresAt, "2026-09-09T12:59:59.000Z");
  assert.equal(granted.idToken, "header.payload.sig");
});

test("forwards a configured client secret for maximum compatibility (still non-confidential)", async () => {
  const harness = fakeTransport(() => tokenResponse({ refresh_token: undefined }));
  const client = new GoogleOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { transport: harness.transport });
  await client.exchangeCodeForToken({ code: "c", codeVerifier: "v", redirectUri: "http://localhost:43210/" });
  assert.equal(harness.calls[0]?.form.client_secret, CLIENT_SECRET);
});

test("refreshes through the Google token endpoint", async () => {
  const harness = fakeTransport(() => tokenResponse({ access_token: "ya29.refreshed", refresh_token: undefined }));
  const client = new GoogleOAuthClient({ clientId: CLIENT_ID }, { transport: harness.transport, clock: () => FIXED_NOW });
  const granted = await client.refreshAccessToken({ refreshToken: "1//old", redirectUri: "http://localhost:43210/" });
  assert.equal(harness.calls[0]?.form.grant_type, "refresh_token");
  assert.equal(harness.calls[0]?.form.refresh_token, "1//old");
  assert.equal(granted.accessToken, "ya29.refreshed");
  assert.equal(granted.refreshToken, undefined); // Google may omit it; caller preserves the old one
});

test("maps token endpoint failures to GoogleOAuthError with retryability", () => {
  const transient = googleOAuthErrorFromResponse({ status: 500, body: { error: "backendError", error_description: "try again" } });
  assert.equal(transient.code, "backendError");
  assert.equal(transient.retryable, true);
  assert.equal(transient.description, "try again");

  const denied = googleOAuthErrorFromResponse({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
  assert.equal(denied.status, 400);
  assert.equal(denied.retryable, false);
  assert.equal(isFatalGoogleRefreshError(denied), true);

  const networkLike = new GoogleOAuthError("GOOGLE_OAUTH_NETWORK_ERROR", "unreachable", true, undefined);
  assert.equal(networkLike.retryable, true);
});

test("rejects malformed or missing token payloads and network failures", async () => {
  const malformed = fakeTransport(() => ({ status: 200, body: { token_type: "Bearer" } }));
  const client = new GoogleOAuthClient({ clientId: CLIENT_ID }, { transport: malformed.transport });
  await assert.rejects(
    client.exchangeCodeForToken({ code: "c", codeVerifier: "v", redirectUri: "http://localhost:43210/" }),
    (error: unknown) => error instanceof GoogleOAuthError && error.code === "GOOGLE_OAUTH_MALFORMED_RESPONSE",
  );

  const offline = fakeTransport(() => { throw new Error("ECONNREFUSED"); });
  const offlineClient = new GoogleOAuthClient({ clientId: CLIENT_ID }, { transport: offline.transport });
  await assert.rejects(
    offlineClient.exchangeCodeForToken({ code: "c", codeVerifier: "v", redirectUri: "http://localhost:43210/" }),
    (error: unknown) => error instanceof GoogleOAuthError && error.code === "GOOGLE_OAUTH_NETWORK_ERROR" && error.retryable === true,
  );
});
