// Pure Bing parsing - isolated here so the older Bing API format can be swapped
// without touching the rest of the system. No Deno/npm imports → unit-testable.

const MS_DATE_RE = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//;

function toInt(value: unknown): number {
  const n =
    typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parse Bing's Microsoft JSON date, e.g. "/Date(1718841600000+0000)/", into a
 * UTC "YYYY-MM-DD". The epoch milliseconds are absolute, so the trailing offset
 * is ignored. Also tolerates a plain ISO date if Bing ever returns one. Returns
 * null for anything unparseable.
 */
export function parseMicrosoftDate(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const m = value.match(MS_DATE_RE);
  if (m) {
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? isoDate(new Date(ms)) : null;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return isoDate(new Date(value));
  }
  return null;
}

export interface BingApiRow {
  Date?: string;
  Clicks?: number;
  Impressions?: number;
}

export interface BingQueryStatsRow extends BingApiRow {
  Query?: string;
  AvgClickPosition?: number;
  AvgImpressionPosition?: number;
}

export interface BingSiteRecord {
  Url?: string;
  IsVerified?: boolean;
  [key: string]: unknown;
}

/** Normalize a site URL for comparison - protocol, www and trailing slash all
 * vary between what's configured and what a provider returns for "the same"
 * site, so a byte-for-byte match would false-negative constantly. */
export function normalizeSiteUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Find the exact site record Bing itself returned for a configured URL -
 * never assume the configured value is what the API actually grants access
 * to. Returns null if this API key has no access to that site at all.
 */
export function findMatchingBingSite(
  sites: BingSiteRecord[],
  configuredUrl: string,
): BingSiteRecord | null {
  const target = normalizeSiteUrl(configuredUrl);
  return (
    sites.find(
      (s) => typeof s.Url === "string" && normalizeSiteUrl(s.Url) === target,
    ) ?? null
  );
}

/**
 * Bing's legacy JSON-RPC-style API can return HTTP 200 with an error
 * description instead of (or alongside) the `d` array. A bare {"d": [...]}
 * is the only shape that counts as a legitimate response; anything else -
 * extra top-level keys, or `d` missing/null - must not be read as "no data".
 */
export function hasEmbeddedBingError(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return true;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  const nonDataKeys = keys.filter(
    (k) => k.toLowerCase() !== "d" && k.toLowerCase() !== "__type",
  );
  const d = (parsed as Record<string, unknown>).d;
  return nonDataKeys.length > 0 || d === undefined || d === null;
}

export interface BingDailyRow {
  site_id: string;
  engine: "bing";
  metric_date: string;
  clicks: number;
  impressions: number;
  ctr: null;
  average_position: null;
  updated_at: string;
}

/**
 * Map Bing's `d` array into search_daily rows. CTR and average position are not
 * provided by this endpoint, so they stay null (the UI renders "-", never 0).
 * Rows are deduped by date (a duplicate would break the upsert) and capped to
 * bound an unreasonable payload.
 */
export function normalizeBingRows(
  rows: BingApiRow[] | undefined,
  siteId: string,
  updatedAt: string,
  maxRows = 1000,
): BingDailyRow[] {
  const byDate = new Map<string, BingDailyRow>();
  for (const r of rows ?? []) {
    const metric_date = parseMicrosoftDate(r.Date);
    if (!metric_date) continue;
    byDate.set(metric_date, {
      site_id: siteId,
      engine: "bing",
      metric_date,
      clicks: toInt(r.Clicks),
      impressions: toInt(r.Impressions),
      ctr: null,
      average_position: null,
      updated_at: updatedAt,
    });
  }
  return [...byDate.values()].slice(0, maxRows);
}


export interface BingTermDailyRow {
  site_id: string;
  engine: "bing";
  metric_date: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  average_position: number | null;
  updated_at: string;
}

export interface BingPageDailyRow {
  site_id: string;
  engine: "bing";
  metric_date: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  average_position: number | null;
  updated_at: string;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function statsMetrics(r: BingQueryStatsRow) {
  const clicks = toInt(r.Clicks);
  const impressions = toInt(r.Impressions);
  const average_position = finiteNumber(r.AvgImpressionPosition);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    average_position,
  };
}

/**
 * Bing's GetQueryStats returns weekly-updated keyword rows. Preserve the
 * provider's own Date and Query rather than pretending these are daily web
 * search totals. Rows are deduped by date+query for safe upsert.
 */
export function normalizeBingQueryRows(
  rows: BingQueryStatsRow[] | undefined,
  siteId: string,
  updatedAt: string,
  maxRows = 5000,
): BingTermDailyRow[] {
  const byKey = new Map<string, BingTermDailyRow>();
  for (const r of rows ?? []) {
    const metric_date = parseMicrosoftDate(r.Date);
    const query = typeof r.Query === "string" ? r.Query.trim() : "";
    if (!metric_date || !query) continue;
    const m = statsMetrics(r);
    byKey.set(`${metric_date}\u0000${query}`, {
      site_id: siteId,
      engine: "bing",
      metric_date,
      query,
      ...m,
      updated_at: updatedAt,
    });
  }
  return [...byKey.values()].slice(0, maxRows);
}

/**
 * Bing's GetPageStats uses the Query field to carry the page URL. Store it
 * in search_page_daily.page and retain Bing's impressions/clicks/position.
 */
export function normalizeBingPageRows(
  rows: BingQueryStatsRow[] | undefined,
  siteId: string,
  updatedAt: string,
  maxRows = 5000,
): BingPageDailyRow[] {
  const byKey = new Map<string, BingPageDailyRow>();
  for (const r of rows ?? []) {
    const metric_date = parseMicrosoftDate(r.Date);
    const page = typeof r.Query === "string" ? r.Query.trim() : "";
    if (!metric_date || !page) continue;
    const m = statsMetrics(r);
    byKey.set(`${metric_date}\u0000${page}`, {
      site_id: siteId,
      engine: "bing",
      metric_date,
      page,
      ...m,
      updated_at: updatedAt,
    });
  }
  return [...byKey.values()].slice(0, maxRows);
}
