import type { CredentialStore } from "../../security/CredentialStore";
import { MICROSOFT_CREDENTIAL_SERVICE, MICROSOFT_TOKEN_CACHE_ACCOUNT } from "./MicrosoftAuth";

/**
 * Encrypted, OS-backed storage for the Microsoft 365 OAuth session. The whole
 * session (access token, refresh token, expiry, granted scope, account
 * identity) is one opaque blob in the Electron credential vault under
 * userData — never in SQLite, never in DATA_ROOT, never in logs, never in
 * source control. The vault value is re-encrypted with the OS key facility
 * (Windows DPAPI through Electron safeStorage).
 */

export interface MicrosoftAccountIdentity {
  /** Stable Microsoft Graph object id of the signed-in user. */
  accountId: string;
  displayName?: string;
  email?: string;
  userPrincipalName?: string;
}

export interface MicrosoftOAuthSession {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp after which accessToken must not be used. */
  accessTokenExpiresAt: string;
  /** Space-delimited granted scope. */
  scope?: string;
  account?: MicrosoftAccountIdentity;
  updatedAt: string;
}

export interface MicrosoftSessionSnapshot {
  connected: boolean;
  account?: MicrosoftAccountIdentity;
  accessTokenExpiresAt?: string;
  updatedAt?: string;
}

export class MicrosoftSessionCorruptError extends Error {
  public constructor(message = "The stored Microsoft 365 sign-in session is invalid and was removed. Please sign in again.") {
    super(message);
    this.name = "MicrosoftSessionCorruptError";
  }
}

export class MicrosoftTokenSessionStore {
  public constructor(
    private readonly credentialStore: CredentialStore,
    private readonly accountKey = MICROSOFT_TOKEN_CACHE_ACCOUNT,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Reads and decrypts the session; returns null when no session exists. */
  public async read(): Promise<MicrosoftOAuthSession | null> {
    const encoded = await this.credentialStore.get(MICROSOFT_CREDENTIAL_SERVICE, this.accountKey);
    if (encoded === null) {
      return null;
    }
    const session = parseSessionBlob(encoded);
    if (session === null) {
      // Corrupted/foreign blob: fail closed by removing it so nothing can be
      // misread, then treat the account as signed out.
      await this.clear();
      throw new MicrosoftSessionCorruptError();
    }
    if (this.isExpired(session)) {
      return session; // expired sessions still carry the refresh token
    }
    return session;
  }

  public async write(session: MicrosoftOAuthSession): Promise<void> {
    assertSessionShape(session);
    const blob: MicrosoftOAuthSession = {
      ...session,
      updatedAt: this.clock().toISOString(),
    };
    await this.credentialStore.set(MICROSOFT_CREDENTIAL_SERVICE, this.accountKey, JSON.stringify(blob));
  }

  public async clear(): Promise<void> {
    await this.credentialStore.delete(MICROSOFT_CREDENTIAL_SERVICE, this.accountKey);
  }

  public async snapshot(): Promise<MicrosoftSessionSnapshot> {
    let session: MicrosoftOAuthSession | null;
    try {
      session = await this.read();
    } catch (error: unknown) {
      if (error instanceof MicrosoftSessionCorruptError) {
        // A corrupt session means signed out; do not crash status queries.
        return { connected: false };
      }
      throw error;
    }
    if (session === null) {
      return { connected: false };
    }
    const snapshot: MicrosoftSessionSnapshot = {
      connected: true,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      updatedAt: session.updatedAt,
    };
    if (session.account !== undefined) {
      snapshot.account = session.account;
    }
    return snapshot;
  }

  private isExpired(session: MicrosoftOAuthSession): boolean {
    const expiresAt = new Date(session.accessTokenExpiresAt).getTime();
    return !Number.isNaN(expiresAt) && expiresAt <= this.clock().getTime();
  }
}

const SESSION_VERSION = 1;

function assertSessionShape(session: MicrosoftOAuthSession): void {
  if (typeof session.accessToken !== "string" || session.accessToken.length === 0 ||
      typeof session.refreshToken !== "string" || session.refreshToken.length === 0 ||
      typeof session.accessTokenExpiresAt !== "string" ||
      Number.isNaN(new Date(session.accessTokenExpiresAt).getTime())) {
    throw new MicrosoftSessionCorruptError("Refusing to persist an invalid Microsoft 365 OAuth session.");
  }
}

function parseSessionBlob(encoded: string): MicrosoftOAuthSession | null {
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
    const session: MicrosoftOAuthSession = {
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

function parseAccount(value: unknown): MicrosoftAccountIdentity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const accountId = asNonEmptyString(record.accountId);
  if (accountId === undefined) {
    return undefined;
  }
  const account: MicrosoftAccountIdentity = { accountId };
  const displayName = asNonEmptyString(record.displayName);
  const email = asNonEmptyString(record.email);
  const userPrincipalName = asNonEmptyString(record.userPrincipalName);
  if (displayName !== undefined) account.displayName = displayName;
  if (email !== undefined) account.email = email;
  if (userPrincipalName !== undefined) account.userPrincipalName = userPrincipalName;
  return account;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asValidIsoString(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : undefined;
}
