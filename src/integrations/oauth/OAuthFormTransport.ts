/**
 * Shared form-encoded HTTP transport used by the OAuth token endpoints
 * (Microsoft identity platform, Google OAuth, ...). Only token requests are
 * made over this transport; everything else goes through the provider's own
 * JSON transport. HTTP is injected so tests never touch the network; the
 * production default uses global fetch and never follows redirects (a
 * redirect from a token endpoint is a protocol anomaly and is surfaced as an
 * error by fetch itself).
 */

export interface OAuthFormResponse {
  status: number;
  body: unknown;
}

export interface OAuthFormTransport {
  postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<OAuthFormResponse>;
}

export class FetchOAuthFormTransport implements OAuthFormTransport {
  public async postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<OAuthFormResponse> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      body.set(key, value);
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal,
      redirect: "error",
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  }
}
