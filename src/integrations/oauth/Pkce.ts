import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 7636 Proof Key for Code Exchange helpers shared by every OAuth
 * provider. The verifier is a high-entropy random value that exists only on
 * this device; the challenge derived from it travels in the authorization
 * URL. No provider-specific code lives here.
 */

export interface PkcePair {
  /** High-entropy, base64url, unpadded (43..128 chars per RFC 7636). */
  verifier: string;
  /** S256 challenge = base64url(SHA-256(verifier)). */
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = createVerifier();
  return { verifier, challenge: createPkceChallenge(verifier) };
}

export function createVerifier(): string {
  return base64UrlEncode(randomBytes(64));
}

export function createPkceChallenge(verifier: string): string {
  if (!isValidPkceVerifier(verifier)) {
    throw new Error("A valid PKCE verifier is required to derive its S256 challenge.");
  }
  return base64UrlEncode(createHash("sha256").update(verifier, "ascii").digest());
}

/** OAuth `state` value: high-entropy, single-use, URL-safe. */
export function createOAuthState(): string {
  return base64UrlEncode(randomBytes(32));
}

export function isValidPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** Unpadded base64url encoding for arbitrary bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time string equality for OAuth state/code comparisons. */
export function secureStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
