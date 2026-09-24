import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import {
  normalizeBingRows,
  normalizeBingQueryRows,
  normalizeBingPageRows,
  normalizeBingCrawlStatsRows,
  findMatchingBingSite,
  hasEmbeddedBingError,
  type BingApiRow,
  type BingQueryStatsRow,
  type BingCrawlStatsApiRow,
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

function bingErrorCode(status: number, bodyText: string) {
  if (/InvalidApiKey/i.test(bodyText)) return "invalid_credentials" as const;
  return codeForStatus(status);
}

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
      const excerpt = bodyText.replace(/\s+/g, " ").trim().slice(0, 180);
      lastFailure = new SyncError(
        bingErrorCode(res.status, bodyText),
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
      const excerpt = bodyText.replace(/\s+/g, " ").trim().slice(0, 180);
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

  const updatedAt = new Date().toISOString();
  const [rawRows, rawQueryRows, rawPageRows] = await Promise.all([
    callBing("GetRankAndTrafficStats", apiKey, {
      siteUrl: matched.Url,
    }) as Promise<BingApiRow[]>,
    callBing("GetQueryStats", apiKey, { siteUrl: matched.Url }) as Promise<
      BingQueryStatsRow[]
    >,
    callBing("GetPageStats", apiKey, { siteUrl: matched.Url }) as Promise<
      BingQueryStatsRow[]
    >,
  ]);

  const rows = normalizeBingRows(rawRows, site.id, updatedAt);
  const queryRows = normalizeBingQueryRows(rawQueryRows, site.id, updatedAt);
  const pageRows = normalizeBingPageRows(rawPageRows, site.id, updatedAt);

  if (rows.length > 0) {
    const { error } = await admin
      .from("search_daily")
      .upsert(rows, { onConflict: "site_id,engine,metric_date" });
    if (error) throw error;
  }
  if (queryRows.length > 0) {
    const { error } = await admin
      .from("search_query_daily")
      .upsert(queryRows, { onConflict: "site_id,engine,metric_date,query" });
    if (error) throw error;
  }
  if (pageRows.length > 0) {
    const { error } = await admin
      .from("search_page_daily")
      .upsert(pageRows, { onConflict: "site_id,engine,metric_date,page" });
    if (error) throw error;
  }

  let rowsFetched = rawRows.length + rawQueryRows.length + rawPageRows.length;
  let rowsWritten = rows.length + queryRows.length + pageRows.length;
  const failed: string[] = [];
  const breakdownErrors: Record<string, { code: string; message: string }> = {};
  function recordFailure(name: string, err: unknown) {
    failed.push(name);
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SyncError ? err.code : "provider_error";
    breakdownErrors[name] = { code, message };
  }

  // --- Best-effort: crawl/index health (GetCrawlStats) - genuinely available
  // Bing discovery data (InIndex, CrawledPages, BlockedByRobotsTxt etc.),
  // distinct from search performance. Feeds the Bing dashboard's
  // indexed/discovered section instead of leaving it blank. A failure here
  // never blocks the required traffic/query/page sync above.
  try {
    const apiRows = (await callBing("GetCrawlStats", apiKey, {
      siteUrl: matched.Url,
    })) as BingCrawlStatsApiRow[];
    const crawlRows = normalizeBingCrawlStatsRows(apiRows, site.id, updatedAt);
    if (crawlRows.length > 0) {
      const { error } = await admin
        .from("bing_crawl_stats_daily")
        .upsert(crawlRows, { onConflict: "site_id,metric_date" });
      if (error) throw error;
    }
    rowsFetched += apiRows.length;
    rowsWritten += crawlRows.length;
  } catch (err) {
    recordFailure("crawl_stats", err);
  }

  return {
    rowsFetched,
    rowsWritten,
    partial: failed.length > 0,
    metadata: {
      provider: "bing",
      bingVerifiedSiteUrl: matched.Url,
      bingSiteIsVerified: matched.IsVerified ?? null,
      aggregateRowsFetched: rawRows.length,
      queryRowsFetched: rawQueryRows.length,
      pageRowsFetched: rawPageRows.length,
      note: "GetQueryStats/GetPageStats are weekly-updated Bing Webmaster datasets; aggregate traffic includes Web, Chat and other Bing verticals.",
      failedBreakdowns: failed,
      breakdownErrors,
    },
  };
};
