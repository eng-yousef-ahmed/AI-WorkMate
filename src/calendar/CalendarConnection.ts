/**
 * Provider-agnostic calendar connection boundary. Main-process connection
 * managers (Microsoft 365, Google Calendar) implement these shapes so the
 * desktop wiring and renderer never depend on a specific OAuth provider.
 * Renderer-safe status never contains tokens, codes, or verifiers.
 */

export type CalendarConnectionProvider = "MICROSOFT_GRAPH" | "GOOGLE_CALENDAR";

export interface CalendarConnectionAccount {
  accountId: string;
  displayName?: string;
  email?: string;
}

export interface CalendarConnectionSignInState {
  state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  startedAt: string;
  expiresAt: string;
  error?: { code: string; message: string };
}

export interface CalendarConnectionStatus {
  provider: CalendarConnectionProvider;
  state: "NOT_CONFIGURED" | "CONNECTED" | "DISCONNECTED";
  /** Non-sensitive error code when NOT_CONFIGURED (e.g. missing client id). */
  notConfiguredReason?: string;
  account?: CalendarConnectionAccount;
  /** When the current access token expires (status only; never the token). */
  accessTokenExpiresAt?: string;
  /** Ongoing sign-in, when one is active. */
  signIn?: CalendarConnectionSignInState;
}

export interface BeginCalendarSignInResult {
  flowId: string;
  provider: CalendarConnectionProvider;
  /** URL the user's browser must open to authorize. */
  authorizationUrl: string;
  /** Loopback redirect the provider will send the code to. */
  redirectUri: string;
  startedAt: string;
  expiresAt: string;
  /** True when the desktop app listens for the browser callback. */
  autoCapture: boolean;
}

export interface CompleteCalendarSignInInput {
  flowId: string;
  /** Full redirect URL (or raw query string) the browser landed on. */
  redirectUrl: string;
}

export class CalendarConnectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CalendarConnectionError";
  }
}
