import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";
import { getGoogleAccessToken } from "./google-auth.ts";
import {
  GA4_METRICS,
  ga4DateToIso,
  normalizeGa4Rows,
  type Ga4Report,
} from "./normalize.ts";
import { defaultRange } from "./range.ts";
import type { SyncAdapter } from "./sync-run.ts";

const DEFAULT_DAYS_BACK = 30;
const BREAKDOWN_LIMIT = 10_000;

type BreakdownDimension = "country" | "page_title" | "channel";

interface Ga4BreakdownRow {
  site_id: string;
  metric_date: string;
  dimension: BreakdownDimension;
  dimension_value: string;
  active_users: number | null;
  sessions: number | null;
  screen_page_views: number | null;
  updated_at: string;
}

async function runReport(
  token: string,
  propertyId: string,
  body: Record<string, unknown>,
): Promise<Ga4Report> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(
    propertyId,
  )}:runReport`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new SyncError(
      codeForStatus(res.status),
      `GA4 API returned HTTP ${res.status}`,
      { status: res.status, retryable: isRetryableStatus(res.status) },
    );
  }
  return (await res.json()) as Ga4Report;
}

function intMetric(
  report: Ga4Report,
  row: NonNullable<Ga4Report["rows"]>[number],
  name: string,
): number {
  const headers = (report.metricHeaders ?? []).map((h) => h.name ?? "");
  const idx = headers.indexOf(name);
  if (idx < 0) throw new Error(`Missing GA4 metric header: ${name}`);
  const n = Number(row.metricValues?.[idx]?.value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function normalizeBreakdown(
  report: Ga4Report,
  siteId: string,
  dimension: BreakdownDimension,
  updatedAt: string,
): Ga4BreakdownRow[] {
  const byKey = new Map<string, Ga4BreakdownRow>();
  for (const row of report.rows ?? []) {
    const rawDate = row.dimensionValues?.[0]?.value;
    const value = row.dimensionValues?.[1]?.value?.trim();
    if (!rawDate || !value) continue;
    const metric_date = ga4DateToIso(rawDate);
    const base: Ga4BreakdownRow = {
      site_id: siteId,
      metric_date,
      dimension,
      dimension_value: value,
      active_users: null,
      sessions: null,
      screen_page_views: null,
      updated_at: updatedAt,
    };
    if (dimension === "country")
      base.active_users = intMetric(report, row, "activeUsers");
    if (dimension === "page_title")
      base.screen_page_views = intMetric(report, row, "screenPageViews");
    if (dimension === "channel")
      base.sessions = intMetric(report, row, "sessions");
    byKey.set(`${metric_date}\u0000${dimension}\u0000${value}`, base);
  }
  return [...byKey.values()];
}

/**
 * Google Analytics 4 sync:
 * - daily headline metrics (including Event count + Key events)
 * - country / page-title / session-channel breakdowns used by the richer
 *   Ninja Analytics GA4 dashboard.
 *
 * Breakdown failures are best-effort: the core daily report can still succeed
 * and the sync is marked partial instead of destroying already-stored data.
 */
export const ga4Adapter: SyncAdapter = async ({
  admin,
  site,
  rangeStart,
  rangeEnd,
}) => {
  if (!site.ga4_property_id) {
    throw new SyncError(
      "config_missing",
      "No GA4 property configured for this site",
    );
  }

  const { startDate, endDate } =
    rangeStart && rangeEnd
      ? { startDate: rangeStart, endDate: rangeEnd }
      : defaultRange(DEFAULT_DAYS_BACK);

  const token = await getGoogleAccessToken();
  const updatedAt = new Date().toISOString();

  const dailyReport = await runReport(token, site.ga4_property_id, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: GA4_METRICS.map((name) => ({ name })),
    keepEmptyRows: false,
  });

  const dailyRows = normalizeGa4Rows(dailyReport, site.id, updatedAt);
  if (dailyRows.length > 0) {
    const { error } = await admin
      .from("analytics_daily")
      .upsert(dailyRows, { onConflict: "site_id,metric_date" });
    if (error) throw error;
  }

  let rowsFetched = dailyReport.rows?.length ?? 0;
  let rowsWritten = dailyRows.length;
  const failedBreakdowns: string[] = [];
  const breakdownErrors: Record<string, string> = {};

  const specs = [
    {
      key: "country" as const,
      dimensionName: "country",
      metricName: "activeUsers",
    },
    {
      key: "page_title" as const,
      dimensionName: "pageTitle",
      metricName: "screenPageViews",
    },
    {
      key: "channel" as const,
      dimensionName: "sessionDefaultChannelGroup",
      metricName: "sessions",
    },
  ];

  for (const spec of specs) {
    try {
      const report = await runReport(token, site.ga4_property_id, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "date" }, { name: spec.dimensionName }],
        metrics: [{ name: spec.metricName }],
        keepEmptyRows: false,
        limit: BREAKDOWN_LIMIT,
      });
      const rows = normalizeBreakdown(report, site.id, spec.key, updatedAt);
      if (rows.length > 0) {
        const { error } = await admin.from("ga4_breakdown_daily").upsert(rows, {
          onConflict: "site_id,metric_date,dimension,dimension_value",
        });
        if (error) throw error;
      }
      rowsFetched += report.rows?.length ?? 0;
      rowsWritten += rows.length;
    } catch (err) {
      failedBreakdowns.push(spec.key);
      breakdownErrors[spec.key] =
        err instanceof Error ? err.message : String(err);
    }
  }

  return {
    rowsFetched,
    rowsWritten,
    partial: failedBreakdowns.length > 0,
    rangeStart: startDate,
    rangeEnd: endDate,
    metadata: {
      provider: "ga4",
      failedBreakdowns,
      breakdownErrors,
    },
  };
};
