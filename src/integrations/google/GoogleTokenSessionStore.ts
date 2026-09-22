import type { CredentialStore } from "../../security/CredentialStore";
import { GOOGLE_CREDENTIAL_SERVICE, GOOGLE_TOKEN_CACHE_ACCOUNT } from "./GoogleAuth";

/**
 * Encrypted, OS-backed storage for the Google Calendar OAuth session. The
 * whole session (access token, refresh token, expiry, granted scope, account
 * identity) is one opaque blob in the Electron credential vault under
 * userData — never in SQLite, never in DATA_ROOT, never in logs, never in
 * source control. The vault value is re-encrypted with the OS key facility
 * (Windows DPAPI through Electron safeStorage).
 */

export interface GoogleAccountIdentity {
  /** Stable Google account id from the id_token / userinfo. */
  accountId: string;
  displayName?: string;
  email?: string;
  /** Google account picture URL (may be presented by the renderer only). */
  pictureUrl?: string;
}

export interface GoogleOAuthSession {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp after which accessToken must not be used. */
  accessTokenExpiresAt: string;
  /** Space-delimited granted scope. */
  scope?: string;
  account?: GoogleAccountIdentity;
  updatedAt: string;
}

export interface GoogleSessionSnapshot {
  connected: boolean;
  account?: GoogleAccountIdentity;
  accessTokenExpiresAt?: string;
  updatedAt?: string;
}

export class GoogleSessionCorruptError extends Error {
  public constructor(message = "The stored Google Calendar sign-in session is invalid and was removed. Please sign in again.") {
    super(message);
    this.name = "GoogleSessionCorruptError";
  }
}

export class GoogleTokenSessionStore {
  public constructor(
    private readonly credentialStore: CredentialStore,
    private readonly accountKey = GOOGLE_TOKEN_CACHE_ACCOUNT,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Reads and decrypts the session; returns null when no session exists. */
  public async read(): Promise<GoogleOAuthSession | null> {
    const encoded = await this.credentialStore.get(GOOGLE_CREDENTIAL_SERVICE, this.accountKey);
    if (encoded === null) {
      return null;
    }
    const session = parseSessionBlob(encoded);
    if (session === null) {
      // Corrupted/foreign blob: fail closed by removing it so nothing can be
      // misread, then treat the account as signed out.
      await this.clear();
      throw new GoogleSessionCorruptError();
    }
    return session;
  }

  public async write(session: GoogleOAuthSession): Promise<void> {
    assertSessionShape(session);
    const blob: GoogleOAuthSession = {
      ...session,
      updatedAt: this.clock().toISOString(),
    };
    await this.credentialStore.set(GOOGLE_CREDENTIAL_SERVICE, this.accountKey, JSON.stringify(blob));
  }

  public async clear(): Promise<void> {
    await this.credentialStore.delete(GOOGLE_CREDENTIAL_SERVICE, this.accountKey);
  }

  public async snapshot(): Promise<GoogleSessionSnapshot> {
    let session: GoogleOAuthSession | null;
    try {
      session = await this.read();
    } catch (error: unknown) {
      if (error instanceof GoogleSessionCorruptError) {
        // A corrupt session means signed out; do not crash status queries.
        return { connected: false };
      }
      throw error;
    }
    if (session === null) {
      return { connected: false };
    }
    const snapshot: GoogleSessionSnapshot = {
      connected: true,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      updatedAt: session.updatedAt,
    };
    if (session.account !== undefined) {
      snapshot.account = session.account;
    }
    return snapshot;
  }
}

const SESSION_VERSION = 1;

function assertSessionShape(session: GoogleOAuthSession): void {
  if (typeof session.accessToken !== "string" || session.accessToken.length === 0 ||
      typeof session.refreshToken !== "string" || session.refreshToken.length === 0 ||
      typeof session.accessTokenExpiresAt !== "string" ||
      Number.isNaN(new Date(session.accessTokenExpiresAt).getTime())) {
    throw new GoogleSessionCorruptError("Refusing to persist an invalid Google Calendar OAuth session.");
  }
}

function parseSessionBlob(encoded: string): GoogleOAuthSession | null {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== undefined && record.version !== SESSION_VERSION) {
      return null;
    }
    const accessToken = asNonEmptyString(record.accessToken);
    const refreshToken = asNonEmptyString(record.refreshToken);
    const accessTokenExpiresAt = asValidIsoString(record.accessTokenExpiresAt);
    const updatedAt = asValidIsoString(record.updatedAt);
    if (accessToken === undefined || refreshToken === undefined || accessTokenExpiresAt === undefined || updatedAt === undefined) {
      return null;
    }
    const session: GoogleOAuthSession = {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      updatedAt,
    };
    if (typeof record.scope === "string" && record.scope.length > 0) {
      session.scope = record.scope;
    }
    const account = parseAccount(record.account);
    if (account !== undefined) {
      session.account = account;
    }
    return session;
  } catch {
    return null;
  }
}

function parseAccount(value: unknown): GoogleAccountIdentity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const accountId = asNonEmptyString(record.accountId);
  if (accountId === undefined) {
    return undefined;
  }
  const account: GoogleAccountIdentity = { accountId };
  const displayName = asNonEmptyString(record.displayName);
  const email = asNonEmptyString(record.email);
  const pictureUrl = asNonEmptyString(record.pictureUrl);
  if (displayName !== undefined) account.displayName = displayName;
  if (email !== undefined) account.email = email;
  if (pictureUrl !== undefined) account.pictureUrl = pictureUrl;
  return account;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asValidIsoString(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : undefined;
}
