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

// Bing's current JSON/REST examples use www.bing.com. Keep the historical
// ssl.bing.com host as a compatibility fallback because some API-key accounts
// are still routed there during Microsoft's 2026 migration.
const BASES = [
  "https://www.bing.com/webmaster/api.svc/json",
  "https://ssl.bing.com/webmaster/api.svc/json",
] as const;

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
  let lastFailure: SyncError | null = null;

  for (const base of BASES) {
    const qs = new URLSearchParams({ apikey: apiKey, ...params });
    const res = await fetchWithRetry(`${base}/${endpoint}?${qs.toString()}`, {
      headers: { Accept: "application/json" },
    });

    const bodyText = await res.text();

    if (!res.ok) {
      // Never echo the request URL - it contains the API key. Include only a
      // short provider response excerpt so a retired endpoint / bad credential
      // is diagnosable from sync history without leaking secrets.
      const excerpt = bodyText
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      lastFailure = new SyncError(
        codeForStatus(res.status),
        `Bing API returned HTTP ${res.status} from ${endpoint}${excerpt ? `: ${excerpt}` : ""}`,
        { status: res.status, retryable: isRetryableStatus(res.status) },
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      lastFailure = new SyncError(
        "provider_error",
        `Bing API returned unparseable JSON from ${endpoint}`,
      );
      continue;
    }

    if (hasEmbeddedBingError(parsed)) {
      const topLevel =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.keys(parsed as Record<string, unknown>).join(",")
          : typeof parsed;
      const excerpt = bodyText
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      lastFailure = new SyncError(
        "provider_error",
        `Bing API returned an unexpected response from ${endpoint} (shape: ${topLevel || "empty"})${excerpt ? `: ${excerpt}` : ""}`,
      );
      continue;
    }

    return (parsed as { d: unknown[] }).d;
  }

  throw (
    lastFailure ??
    new SyncError("provider_error", `Bing API failed for ${endpoint}`)
  );
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

  const bingSites = (await callBing("GetUserSites", apiKey)) as BingSiteRecord[];
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
