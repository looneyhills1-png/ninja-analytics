/**
 * Server-side local access for a self-hosted install.
 *
 * The dashboard is served from loopback only. Instead of a browser login, the
 * local server attaches a short-lived, admin-scoped JWT to API calls that the
 * browser sends to /sb/*. The token is minted here, from the stack's JWT
 * secret, which never reaches the browser. Row-level security, the aal2
 * policies and the Edge Function admin checks are unchanged: the token is an
 * ordinary `authenticated` token for the one allow-listed admin user.
 *
 * Because there is no password or MFA prompt, the only protection is that the
 * caller is this machine. Every request is therefore checked for:
 *   - a loopback Host header (defeats DNS rebinding),
 *   - same-origin fetch metadata and a custom header (defeats cross-site
 *     requests from other web pages, which cannot set it without a preflight),
 *   - no Cloudflare headers (nothing public may reach this path).
 */
import { createHmac } from "node:crypto";

/** Only the data API and Edge Functions are reachable through the proxy. */
export const ALLOWED_PREFIXES = ["/rest/v1/", "/functions/v1/"];
export const LOCAL_HEADER = "x-ninja-local";

const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Mint an HS256 token for `adminUserId`. `nowSec` is injectable for tests. */
export function mintAdminToken(
  secret,
  adminUserId,
  nowSec = Math.floor(Date.now() / 1000),
  ttlSec = 900,
) {
  if (!secret || !adminUserId)
    throw new Error("secret and adminUserId are required");
  const payload = {
    aud: "authenticated",
    role: "authenticated",
    sub: adminUserId,
    iat: nowSec,
    exp: nowSec + ttlSec,
    // Local access stands in for the MFA step; see the module comment.
    aal: "aal2",
    amr: [{ method: "local-access", timestamp: nowSec }],
  };
  const unsigned = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}`;
  const signature = createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

/** Caches one token and re-mints it when it is within a minute of expiry. */
export function createTokenSource(
  secret,
  adminUserId,
  clock = () => Math.floor(Date.now() / 1000),
) {
  let token = null;
  let expiresAt = 0;
  return () => {
    const now = clock();
    if (!token || now >= expiresAt - 60) {
      token = mintAdminToken(secret, adminUserId, now);
      expiresAt = now + 900;
    }
    return token;
  };
}

/**
 * Decide whether a browser request to /sb/* may be proxied.
 * @returns {{ok: true, upstreamPath: string} | {ok: false, status: number, reason: string}}
 */
export function checkProxyRequest({ headers, url }, port) {
  const host = headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, reason: "bad host" };
  }
  if (
    headers["cf-ray"] ||
    headers["cf-connecting-ip"] ||
    headers["x-forwarded-for"]
  ) {
    return { ok: false, status: 403, reason: "proxied request" };
  }
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin") {
    return { ok: false, status: 403, reason: "cross-site request" };
  }
  const origin = headers.origin;
  if (origin && origin !== `http://${host}`) {
    return { ok: false, status: 403, reason: "foreign origin" };
  }
  if (headers[LOCAL_HEADER] !== "1") {
    return { ok: false, status: 403, reason: "missing local header" };
  }

  const parsed = new URL(url, "http://local");
  const path = parsed.pathname.replace(/^\/sb/, "");
  if (
    !parsed.pathname.startsWith("/sb/") ||
    path.includes("..") ||
    path.includes("//")
  ) {
    return { ok: false, status: 404, reason: "not found" };
  }
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return { ok: false, status: 404, reason: "path not allowed" };
  }
  return { ok: true, upstreamPath: path + parsed.search };
}

/** Headers forwarded upstream: browser credentials are dropped and replaced. */
export function buildUpstreamHeaders(incoming, bearer) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      /^(host|connection|cookie|authorization|origin|referer|sec-|x-forwarded-|cf-|x-ninja-local)/i.test(
        name,
      )
    )
      continue;
    out[name] = value;
  }
  out.authorization = `Bearer ${bearer}`;
  return out;
}
