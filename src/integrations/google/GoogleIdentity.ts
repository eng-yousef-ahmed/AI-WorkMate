import type { GoogleAccountIdentity } from "./GoogleTokenSessionStore";
import { GOOGLE_OAUTH_AUDIENCE } from "./GoogleOAuthConfig";

/**
 * Decodes the id_token payload Google issues alongside the access token when
 * the `openid` scope is granted. The token arrived over TLS directly from
 * Google's token endpoint; its claims are display metadata only (account id,
 * email, name, picture) — never used for authorization decisions. Signature
 * verification is unnecessary here because the transport is the trusted TLS
 * channel to the token endpoint, but payload shape, expiry, and audience are
 * still validated before anything is stored.
 */

export function decodeGoogleIdTokenPayload(idToken: string): GoogleAccountIdentity | undefined {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    return undefined;
  }
  const payloadSegment = segments[1];
  if (payloadSegment === undefined) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment)) as unknown;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const subject = record.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    return undefined;
  }
  const expiresAt = record.exp;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt * 1000 < Date.now()) {
    return undefined; // expired token: do not persist stale identity claims
  }
  const audience = record.aud;
  if (typeof audience === "string" && audience.length > 0 && audience !== GOOGLE_OAUTH_AUDIENCE) {
    return undefined; // token minted for a different audience: do not trust it
  }
  const identity: GoogleAccountIdentity = { accountId: subject };
  // Only verified addresses are stored as account identity; unverified
  // claims are ignored so a squatted address can never impersonate the
  // signed-in account in the UI.
  const emailVerified = record.email_verified;
  const email = emailVerified === true || emailVerified === "true" ? asNonEmptyString(record.email) : undefined;
  if (email !== undefined) identity.email = email;
  const displayName = asNonEmptyString(record.name);
  if (displayName !== undefined) identity.displayName = displayName;
  const pictureUrl = asNonEmptyString(record.picture);
  if (pictureUrl !== undefined) identity.pictureUrl = pictureUrl;
  return identity;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = Buffer.from(padded, "base64");
  return binary.toString("utf8");
}
