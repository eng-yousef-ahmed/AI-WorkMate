import assert from "node:assert/strict";
import { test } from "node:test";

import type { MicrosoftOAuthApplicationConfig } from "../src/integrations/microsoft/MicrosoftOAuthConfig";
import { normalizeMicrosoftOAuthConfig } from "../src/integrations/microsoft/MicrosoftOAuthConfig";
import { MICROSOFT_GRAPH_SCOPES } from "../src/integrations/microsoft/MicrosoftAuth";
import {
  extractAadstsCode,
  isFatalMicrosoftRefreshError,
  microsoftOAuthErrorFromResponse,
  MicrosoftOAuthClient,
  type MicrosoftOAuthFormResponse,
  type MicrosoftOAuthTransport,
} from "../src/integrations/microsoft/MicrosoftOAuthClient";

function config(overrides: Partial<MicrosoftOAuthApplicationConfig> = {}): MicrosoftOAuthApplicationConfig {
  return normalizeMicrosoftOAuthConfig({
    clientId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  });
}

function fakeTransport(handler: (url: string, form: Record<string, string>) => MicrosoftOAuthFormResponse): {
  transport: MicrosoftOAuthTransport;
  lastForm: () => Record<string, string> | undefined;
  lastUrl: () => string | undefined;
} {
  let lastFormValue: Record<string, string> | undefined;
  let lastUrlValue: string | undefined;
  return {
    transport: {
      postForm: async (url, form) => {
        lastUrlValue = url;
        lastFormValue = { ...form };
        return handler(url, form);
      },
    },
    lastForm: () => lastFormValue,
    lastUrl: () => lastUrlValue,
  };
}

test("authorization URL carries PKCE, least-privilege scopes, and state", () => {
  const client = new MicrosoftOAuthClient(config());
  const url = new URL(
    client.buildAuthorizationUrl({
      state: "state-123",
      codeChallenge: "challenge-456",
      redirectUri: "http://localhost:44123/",
      prompt: "select_account",
    }),
  );
  assert.equal(url.hostname, "login.microsoftonline.com");
  assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("client_id"), "11111111-1111-4111-8111-111111111111");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:44123/");
  assert.equal(url.searchParams.get("response_mode"), "query");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-456");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  const scope = url.searchParams.get("scope");
  assert.ok(scope);
  assert.equal(scope, MICROSOFT_GRAPH_SCOPES.join(" "));
  assert.equal(scope?.includes("Calendars.ReadWrite"), false);
  assert.equal(scope?.includes("Mail.Read"), false);
  assert.equal(scope?.includes("Files.Read"), false);
  assert.equal(scope?.includes("OnlineMeetings.Read"), false);
});

test("tenant can be organizations or a GUID; URL is tenant-scoped", () => {
  const client = new MicrosoftOAuthClient(config({ tenant: "organizations" }));
  assert.match(client.buildAuthorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "http://localhost:1/" }), /\/organizations\//);
  const tenantClient = new MicrosoftOAuthClient(config({ tenant: "22222222-2222-4222-8222-222222222222" }));
  assert.match(
    tenantClient.buildAuthorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "http://localhost:1/" }),
    /\/22222222-2222-4222-8222-222222222222\//,
  );
});

test("invalid client id and tenant values are rejected", () => {
  assert.throws(() => normalizeMicrosoftOAuthConfig({ clientId: "bad client id with spaces" }), /client/);
  assert.throws(() => normalizeMicrosoftOAuthConfig({ tenant: "tenant with spaces" }), /tenant/);
  assert.throws(() => normalizeMicrosoftOAuthConfig({ tenant: "https://evil.example" }), /tenant/);
  assert.throws(() => normalizeMicrosoftOAuthConfig({ redirectUri: "https://not-localhost.example/cb" }), /redirect URI/i);
  assert.deepEqual(normalizeMicrosoftOAuthConfig({}), {});
});

test("code exchange posts the verifier and returns a grant with expiry", async () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  const recorded = fakeTransport(() => ({
    status: 200,
    body: {
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_in: 3600,
      scope: "User.Read Calendars.Read offline_access",
      token_type: "Bearer",
    },
  }));
  const client = new MicrosoftOAuthClient(config(), { transport: recorded.transport, clock: () => now });
  const granted = await client.exchangeCodeForToken({
    code: "the-code",
    codeVerifier: "the-verifier",
    redirectUri: "http://localhost:44123/",
  });
  assert.equal(granted.accessToken, "access-token-1");
  assert.equal(granted.refreshToken, "refresh-token-1");
  assert.equal(granted.accessTokenExpiresAt, "2026-09-09T13:00:00.000Z");
  assert.equal(granted.scope, "User.Read Calendars.Read offline_access");

  const form = recorded.lastForm();
  assert.ok(form);
  assert.equal(form.grant_type, "authorization_code");
  assert.equal(form.code, "the-code");
  assert.equal(form.code_verifier, "the-verifier");
  assert.equal(form.redirect_uri, "http://localhost:44123/");
  assert.equal(form.client_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(form.scope, "User.Read Calendars.Read offline_access");
  assert.equal(recorded.lastUrl(), "https://login.microsoftonline.com/common/oauth2/v2.0/token");
});

test("refresh posts the refresh token without a client secret", async () => {
  const recorded = fakeTransport(() => ({
    status: 200,
    body: { access_token: "access-token-2", refresh_token: "refresh-token-2", expires_in: 3600, token_type: "Bearer" },
  }));
  const client = new MicrosoftOAuthClient(config(), { transport: recorded.transport });
  const granted = await client.refreshAccessToken({
    refreshToken: "old-refresh-token",
    redirectUri: "http://localhost:44123/",
  });
  assert.equal(granted.accessToken, "access-token-2");
  const form = recorded.lastForm();
  assert.ok(form);
  assert.equal(form.grant_type, "refresh_token");
  assert.equal(form.refresh_token, "old-refresh-token");
  assert.equal(Object.hasOwn(form, "client_secret"), false);
});

test("token endpoint errors map to typed OAuth errors", () => {
  const recorded = fakeTransport(() => ({
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "AADSTS700082: The refresh token has expired due to inactivity. Trace ID: abc",
    },
  }));
  const client = new MicrosoftOAuthClient(config(), { transport: recorded.transport });
  void client;
  const error = microsoftOAuthErrorFromResponse({
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
    },
  });
  assert.equal(error.code, "invalid_grant");
  assert.equal(error.retryable, false);
  assert.equal(error.status, 400);
  assert.equal(extractAadstsCode(error.description), "AADSTS700082");
  assert.equal(isFatalMicrosoftRefreshError(error), true);
  void recorded;
});

test("transient OAuth failures are retryable and fatal ones are not", () => {
  assert.equal(microsoftOAuthErrorFromResponse({ status: 500, body: {} }).retryable, true);
  assert.equal(microsoftOAuthErrorFromResponse({ status: 503, body: {} }).retryable, true);
  assert.equal(microsoftOAuthErrorFromResponse({ status: 429, body: {} }).retryable, true);
  const transient = microsoftOAuthErrorFromResponse({
    status: 400,
    body: { error: "temporarily_unavailable", error_description: "server busy" },
  });
  assert.equal(transient.retryable, false);
  const fatal = microsoftOAuthErrorFromResponse({
    status: 400,
    body: { error: "invalid_grant", error_description: "AADSTS700082 expired" },
  });
  assert.equal(isFatalMicrosoftRefreshError(fatal), true);
  const plainGrant = microsoftOAuthErrorFromResponse({
    status: 400,
    body: { error: "invalid_grant", error_description: "AADSTS50076: re-auth required" },
  });
  assert.equal(isFatalMicrosoftRefreshError(plainGrant), true);
  const unknownGrant = microsoftOAuthErrorFromResponse({
    status: 400,
    body: { error: "invalid_grant", error_description: "something unusual happened" },
  });
  // Unknown invalid_grant descriptions are treated as fatal so the app asks
  // the user to sign in again rather than retrying forever.
  assert.equal(isFatalMicrosoftRefreshError(unknownGrant), true);
});

test("network failures surface as retryable OAuth errors", async () => {
  const client = new MicrosoftOAuthClient(config(), {
    transport: {
      postForm: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  });
  await assert.rejects(
    client.refreshAccessToken({ refreshToken: "x", redirectUri: "http://localhost:1/" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const oauthError = error as Error & { code?: string; retryable?: boolean };
      assert.equal(oauthError.code, "MICROSOFT_OAUTH_NETWORK_ERROR");
      assert.equal(oauthError.retryable, true);
      return true;
    },
  );
});

test("malformed token responses fail closed", async () => {
  const client = new MicrosoftOAuthClient(config(), {
    transport: {
      postForm: async () => ({ status: 200, body: { token_type: "Bearer" } }),
    },
  });
  await assert.rejects(
    client.exchangeCodeForToken({ code: "c", codeVerifier: "v", redirectUri: "http://localhost:1/" }),
    /no access token/,
  );
});
