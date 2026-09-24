// Google Search Console Sitemaps API (sitemaps.submit / sitemaps.get) -
// PART 1 §7 of the 2026-09-24 brief: "automatically resubmit the appropriate
// sitemap after a successful material production change" and "verify
// sitemap submission status". Same OAuth token as the rest of the GSC
// integration (_shared/google-auth.ts) - the Sitemaps API is covered by the
// same Search Console scope already granted, no new consent.
//
// This is explicitly NOT the Google Indexing API - the brief is emphatic
// that the Indexing API must never be used for ordinary NinjaTickets ticket/
// event/guide pages (it's restricted to JobPosting/BroadcastEvent content).
// Sitemaps API is the correct, permitted mechanism for "tell Google a
// sitemap changed."
import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import { getGoogleAccessToken } from "./google-auth.ts";

const API_BASE = "https://www.googleapis.com/webmasters/v3/sites";

function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

export interface SitemapSubmitResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** PUT .../sites/{siteUrl}/sitemaps/{feedpath} - Google's submit call
 * returns an empty 200 body on success; there is no push notification, only
 * sitemaps.get (below) to check on it later. */
export async function submitSitemap(
  gscProperty: string,
  sitemapUrl: string,
): Promise<SitemapSubmitResult> {
  const token = await getGoogleAccessToken();
  const res = await fetchWithRetry(
    `${API_BASE}/${encodeSiteUrl(gscProperty)}/sitemaps/${encodeSiteUrl(sitemapUrl)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    },
    { timeoutMs: 15_000, maxRetries: 2 },
  );
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      // non-JSON body
    }
    return {
      ok: false,
      status: res.status,
      error: detail || `HTTP ${res.status}`,
    };
  }
  return { ok: true, status: res.status };
}

export interface SitemapGetResult {
  path: string;
  lastSubmitted: string | null;
  isPending: boolean | null;
  isSitemapsIndex: boolean | null;
  lastDownloaded: string | null;
  warnings: number | null;
  errors: number | null;
  contents: { type: string; submitted: string; indexed: string }[];
}

/** GET .../sites/{siteUrl}/sitemaps/{feedpath} - Google's own real, current
 * status for a previously-submitted sitemap. Every field here is verbatim
 * from Google, never derived/guessed. */
export async function getSitemapStatus(
  gscProperty: string,
  sitemapUrl: string,
): Promise<SitemapGetResult> {
  const token = await getGoogleAccessToken();
  const res = await fetchWithRetry(
    `${API_BASE}/${encodeSiteUrl(gscProperty)}/sitemaps/${encodeSiteUrl(sitemapUrl)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: 15_000, maxRetries: 2 },
  );
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      // non-JSON body
    }
    throw new SyncError(
      codeForStatus(res.status),
      `Sitemaps API get failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
      { status: res.status, retryable: isRetryableStatus(res.status) },
    );
  }
  const data = (await res.json()) as {
    path?: string;
    lastSubmitted?: string;
    isPending?: boolean;
    isSitemapsIndex?: boolean;
    lastDownloaded?: string;
    warnings?: string;
    errors?: string;
    contents?: { type?: string; submitted?: string; indexed?: string }[];
  };
  return {
    path: data.path ?? sitemapUrl,
    lastSubmitted: data.lastSubmitted ?? null,
    isPending: data.isPending ?? null,
    isSitemapsIndex: data.isSitemapsIndex ?? null,
    lastDownloaded: data.lastDownloaded ?? null,
    warnings: data.warnings != null ? Number(data.warnings) : null,
    errors: data.errors != null ? Number(data.errors) : null,
    contents: (data.contents ?? []).map((c) => ({
      type: c.type ?? "",
      submitted: c.submitted ?? "",
      indexed: c.indexed ?? "",
    })),
  };
}
