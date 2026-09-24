// Google Search Console URL Inspection API (Ranking Growth Roadmap Phase 4).
// This is the official, documented per-URL inspection endpoint
// (searchconsole.urlInspection.index.inspect) - NOT the separate, narrowly-
// scoped Google Indexing API (which is only for JobPosting/BroadcastEvent
// pages and must never be used here for ordinary NinjaTickets pages). Auth
// is the exact same Google OAuth token the existing GSC sync already uses
// (_shared/google-auth.ts) - no new secret, no new consent scope beyond
// what's already granted (the Search Console readonly scope covers URL
// Inspection).
//
// Every field this module stores that came from Google is stored verbatim
// (coverage_state, verdict, robots_txt_state, indexing_state,
// page_fetch_state, google/user canonical, last_crawl_time, sitemaps) - the
// only thing this module *derives* is `ninja_status`, a small, documented,
// transparent bucketing of those verbatim fields (classifyIndexStatus below)
// so the UI has a simple 7-value status to filter/summarize by. Nothing is
// ever invented when Google's own fields don't clearly say one thing or the
// other - that's what the 'unknown' bucket is for.

import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import { getGoogleAccessToken } from "./google-auth.ts";
import type { SupabaseClient } from "./database.ts";

export type NinjaIndexStatus =
  | "indexed"
  | "not_indexed"
  | "crawled_not_indexed"
  | "discovered_not_indexed"
  | "canonical_mismatch"
  | "blocked"
  | "unknown";

export interface GoogleIndexStatusResult {
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
  sitemaps: string[];
}

export interface NormalizedInspection extends GoogleIndexStatusResult {
  url: string;
  ninjaStatus: NinjaIndexStatus;
  /** Google's own real deep link into the Search Console UI for this exact
   * inspection result (inspectionResult.inspectionResultLink) - never
   * fabricated. Null when Google's response didn't include one. */
  inspectionResultLink: string | null;
  raw: unknown;
}

/**
 * Buckets Google's own coverageState/robotsTxtState/indexingState into one
 * of 7 transparent statuses. Priority order: an explicit block signal always
 * wins (it's the most actionable), then the well-documented coverageState
 * phrases Google actually returns (see
 * https://support.google.com/webmasters/answer/9012289) are matched by
 * keyword - never a fixed enum lookup, since Google has both extended and
 * reworded these strings before and a keyword match degrades gracefully to
 * 'unknown' instead of throwing or silently mis-bucketing.
 */
export function classifyIndexStatus(
  r: Pick<
    GoogleIndexStatusResult,
    "coverageState" | "robotsTxtState" | "indexingState"
  >,
): NinjaIndexStatus {
  const coverage = (r.coverageState ?? "").toLowerCase();
  const robots = (r.robotsTxtState ?? "").toUpperCase();
  const indexing = (r.indexingState ?? "").toUpperCase();

  if (
    robots === "DISALLOWED" ||
    indexing.includes("BLOCKED") ||
    coverage.includes("blocked") ||
    coverage.includes("noindex") ||
    coverage.includes("forbidden") ||
    coverage.includes("unauthorized")
  ) {
    return "blocked";
  }
  if (coverage.includes("indexed") && !coverage.includes("not indexed")) {
    return "indexed";
  }
  if (coverage.includes("crawled") && coverage.includes("not indexed")) {
    return "crawled_not_indexed";
  }
  if (coverage.includes("discovered") && coverage.includes("not indexed")) {
    return "discovered_not_indexed";
  }
  if (
    coverage.includes("duplicate") ||
    coverage.includes("alternate page") ||
    coverage.includes("canonical")
  ) {
    return "canonical_mismatch";
  }
  if (coverage.includes("not on google") || coverage.includes("not found")) {
    return "not_indexed";
  }
  return "unknown";
}

interface RawIndexStatusResult {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  lastCrawlTime?: string;
  crawledAs?: string;
  sitemap?: string[];
  referringUrls?: string[];
}

interface RawInspectionResponse {
  inspectionResult?: {
    indexStatusResult?: RawIndexStatusResult;
    inspectionResultLink?: string;
  };
}

/** One call to the real Search Console API for one URL. Never batched by
 * Google itself - the API is single-URL per request, which is exactly why
 * this whole feature is priority-driven rather than "inspect everything". */
export async function inspectUrlWithGoogle(
  token: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<NormalizedInspection> {
  const res = await fetchWithRetry(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    },
    { timeoutMs: 20_000, maxRetries: 2 },
  );

  if (!res.ok) {
    let detail = "";
    let providerErrorCode: string | undefined;
    try {
      const errBody = (await res.json()) as {
        error?: { message?: string; status?: string };
      };
      providerErrorCode = errBody.error?.status;
      if (errBody.error?.message) detail = `: ${errBody.error.message}`;
    } catch {
      // Non-JSON body - fall back to the bare status.
    }
    throw new SyncError(
      codeForStatus(res.status),
      `URL Inspection API returned HTTP ${res.status}${detail}`,
      {
        status: res.status,
        retryable: isRetryableStatus(res.status),
        providerErrorCode,
      },
    );
  }

  const data = (await res.json()) as RawInspectionResponse;
  const r = data.inspectionResult?.indexStatusResult ?? {};
  const base: GoogleIndexStatusResult = {
    verdict: r.verdict ?? null,
    coverageState: r.coverageState ?? null,
    robotsTxtState: r.robotsTxtState ?? null,
    indexingState: r.indexingState ?? null,
    pageFetchState: r.pageFetchState ?? null,
    googleCanonical: r.googleCanonical ?? null,
    userCanonical: r.userCanonical ?? null,
    lastCrawlTime: r.lastCrawlTime ?? null,
    crawledAs: r.crawledAs ?? null,
    sitemaps: r.sitemap ?? [],
  };
  return {
    ...base,
    url: inspectionUrl,
    ninjaStatus: classifyIndexStatus(base),
    inspectionResultLink: data.inspectionResult?.inspectionResultLink ?? null,
    raw: data,
  };
}

export interface InspectOneOutcome {
  url: string;
  status: "inspected" | "skipped_cached" | "failed";
  ninjaStatus?: NinjaIndexStatus;
  errorMessage?: string;
}

/** Skip re-inspecting a URL this fresh unless the caller forces it - this is
 * the "do not repeatedly inspect unchanged URLs" quota guard (CLAUDE.md /
 * the Phase 4 brief), enforced here so both the on-demand and scheduled
 * callers get it for free. */
const DEFAULT_MIN_RECHECK_HOURS = 20;

/**
 * Inspects each URL (skipping ones already fresh unless forced), upserts the
 * current-state cache row, and appends a history snapshot for every URL that
 * was actually inspected - so "Not indexed -> Indexed" etc. is always
 * derivable later without ever overwriting the prior state.
 */
export async function inspectAndStoreUrls(
  admin: SupabaseClient,
  siteId: string,
  gscProperty: string,
  urls: string[],
  opts: {
    force?: boolean;
    inspectedBy?: string | null;
    minRecheckHours?: number;
    /** Optional site_lastmod (from the site's own sitemap.xml, fetched
     * client-side and passed through) per URL, for the material-change
     * signal - never fetched server-side, never invented if absent. */
    siteLastmodByUrl?: Record<string, string | null>;
  } = {},
): Promise<InspectOneOutcome[]> {
  const minRecheckHours = opts.minRecheckHours ?? DEFAULT_MIN_RECHECK_HOURS;
  const uniqueUrls = [...new Set(urls)];

  const { data: cached } = await admin
    .from("url_inspections")
    .select("url, last_inspected_at")
    .eq("site_id", siteId)
    .in("url", uniqueUrls);
  const cachedByUrl = new Map(
    (cached ?? []).map((r) => [r.url as string, r.last_inspected_at as string]),
  );

  const results: InspectOneOutcome[] = [];
  let token: string | null = null;

  for (const url of uniqueUrls) {
    if (!opts.force) {
      const lastInspectedAt = cachedByUrl.get(url);
      if (lastInspectedAt) {
        const ageHours =
          (Date.now() - new Date(lastInspectedAt).getTime()) / 3_600_000;
        if (ageHours < minRecheckHours) {
          results.push({ url, status: "skipped_cached" });
          continue;
        }
      }
    }

    try {
      token ??= await getGoogleAccessToken();
      const inspection = await inspectUrlWithGoogle(token, gscProperty, url);
      const siteLastmod = opts.siteLastmodByUrl?.[url] ?? null;
      const now = new Date().toISOString();

      const row = {
        site_id: siteId,
        url,
        last_inspected_at: now,
        inspected_by: opts.inspectedBy ?? null,
        verdict: inspection.verdict,
        coverage_state: inspection.coverageState,
        robots_txt_state: inspection.robotsTxtState,
        indexing_state: inspection.indexingState,
        page_fetch_state: inspection.pageFetchState,
        google_canonical: inspection.googleCanonical,
        user_canonical: inspection.userCanonical,
        last_crawl_time: inspection.lastCrawlTime,
        crawled_as: inspection.crawledAs,
        sitemaps: inspection.sitemaps,
        ninja_status: inspection.ninjaStatus,
        site_lastmod: siteLastmod,
        raw_response: inspection.raw,
        inspection_result_link: inspection.inspectionResultLink,
        updated_at: now,
      };

      const { error: upsertError } = await admin
        .from("url_inspections")
        .upsert(row, { onConflict: "site_id,url" });
      if (upsertError) throw upsertError;

      const { error: historyError } = await admin
        .from("url_inspection_history")
        .insert({
          site_id: siteId,
          url,
          inspected_at: now,
          inspected_by: opts.inspectedBy ?? null,
          verdict: inspection.verdict,
          coverage_state: inspection.coverageState,
          robots_txt_state: inspection.robotsTxtState,
          indexing_state: inspection.indexingState,
          page_fetch_state: inspection.pageFetchState,
          google_canonical: inspection.googleCanonical,
          user_canonical: inspection.userCanonical,
          last_crawl_time: inspection.lastCrawlTime,
          crawled_as: inspection.crawledAs,
          sitemaps: inspection.sitemaps,
          ninja_status: inspection.ninjaStatus,
          site_lastmod: siteLastmod,
          inspection_result_link: inspection.inspectionResultLink,
        });
      if (historyError) throw historyError;

      results.push({
        url,
        status: "inspected",
        ninjaStatus: inspection.ninjaStatus,
      });
    } catch (err) {
      const message =
        err instanceof SyncError
          ? err.message
          : ((err as { message?: string })?.message ?? "Inspection failed");
      results.push({ url, status: "failed", errorMessage: message });
    }
  }

  return results;
}
