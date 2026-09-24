// Bing discovery/IndexNow status - fetched directly from the tracked site's
// own public, already-served files, same pattern as
// features/keywords/site-pages-source.ts (search-index.json, sitemap.xml):
// no new backend, no crawler, just plain cross-origin GETs against files the
// site already publishes with CORS (public/assets/data/* - see ninjatickets'
// build.js _headers generation). A site that hasn't published the log yet
// (or isn't ninjatickets) degrades to "not available" - never a hard error,
// never a fabricated status.

export interface IndexNowBatchResult {
  urlCount: number;
  ok: boolean;
  status: number | null;
  attemptsMade: number;
  error?: string | null;
}

export interface IndexNowSubmissionLogEntry {
  submittedAt: string;
  added: number;
  changed: number;
  removed: number;
  submittableCount: number;
  rejectedCount: number;
  batches: IndexNowBatchResult[];
  failedUrlCount: number;
  allOk: boolean;
  note?: string;
}

export interface IndexNowStatus {
  /** false = the log file itself wasn't reachable (not yet published, wrong
   * domain, CORS not configured) - distinct from "reachable but empty". */
  available: boolean;
  submissions: IndexNowSubmissionLogEntry[];
  latest: IndexNowSubmissionLogEntry | null;
}

export async function fetchIndexNowStatus(
  domain: string,
): Promise<IndexNowStatus> {
  try {
    const res = await fetch(
      `https://${domain}/assets/data/indexnow-submission-log.json`,
      { mode: "cors" },
    );
    if (!res.ok) return { available: false, submissions: [], latest: null };
    const data = (await res.json()) as {
      submissions?: IndexNowSubmissionLogEntry[];
    };
    const submissions = Array.isArray(data.submissions) ? data.submissions : [];
    return {
      available: true,
      submissions,
      latest:
        submissions.length > 0 ? submissions[submissions.length - 1] : null,
    };
  } catch {
    return { available: false, submissions: [], latest: null };
  }
}

export interface SitemapStatus {
  /** false = sitemap.xml wasn't reachable at all this run. */
  available: boolean;
  urlCount: number | null;
}

/** Cheap corroboration that the site's own sitemap is live and non-empty -
 * NOT a Bing/Google submission-status check (neither publishes a public API
 * for "did you receive/process our sitemap"); this is client-side proof the
 * sitemap itself exists and has content, which the dashboard pairs with the
 * Google Sitemaps API's real submission/status record (ninja-analytics
 * Fix workflow, server-side) and Bing's InIndex/CrawledPages counts. */
export async function fetchSitemapStatus(
  domain: string,
): Promise<SitemapStatus> {
  try {
    const res = await fetch(`https://${domain}/sitemap.xml`, { mode: "cors" });
    if (!res.ok) return { available: false, urlCount: null };
    const xml = await res.text();
    const count = (xml.match(/<loc>/g) ?? []).length;
    return { available: true, urlCount: count };
  } catch {
    return { available: false, urlCount: null };
  }
}
