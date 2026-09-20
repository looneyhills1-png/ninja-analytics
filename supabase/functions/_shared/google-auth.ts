import { SyncError } from "./errors.ts";

// Per-instance cache: an access token is reused across syncs within the same
// warm function instance, never persisted or exposed to the browser/database.
let cached: { token: string; expiresAt: number } | null = null;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Exchange the long-lived refresh token for a short-lived access token (GSC +
 * GA4 share one grant). Throws config_missing if secrets are absent and
 * auth_error if Google rejects the refresh - neither is retried in a loop.
 */
export async function getGoogleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) return cached.token;

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new SyncError(
      "config_missing",
      "Missing Google OAuth credentials (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Google's *error* response to a token request is always
    // {error, error_description} - a standard OAuth error code plus a short
    // human-readable reason (e.g. "invalid_grant" / "Token has been expired
    // or revoked."). It never contains the refresh/access token or client
    // secret (those only ever appear in a *successful* response, which we
    // don't touch here), so surfacing it is safe and lets Sync History show
    // the real cause instead of a bare HTTP code. sanitizeMessage() (see
    // errors.ts) still redacts anything credential-shaped as a last resort
    // before this reaches the database.
    let detail = "";
    try {
      const body = (await res.json()) as {
        error?: string;
        error_description?: string;
      };
      if (body.error) {
        detail = `: ${body.error}${
          body.error_description ? ` - ${body.error_description}` : ""
        }`;
      }
    } catch {
      // Non-JSON body - fall back to the bare status.
    }
    throw new SyncError(
      "auth_error",
      `Google token refresh failed (HTTP ${res.status})${detail}`,
      { status: res.status === 400 ? 401 : res.status },
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new SyncError(
      "auth_error",
      "Google token response had no access_token",
    );
  }

  cached = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** For tests / forced refresh. */
export function clearGoogleTokenCache(): void {
  cached = null;
}
