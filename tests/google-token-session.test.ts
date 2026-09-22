import assert from "node:assert/strict";
import { test } from "node:test";

import { GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT } from "../src/integrations/google/GoogleAuth";
import { GoogleSessionCorruptError, GoogleTokenSessionStore, type GoogleOAuthSession } from "../src/integrations/google/GoogleTokenSessionStore";
import { createFakeCredentialStore } from "./helpers";

const FIXED_NOW = new Date("2026-09-09T12:00:00.000Z");

function session(overrides: Partial<GoogleOAuthSession> = {}): GoogleOAuthSession {
  return {
    accessToken: "ya29.access",
    refreshToken: "1//refresh",
    accessTokenExpiresAt: "2026-09-09T13:00:00.000Z",
    scope: "openid email profile https://www.googleapis.com/auth/calendar.readonly",
    updatedAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

test("writes, reads, snapshots, and clears an encrypted session blob", async () => {
  const fake = createFakeCredentialStore();
  const store = new GoogleTokenSessionStore(fake.store, undefined, () => FIXED_NOW);
  assert.equal(await store.read(), null);

  await store.write(session());
  const raw = fake.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT);
  assert.ok(raw);
  assert.equal(raw.includes("ya29.access"), true); // vault blobs are encrypted at rest by the OS store

  const stored = await store.read();
  assert.equal(stored?.accessToken, "ya29.access");
  assert.equal(stored?.updatedAt, "2026-09-09T12:00:00.000Z");

  const snapshot = await store.snapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.accessTokenExpiresAt, "2026-09-09T13:00:00.000Z");
  assert.equal("accessToken" in snapshot, false);

  await store.clear();
  assert.equal(await store.read(), null);
  assert.equal((await store.snapshot()).connected, false);
});

test("a corrupt session blob is removed and fails closed with GoogleSessionCorruptError", async () => {
  const fake = createFakeCredentialStore();
  const store = new GoogleTokenSessionStore(fake.store, undefined, () => FIXED_NOW);
  await fake.store.set(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT, "not-json-at-all");
  await assert.rejects(store.read(), GoogleSessionCorruptError);
  assert.equal(await fake.store.get(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT), null);
  assert.equal((await store.snapshot()).connected, false);
});

test("refuses to persist an invalid session and tolerates a future version blob as corrupt", async () => {
  const fake = createFakeCredentialStore();
  const store = new GoogleTokenSessionStore(fake.store, undefined, () => FIXED_NOW);
  await assert.rejects(store.write({ ...session(), accessToken: "" }), GoogleSessionCorruptError);
  await assert.rejects(store.write({ ...session(), refreshToken: "x", accessTokenExpiresAt: "not-a-date" }), GoogleSessionCorruptError);

  const futureBlob = JSON.stringify({ ...session(), version: 99 });
  await fake.store.set(GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT, futureBlob);
  await assert.rejects(store.read(), GoogleSessionCorruptError);
});

test("account identity round-trips through the encrypted session", async () => {
  const fake = createFakeCredentialStore();
  const store = new GoogleTokenSessionStore(fake.store, undefined, () => FIXED_NOW);
  await store.write(session({ account: { accountId: "google-1", displayName: "Ada Lovelace", email: "ada@gmail.com" } }));
  const stored = await store.read();
  assert.deepEqual(stored?.account, { accountId: "google-1", displayName: "Ada Lovelace", email: "ada@gmail.com" });
});
