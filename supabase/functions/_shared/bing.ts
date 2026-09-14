import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import {
  normalizeBingRows,
  findMatchingBingSite,
  hasEmbeddedBingError,
  type BingApiRow,
  type BingSiteRecord,
} from "./bing-parse.ts";
import type { SyncAdapter } from "./sync-run.ts";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

/**
 * Call a Bing Webmaster endpoint and return its `d` array, having verified
 * the HTTP layer succeeded AND the JSON body is a genuine {"d": [...]}
 * envelope - Bing's legacy API can return HTTP 200 with an error embedded in
 * the body, and that must never be read as a legitimate empty result.
 */
async function callBing(
  endpoint: string,
  apiKey: string,
  params: Record<string, string> = {},
): Promise<unknown[]> {
  const qs = new URLSearchParams({ apikey: apiKey, ...params });
  const res = await fetchWithRetry(`${BASE}/${endpoint}?${qs.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    // Never echo the URL - it carries the API key.
    throw new SyncError(
      codeForStatus(res.status),
      `Bing API returned HTTP ${res.status} from ${endpoint}`,
      { status: res.status, retryable: isRetryableStatus(res.status) },
    );
  }

  const bodyText = await res.text();
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    throw new SyncError(
      "provider_error",
      `Bing API returned unparseable JSON from ${endpoint}`,
    );
  }

  if (hasEmbeddedBingError(parsed)) {
    throw new SyncError(
      "provider_error",
      `Bing API returned an unexpected response shape from ${endpoint} despite HTTP 200`,
    );
  }

  return (parsed as { d: unknown[] }).d;
}

/**
 * Bing Webmaster daily traffic sync (single-owner API-key flow). Before
 * trusting a zero-row result as "legitimately no data", this verifies via
 * GetUserSites that the API key can actually see the configured site (never
 * assuming the configured URL is what Bing grants access to) - a zero-row
 * report is only ever "healthy" once that access has been positively
 * confirmed. CTR and average position aren't supplied by this endpoint and
 * stay null. All Bing specifics live behind this adapter + bing-parse so the
 * older API can be replaced in isolation.
 */
export const bingAdapter: SyncAdapter = async ({ admin, site }) => {
  if (!site.bing_site_url) {
    throw new SyncError(
      "config_missing",
      "No Bing site URL configured for this site",
    );
  }
  const apiKey = Deno.env.get("BING_WEBMASTER_API_KEY");
  if (!apiKey) {
    throw new SyncError("config_missing", "Missing BING_WEBMASTER_API_KEY");
  }

  const bingSites = (await callBing(
    "GetUserSites",
    apiKey,
  )) as BingSiteRecord[];
  const matched = findMatchingBingSite(bingSites, site.bing_site_url);
  if (!matched?.Url) {
    throw new SyncError(
      "permission_denied",
      "Configured Bing site URL is not accessible to this API key (not returned by GetUserSites)",
    );
  }

  const rawRows = (await callBing("GetRankAndTrafficStats", apiKey, {
    siteUrl: matched.Url,
  })) as BingApiRow[];
  const rows = normalizeBingRows(rawRows, site.id, new Date().toISOString());

  if (rows.length > 0) {
    const { error } = await admin
      .from("search_daily")
      .upsert(rows, { onConflict: "site_id,engine,metric_date" });
    if (error) throw error;
  }

  return {
    rowsFetched: rawRows.length,
    rowsWritten: rows.length,
    metadata: {
      provider: "bing",
      bingVerifiedSiteUrl: matched.Url,
      bingSiteIsVerified: matched.IsVerified ?? null,
    },
  };
};
