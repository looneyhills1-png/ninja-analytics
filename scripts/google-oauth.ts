/**
 * One-time (or renew-when-it-dies) helper to mint a Google OAuth refresh
 * token for the GSC + GA4 background syncs. Run locally:
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run oauth:google
 *
 * Prerequisites in Google Cloud Console (one-time setup):
 *   - Enable the Search Console API and the Google Analytics Data API.
 *   - Configure the OAuth consent screen (your Google account may need to be a
 *     test user while the app is in Testing - see the note below about why
 *     that matters for renewals, not just first-time setup).
 *   - Create an OAuth client of type **Web application** - not Desktop/iOS/
 *     Android, which don't accept a client_secret the way this script's
 *     authorization_code exchange does.
 *   - Add the EXACT redirect URI this script prints (default
 *     http://localhost:5179/oauth2callback) to that client's "Authorized
 *     redirect URIs". This is a DIFFERENT, additional entry from the OAuth
 *     Playground's redirect URI (https://developers.google.com/oauthplayground)
 *     if you or the README's Playground walkthrough registered that one too -
 *     both can sit on the same client, but each flow needs its own exact
 *     match. Missing this step is the most common cause of this script
 *     failing where the Playground worked (see the unauthorized_client /
 *     redirect_uri_mismatch guidance below).
 *
 * Renewing an expired/revoked token: GA4/GSC syncs fail with auth_error and
 * Sync History shows "invalid_grant - Token has been expired or revoked."
 * when the refresh token itself has died - either someone revoked it under
 * the Google account's "Third-party apps & services", or (very commonly,
 * while the consent screen is still in Testing) it simply hit Google's
 * 7-day auto-expiry for test-user tokens. Re-run this exact script with the
 * same GOOGLE_CLIENT_ID/SECRET, approve once, and paste the newly printed
 * token into GOOGLE_REFRESH_TOKEN - no other setup should be needed unless
 * the redirect URI above was never registered. To stop this recurring,
 * publish/verify the OAuth consent screen so tokens stop auto-expiring.
 *
 * The refresh token is printed ONCE. Copy it into the Supabase Edge Function
 * secret GOOGLE_REFRESH_TOKEN. It is never written to a file.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(process.env.GOOGLE_OAUTH_PORT ?? 5179);
const redirectUri =
  process.env.GOOGLE_OAUTH_REDIRECT ??
  `http://localhost:${port}/oauth2callback`;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET in the environment.",
  );
  process.exit(1);
}

const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPES.join(" "),
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
  state,
}).toString();

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Turn Google's bare OAuth error code into the one thing to actually go
 * check - these get confused with each other constantly, but they point at
 * different fixes.
 */
function diagnose(error: string | undefined): string {
  switch (error) {
    case "unauthorized_client":
    case "redirect_uri_mismatch":
      return (
        `This means the redirect URI above (${redirectUri}) is not registered - byte-for-byte, ` +
        "including the port - on the OAuth client for this GOOGLE_CLIENT_ID in Google Cloud " +
        "Console → APIs & Services → Credentials → your client → Authorized redirect URIs. " +
        "It must be a client of type Web application. This is a DIFFERENT entry from the OAuth " +
        "Playground's redirect URI if that one is already registered - add this one alongside it, " +
        "don't replace it. Add it, then re-run this script (no need to change anything else)."
      );
    case "invalid_client":
      return (
        "This means GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET don't match a real, current OAuth " +
        "client - either they're from different clients, or the client secret was regenerated " +
        "in Google Cloud Console since these were last set. Copy both values again from " +
        "Credentials → your OAuth client and re-run with them."
      );
    case "access_denied":
      return "You (or the account) declined the consent screen. Re-run and click Allow.";
    case "invalid_grant":
      // Only reachable here if Google issued then immediately invalidated the
      // authorization code (e.g. it was already used, or expired before this
      // exchange ran - codes are single-use and short-lived). Re-running the
      // whole flow gets a fresh one; this is not the refresh-token-expiry
      // invalid_grant that shows up later in production Sync History.
      return "The authorization code itself was already used or expired. Just re-run this script from the top.";
    default:
      return "Re-run this script; if it keeps failing, double check the redirect URI and OAuth client type in Google Cloud Console (see the file header comment).";
  }
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  return (await res.json()) as TokenResponse;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end("Not found");
    return;
  }

  const finish = (message: string) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<html><body style="font-family:sans-serif">${message}</body></html>`,
    );
  };

  if (url.searchParams.get("state") !== state) {
    finish("State mismatch - please re-run the script.");
    console.error("\nState mismatch. Aborting for safety.");
    server.close(() => process.exit(1));
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    finish("No authorization code returned.");
    console.error("\nNo code in callback. Aborting.");
    server.close(() => process.exit(1));
    return;
  }

  const tokens = await exchangeCode(code);
  if (tokens.error || !tokens.refresh_token) {
    finish("Token exchange failed. Check the terminal.");
    console.error(
      `\nToken exchange failed: ${tokens.error ?? "no refresh_token returned"}.`,
    );
    if (tokens.error_description) {
      console.error(`Google says: ${tokens.error_description}`);
    }
    console.error(diagnose(tokens.error));
    server.close(() => process.exit(1));
    return;
  }

  finish("Success! You can close this tab and return to the terminal.");

  console.log("\n========================================================");
  console.log("GOOGLE_REFRESH_TOKEN (copy into Supabase Edge secrets):\n");
  console.log(tokens.refresh_token);
  console.log("\n========================================================");
  console.log("WARNING:");
  console.log("  - Treat this like a password. Do NOT commit it.");
  console.log("  - Set it as the GOOGLE_REFRESH_TOKEN function secret.");
  console.log("  - Clear your terminal scrollback afterwards.");
  server.close(() => process.exit(0));
});

server.listen(port, () => {
  console.log(`\nListening on ${redirectUri}`);
  console.log(
    "\n1. In Google Cloud Console -> APIs & Services -> Credentials -> your",
  );
  console.log(
    "   Web application OAuth client, add this EXACT URI (this port included)",
  );
  console.log(
    "   to Authorized redirect URIs - alongside the Playground's, not instead of it,",
  );
  console.log("   if you're not sure whether it's already there:");
  console.log(`\n     ${redirectUri}\n`);
  console.log("2. Open this URL in your browser and approve access:\n");
  console.log(authUrl.toString());
  console.log("");
});
