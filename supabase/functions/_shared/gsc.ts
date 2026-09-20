import {
  SyncError,
  codeForStatus,
  isRetryableStatus,
  normalizeError,
} from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import { getGoogleAccessToken } from "./google-auth.ts";
import {
  normalizeGscRows,
  normalizeGscBreakdown,
  normalizeGscQueryPageBreakdown,
  normalizeGscSearchAppearance,
  type GscApiRow,
  type GscBreakdownRow,
} from "./normalize.ts";
import { defaultRange } from "./range.ts";
import type { SupabaseClient } from "./database.ts";
import type { SyncAdapter } from "./sync-run.ts";

// Re-fetch a rolling recent window by default so late-finalized GSC values
// overwrite earlier ones (brief §15).
const DEFAULT_DAYS_BACK = 10;
const BREAKDOWN_ROW_LIMIT = 5000;

async function queryGsc(
  token: string,
  property: string,
  body: Record<string, unknown>,
): Promise<GscApiRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    property,
  )}/searchAnalytics/query`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Google's Search Console API error body is always
    // {error: {code, message, status, errors: [...]}} - status is a short
    // reason taxonomy (e.g. INVALID_ARGUMENT for a malformed request,
    // PERMISSION_DENIED for a real access problem) and message is a plain
    // validation/permission explanation, never a credential - safe to
    // surface, and exactly what's needed to tell a code bug (fixable) apart
    // from a genuinely unsupported/unavailable request for this property
    // (not fixable, shouldn't be treated as a failure at all).
    let detail = "";
    let providerErrorCode: string | undefined;
    try {
      const errBody = (await res.json()) as {
        error?: { message?: string; status?: string };
      };
      providerErrorCode = errBody.error?.status;
      if (errBody.error?.message) {
        detail = `: ${errBody.error.message}`;
      }
    } catch {
      // Non-JSON body - fall back to the bare status.
    }
    throw new SyncError(
      codeForStatus(res.status),
      `GSC API returned HTTP ${res.status}${detail}`,
      {
        status: res.status,
        retryable: isRetryableStatus(res.status),
        providerErrorCode,
      },
    );
  }
  const data = (await res.json()) as { rows?: GscApiRow[] };
  return data.rows ?? [];
}

/**
 * Google Search Console sync: daily aggregate (search_daily) plus the top
 * queries and pages per day (search_query_daily / search_page_daily). The
 * aggregate is required; the breakdowns are best-effort - if one fails the run
 * is marked `partial` rather than losing the aggregate.
 */
export const gscAdapter: SyncAdapter = async ({
  admin,
  site,
  rangeStart,
  rangeEnd,
}) => {
  if (!site.gsc_property) {
    throw new SyncError(
      "config_missing",
      "No GSC property configured for this site",
    );
  }
  const property = site.gsc_property;

  const { startDate, endDate } =
    rangeStart && rangeEnd
      ? { startDate: rangeStart, endDate: rangeEnd }
      : defaultRange(DEFAULT_DAYS_BACK);

  const token = await getGoogleAccessToken();
  const updatedAt = new Date().toISOString();

  // --- Required: daily aggregate ---
  const aggregate = await queryGsc(token, property, {
    startDate,
    endDate,
    dimensions: ["date"],
    rowLimit: 25000,
  });
  const aggRows = normalizeGscRows(aggregate, site.id, updatedAt);
  if (aggRows.length > 0) {
    const { error } = await admin
      .from("search_daily")
      .upsert(aggRows, { onConflict: "site_id,engine,metric_date" });
    if (error) throw error;
  }

  let rowsFetched = aggregate.length;
  let rowsWritten = aggRows.length;
  const failed: string[] = [];
  // Diagnostic detail per failed breakdown - Google's own reason code/message
  // (never a credential), so a malformed request can be told apart from a
  // property that genuinely doesn't expose this data, instead of every
  // breakdown failure looking identical in Sync History. Additive only:
  // failedBreakdowns itself is unchanged (deploy-ninja-analytics.yml's own
  // gate reads that array directly).
  const breakdownErrors: Record<string, { code: string; message: string }> = {};

  function recordFailure(name: string, err: unknown) {
    failed.push(name);
    const n = normalizeError(err);
    breakdownErrors[name] = {
      code: n.providerErrorCode ?? n.code,
      message: n.message,
    };
  }

  // --- Best-effort: top queries ---
  try {
    const apiRows = await queryGsc(token, property, {
      startDate,
      endDate,
      dimensions: ["date", "query"],
      rowLimit: BREAKDOWN_ROW_LIMIT,
    });
    const written = await syncBreakdown(
      admin,
      "search_query_daily",
      "query",
      normalizeGscBreakdown(apiRows, BREAKDOWN_ROW_LIMIT),
      apiRows.length,
      site.id,
      updatedAt,
    );
    rowsFetched += written.fetched;
    rowsWritten += written.written;
  } catch (err) {
    recordFailure("query", err);
  }

  // --- Best-effort: top pages ---
  try {
    const apiRows = await queryGsc(token, property, {
      startDate,
      endDate,
      dimensions: ["date", "page"],
      rowLimit: BREAKDOWN_ROW_LIMIT,
    });
    const written = await syncBreakdown(
      admin,
      "search_page_daily",
      "page",
      normalizeGscBreakdown(apiRows, BREAKDOWN_ROW_LIMIT),
      apiRows.length,
      site.id,
      updatedAt,
    );
    rowsFetched += written.fetched;
    rowsWritten += written.written;
  } catch (err) {
    recordFailure("page", err);
  }

  // --- Best-effort: query+page (which URL actually ranks for which query -
  // keyword-intelligence Phase 1). Independent of the two breakdowns above:
  // a failure here never affects them, and their failure never blocks this.
  try {
    const written = await syncQueryPageBreakdown(
      admin,
      await queryGsc(token, property, {
        startDate,
        endDate,
        dimensions: ["date", "query", "page"],
        rowLimit: BREAKDOWN_ROW_LIMIT,
      }),
      site.id,
      updatedAt,
    );
    rowsFetched += written.fetched;
    rowsWritten += written.written;
  } catch (err) {
    recordFailure("query_page", err);
  }

  // --- Best-effort: search appearance (CLAUDE.md Phase 8 / "AI Search
  // source coverage" - "GSC Generative AI features data where exposed").
  // Google has not published a fixed enum of searchAppearance values for AI
  // features, so every value GSC returns is stored verbatim; the UI applies
  // a heuristic "looks AI-related" filter rather than assuming a name.
  //
  // Unlike every other breakdown here, this one must NOT include "date" -
  // Google's API rejects combining searchAppearance with any other
  // dimension ("Cannot group by search appearance dimension together with
  // another dimension", confirmed live). So this is queried alone and
  // normalized differently (normalizeGscSearchAppearance, not
  // normalizeGscBreakdown): one row per appearance type, aggregated over
  // the whole range, anchored to endDate as its metric_date - see the
  // schema comment on search_appearance_daily (0016 migration) for what
  // that means for this one table.
  try {
    const apiRows = await queryGsc(token, property, {
      startDate,
      endDate,
      dimensions: ["searchAppearance"],
      rowLimit: BREAKDOWN_ROW_LIMIT,
    });
    const written = await syncBreakdown(
      admin,
      "search_appearance_daily",
      "search_appearance",
      normalizeGscSearchAppearance(apiRows, endDate, BREAKDOWN_ROW_LIMIT),
      apiRows.length,
      site.id,
      updatedAt,
    );
    rowsFetched += written.fetched;
    rowsWritten += written.written;
  } catch (err) {
    recordFailure("search_appearance", err);
  }

  return {
    rowsFetched,
    rowsWritten,
    partial: failed.length > 0,
    rangeStart: startDate,
    rangeEnd: endDate,
    metadata: { provider: "gsc", failedBreakdowns: failed, breakdownErrors },
  };
};

async function syncBreakdown(
  admin: SupabaseClient,
  table: "search_query_daily" | "search_page_daily" | "search_appearance_daily",
  keyColumn: "query" | "page" | "search_appearance",
  normalizedRows: GscBreakdownRow[],
  fetchedCount: number,
  siteId: string,
  updatedAt: string,
): Promise<{ fetched: number; written: number }> {
  const rows = normalizedRows.map((r) => ({
    site_id: siteId,
    engine: "google" as const,
    metric_date: r.metric_date,
    [keyColumn]: r.key,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    average_position: r.average_position,
    updated_at: updatedAt,
  }));

  if (rows.length > 0) {
    const { error } = await admin
      .from(table)
      .upsert(rows, { onConflict: `site_id,engine,metric_date,${keyColumn}` });
    if (error) throw error;
  }
  return { fetched: fetchedCount, written: rows.length };
}

async function syncQueryPageBreakdown(
  admin: SupabaseClient,
  apiRows: GscApiRow[],
  siteId: string,
  updatedAt: string,
): Promise<{ fetched: number; written: number }> {
  const rows = normalizeGscQueryPageBreakdown(apiRows, BREAKDOWN_ROW_LIMIT).map(
    (r) => ({
      site_id: siteId,
      engine: "google" as const,
      metric_date: r.metric_date,
      query: r.query,
      page: r.page,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      average_position: r.average_position,
      updated_at: updatedAt,
    }),
  );

  if (rows.length > 0) {
    const { error } = await admin
      .from("search_query_page_daily")
      .upsert(rows, { onConflict: "site_id,engine,metric_date,query,page" });
    if (error) throw error;
  }
  return { fetched: apiRows.length, written: rows.length };
}
