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
    // human-readable reason. It never contains the refresh/access token or
    // client secret (those only ever appear in a *successful* response,
    // which we don't touch here), so surfacing it is safe and lets Sync
    // History show the real cause instead of a bare HTTP code.
    // sanitizeMessage() (see errors.ts) still redacts anything
    // credential-shaped as a last resort before this reaches the database,
    // and providerErrorCode (below) gives every caller a clean, structured
    // field to alert/filter on without parsing the free-text message.
    //
    // The two codes that actually show up here mean different things, and
    // this refresh-token grant can only ever surface the first:
    //   - invalid_grant: the refresh token itself is dead - revoked by the
    //     user/admin, or (while the OAuth consent screen is in "Testing")
    //     auto-expired 7 days after it was issued. Fix: mint a new one
    //     (`npm run oauth:google`) and update GOOGLE_REFRESH_TOKEN.
    //   - unauthorized_client / invalid_client: GOOGLE_CLIENT_ID/SECRET
    //     don't match a real, current OAuth client (wrong pair, or the
    //     client secret was rotated in Google Cloud Console since). This
    //     grant type never sends redirect_uri, so it can't itself produce
    //     redirect_uri_mismatch - that only happens during the one-time
    //     authorization step in scripts/google-oauth.ts.
    let errorCode: string | undefined;
    let detail = "";
    try {
      const errBody = (await res.json()) as {
        error?: string;
        error_description?: string;
      };
      errorCode = errBody.error;
      if (errorCode) {
        detail = `: ${errorCode}${
          errBody.error_description ? ` - ${errBody.error_description}` : ""
        }`;
      }
    } catch {
      // Non-JSON body - fall back to the bare status.
    }
    throw new SyncError(
      "auth_error",
      `Google token refresh failed (HTTP ${res.status})${detail}`,
      {
        status: res.status === 400 ? 401 : res.status,
        providerErrorCode: errorCode,
      },
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
