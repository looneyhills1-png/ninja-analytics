// Read-only Search Console API calls used by coverage-sync: sitemap status
// (sitemaps.list) and Search Analytics broken down by device, country and
// search type. Same OAuth token as the rest of the GSC integration; the
// read-only scope already granted covers both. No write call exists here.
//
// Errors keep Google's own HTTP status so the caller can tell an API
// limitation (quota, unsupported combination) from a missing permission.

import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import { getGoogleAccessToken } from "./google-auth.ts";

const API = "https://www.googleapis.com/webmasters/v3/sites";
const enc = (s: string) => encodeURIComponent(s);

async function failure(res: Response, what: string): Promise<SyncError> {
  let detail = "";
  let status = "";
  try {
    const b = (await res.json()) as {
      error?: { message?: string; status?: string };
    };
    detail = b.error?.message ?? "";
    status = b.error?.status ?? "";
  } catch {
    // non-JSON body
  }
  return new SyncError(
    codeForStatus(res.status),
    `${what} failed (HTTP ${res.status}${status ? ` ${status}` : ""})${detail ? `: ${detail}` : ""}`,
    {
      status: res.status,
      retryable: isRetryableStatus(res.status),
      providerErrorCode: status || undefined,
    },
  );
}

export interface ListedSitemap {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean | null;
  isSitemapsIndex: boolean | null;
  warnings: number | null;
  errors: number | null;
  contents: Array<{ type: string; submitted: string; indexed: string }>;
}

/** GET .../sites/{site}/sitemaps: every sitemap Google knows for the property. */
export async function listSitemaps(
  gscProperty: string,
): Promise<ListedSitemap[]> {
  const token = await getGoogleAccessToken();
  const res = await fetchWithRetry(
    `${API}/${enc(gscProperty)}/sitemaps`,
    { headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: 15_000, maxRetries: 2 },
  );
  if (!res.ok) throw await failure(res, "Sitemaps list");
  const data = (await res.json()) as {
    sitemap?: Array<{
      path?: string;
      lastSubmitted?: string;
      lastDownloaded?: string;
      isPending?: boolean;
      isSitemapsIndex?: boolean;
      warnings?: string;
      errors?: string;
      contents?: Array<{ type?: string; submitted?: string; indexed?: string }>;
    }>;
  };
  return (data.sitemap ?? [])
    .filter((s) => !!s.path)
    .map((s) => ({
      path: s.path as string,
      lastSubmitted: s.lastSubmitted ?? null,
      lastDownloaded: s.lastDownloaded ?? null,
      isPending: s.isPending ?? null,
      isSitemapsIndex: s.isSitemapsIndex ?? null,
      warnings: s.warnings != null ? Number(s.warnings) : null,
      errors: s.errors != null ? Number(s.errors) : null,
      contents: (s.contents ?? []).map((c) => ({
        type: c.type ?? "",
        submitted: c.submitted ?? "",
        indexed: c.indexed ?? "",
      })),
    }));
}

export type Dimension = "device" | "country";
export type SearchType = "web" | "image" | "video" | "news";

export interface DimensionRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

/** One Search Analytics query grouped by a single dimension. Paginates with
 * startRow up to MAX_PAGES so it can never loop forever. */
export async function queryByDimension(
  gscProperty: string,
  opts: {
    startDate: string;
    endDate: string;
    dimension: Dimension;
    searchType: SearchType;
  },
): Promise<DimensionRow[]> {
  const ROW_LIMIT = 1000;
  const MAX_PAGES = 5;
  const token = await getGoogleAccessToken();
  const out: DimensionRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchWithRetry(
      `${API}/${enc(gscProperty)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: opts.startDate,
          endDate: opts.endDate,
          dimensions: [opts.dimension],
          type: opts.searchType,
          rowLimit: ROW_LIMIT,
          startRow: page * ROW_LIMIT,
        }),
      },
      { timeoutMs: 20_000, maxRetries: 2 },
    );
    if (!res.ok) throw await failure(res, "Search Analytics query");
    const data = (await res.json()) as {
      rows?: Array<{
        keys?: string[];
        clicks?: number;
        impressions?: number;
        ctr?: number;
        position?: number;
      }>;
    };
    const rows = data.rows ?? [];
    for (const r of rows) {
      out.push({
        key: r.keys?.[0] ?? "",
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? null,
        position: r.position ?? null,
      });
    }
    if (rows.length < ROW_LIMIT) break;
  }
  return out;
}
