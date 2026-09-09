import assert from "node:assert/strict";
import { test } from "node:test";

import {
  base64UrlEncode,
  createOAuthState,
  createPkceChallenge,
  createPkcePair,
  createVerifier,
  isValidPkceVerifier,
  secureStringEqual,
} from "../src/integrations/oauth/Pkce";

test("RFC 7636 S256 test vector produces the documented challenge", () => {
  // RFC 7636 Appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(createPkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("PKCE pairs are high-entropy, URL-safe, and self-consistent", () => {
  const first = createPkcePair();
  const second = createPkcePair();
  assert.notEqual(first.verifier, second.verifier);
  assert.notEqual(first.challenge, second.challenge);
  assert.equal(first.verifier.length, 86);
  assert.match(first.verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(first.challenge.length, 43);
  assert.match(first.challenge, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(isValidPkceVerifier(first.verifier), true);
  assert.equal(createPkceChallenge(first.verifier), first.challenge);
});

test("verifiers never contain base64 padding characters", () => {
  for (let index = 0; index < 20; index += 1) {
    assert.equal(createVerifier().includes("="), false);
  }
});

test("OAuth state values are high entropy and distinct", () => {
  const states = new Set(Array.from({ length: 50 }, () => createOAuthState()));
  assert.equal(states.size, 50);
  for (const state of states) {
    assert.match(state, /^[A-Za-z0-9\-._~]+$/);
    assert.ok(state.length >= 32);
  }
});

test("secureStringEqual compares in constant time and rejects mismatches", () => {
  assert.equal(secureStringEqual("same-value", "same-value"), true);
  assert.equal(secureStringEqual("same-value", "same-valuE"), false);
  assert.equal(secureStringEqual("short", "a-longer-value"), false);
  assert.equal(secureStringEqual("", ""), true);
});

test("base64UrlEncode is URL-safe and unpadded", () => {
  assert.equal(base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe])), "-__-");
  assert.equal(base64UrlEncode(Buffer.from("")), "");
  assert.equal(base64UrlEncode(Buffer.from("AI WorkMate")), "QUkgV29ya01hdGU");
});

test("invalid verifiers are rejected when deriving a challenge", () => {
  assert.throws(() => createPkceChallenge("too-short"), /valid PKCE verifier/);
  assert.throws(() => createPkceChallenge("has spaces in the middle of a very long verifier value 1234567890"), /valid PKCE verifier/);
});
