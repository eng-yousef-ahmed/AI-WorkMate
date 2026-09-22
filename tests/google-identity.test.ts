import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeGoogleIdTokenPayload } from "../src/integrations/google/GoogleIdentity";
import { GOOGLE_OAUTH_AUDIENCE } from "../src/integrations/google/GoogleOAuthConfig";

function makeIdToken(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

test("decodes a valid Google id_token payload into account identity", () => {
  const token = makeIdToken({
    iss: "https://accounts.google.com",
    aud: GOOGLE_OAUTH_AUDIENCE,
    sub: "112233445566778899000",
    email: "ada@gmail.com",
    email_verified: true,
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/a/photo",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const identity = decodeGoogleIdTokenPayload(token);
  assert.deepEqual(identity, {
    accountId: "112233445566778899000",
    email: "ada@gmail.com",
    displayName: "Ada Lovelace",
    pictureUrl: "https://lh3.googleusercontent.com/a/photo",
  });
});

test("unverified emails and foreign audiences are not trusted", () => {
  const unverified = makeIdToken({
    sub: "1", email: "squatter@gmail.com", email_verified: false,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.deepEqual(decodeGoogleIdTokenPayload(unverified), { accountId: "1" });

  const wrongAudience = makeIdToken({
    aud: "some-other-app.apps.googleusercontent.com",
    sub: "2", email: "ada@gmail.com", email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(decodeGoogleIdTokenPayload(wrongAudience), undefined);
});

test("expired or malformed tokens yield no identity", () => {
  const expired = makeIdToken({ sub: "1", exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(decodeGoogleIdTokenPayload(expired), undefined);
  assert.equal(decodeGoogleIdTokenPayload("not-a-jwt"), undefined);
  assert.equal(decodeGoogleIdTokenPayload("a.b"), undefined);
  assert.equal(decodeGoogleIdTokenPayload("a.!!!.c"), undefined);
});
