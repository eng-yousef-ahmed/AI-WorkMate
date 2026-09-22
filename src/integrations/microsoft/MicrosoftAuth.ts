import type { CredentialStore } from "../../security/CredentialStore";

export const MICROSOFT_GRAPH_SCOPES = ["User.Read", "Calendars.Read", "offline_access"] as const;
export const MICROSOFT_CREDENTIAL_SERVICE = "microsoft-graph";
export const MICROSOFT_TOKEN_CACHE_ACCOUNT = "msal-token-cache";

export interface MicrosoftAccessToken {
  accessToken: string;
  expiresAt?: string;
  scopes: readonly string[];
}

export interface MicrosoftAuthRequest {
  scopes: readonly string[];
  signal?: AbortSignal;
}

export interface MicrosoftGraphAuthProvider {
  getAccessToken(request: MicrosoftAuthRequest): Promise<MicrosoftAccessToken>;
}

/**
 * Secure MSAL-compatible token-cache boundary. The opaque cache is encrypted by
 * the existing Electron safeStorage credential adapter and is outside DATA_ROOT.
 */
export class CredentialBackedMicrosoftTokenCache {
  public constructor(
    private readonly credentialStore: CredentialStore,
    private readonly account = MICROSOFT_TOKEN_CACHE_ACCOUNT,
  ) {}

  public async read(): Promise<string | null> {
    return this.credentialStore.get(MICROSOFT_CREDENTIAL_SERVICE, this.account);
  }

  public async write(serializedCache: string): Promise<void> {
    await this.credentialStore.set(MICROSOFT_CREDENTIAL_SERVICE, this.account, serializedCache);
  }

  public async clear(): Promise<void> {
    await this.credentialStore.delete(MICROSOFT_CREDENTIAL_SERVICE, this.account);
  }
}

/**
 * Fail-closed auth boundary used until a real OAuth/MSAL desktop flow supplies
 * an auth provider. It never creates fake tokens and never reads DATA_ROOT.
 */
export class MicrosoftAuthenticationRequiredProvider implements MicrosoftGraphAuthProvider {
  public async getAccessToken(_request: MicrosoftAuthRequest): Promise<MicrosoftAccessToken> {
    throw new MicrosoftGraphAuthError(
      "MICROSOFT_AUTHENTICATION_REQUIRED",
      "Microsoft 365 authentication is required before calendar synchronization can contact Microsoft Graph.",
      false,
    );
  }
}

export class MicrosoftGraphAuthError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MicrosoftGraphAuthError";
  }
}
