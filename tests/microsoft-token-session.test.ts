import assert from "node:assert/strict";
import { test } from "node:test";

import { MICROSOFT_CREDENTIAL_SERVICE, MICROSOFT_TOKEN_CACHE_ACCOUNT } from "../src/integrations/microsoft/MicrosoftAuth";
import {
  MicrosoftSessionCorruptError,
  MicrosoftTokenSessionStore,
  type MicrosoftOAuthSession,
} from "../src/integrations/microsoft/MicrosoftTokenSessionStore";
import { createFakeCredentialStore } from "./helpers";

const FIXED_NOW = "2026-09-09T12:00:00.000Z";

function session(overrides: Partial<MicrosoftOAuthSession> = {}): MicrosoftOAuthSession {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: "2026-09-09T13:00:00.000Z",
    scope: "User.Read Calendars.Read offline_access",
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

test("session round-trips through the credential vault and never touches SQLite", async () => {
  const { store, values } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date(FIXED_NOW));
  await sessionStore.write(session({ account: { accountId: "user-1", displayName: "Ada", email: "ada@example.com" } }));

  const raw = values.get(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`);
  assert.ok(raw);
  const parsed = JSON.parse(raw) as { accessToken?: unknown; refreshToken?: unknown };
  assert.equal(parsed.accessToken, "access-token");
  assert.equal(parsed.refreshToken, "refresh-token");

  const read = await sessionStore.read();
  assert.ok(read);
  assert.equal(read.accessToken, "access-token");
  assert.equal(read.account?.email, "ada@example.com");
  assert.equal(read.updatedAt, FIXED_NOW);

  // Snapshot shape exposes account metadata but never token material.
  const snapshot = await sessionStore.snapshot();
  assert.deepEqual(snapshot, {
    connected: true,
    account: { accountId: "user-1", displayName: "Ada", email: "ada@example.com" },
    accessTokenExpiresAt: "2026-09-09T13:00:00.000Z",
    updatedAt: FIXED_NOW,
  });
  assert.equal(JSON.stringify(snapshot).includes("access-token"), false);
  assert.equal(JSON.stringify(snapshot).includes("refresh-token"), false);
});

test("clear removes the session and status becomes disconnected", async () => {
  const { store } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date(FIXED_NOW));
  await sessionStore.write(session());
  await sessionStore.clear();
  assert.equal(await sessionStore.read(), null);
  assert.deepEqual(await sessionStore.snapshot(), { connected: false });
});

test("expired access tokens are still returned because they carry a refresh token", async () => {
  const { store } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date("2026-09-09T14:00:00.000Z"));
  await sessionStore.write(session({ accessTokenExpiresAt: "2026-09-09T13:00:00.000Z" }));
  const read = await sessionStore.read();
  assert.ok(read);
  assert.equal(read.accessTokenExpiresAt, "2026-09-09T13:00:00.000Z");
});

test("a corrupt session blob is removed and reported", async () => {
  const { store, values } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date(FIXED_NOW));
  values.set(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`, "{not-json");
  await assert.rejects(sessionStore.read(), MicrosoftSessionCorruptError);
  assert.equal(values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), false);
  assert.deepEqual(await sessionStore.snapshot(), { connected: false });
});

test("session blobs with an unsupported shape are rejected and cleared", async () => {
  const { store, values } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date(FIXED_NOW));
  values.set(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`, JSON.stringify({ accessToken: "x" }));
  await assert.rejects(sessionStore.read(), MicrosoftSessionCorruptError);
  assert.equal(values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), false);
});

test("refusing to persist structurally invalid sessions", async () => {
  const { store } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, undefined, () => new Date(FIXED_NOW));
  await assert.rejects(
    sessionStore.write(session({ refreshToken: "" })),
    MicrosoftSessionCorruptError,
  );
  await assert.rejects(
    sessionStore.write(session({ accessTokenExpiresAt: "not-a-date" })),
    MicrosoftSessionCorruptError,
  );
});

test("session store supports a separate account key for provider isolation", async () => {
  const { store, values } = createFakeCredentialStore();
  const sessionStore = new MicrosoftTokenSessionStore(store, "other-account", () => new Date(FIXED_NOW));
  await sessionStore.write(session());
  assert.equal(values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:${MICROSOFT_TOKEN_CACHE_ACCOUNT}`), false);
  assert.ok(values.has(`${MICROSOFT_CREDENTIAL_SERVICE}:other-account`));
  assert.ok(await sessionStore.read());
});
