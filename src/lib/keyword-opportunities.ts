// The Keyword Opportunity Engine (CLAUDE.md Phase 1). Pure computation over
// rows the browser already fetched from search_query_daily,
// search_query_page_daily and (optionally) Bing's search_query_daily rows -
// no new provider calls, no external SEO API, nothing invented. Every
// opportunity row explains itself: category, score, and a recommended
// action, all derived only from data this app actually holds.

import { percentageChange, sumBy } from "@/lib/metrics";
import { brandTokensFor, isBrandedQuery } from "@/lib/brand-terms";
import {
  computeOpportunityScore,
  expectedCtrForPosition,
  type OpportunityScoreResult,
} from "@/lib/opportunity-score";

export interface QueryDailyRow {
  metric_date: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  average_position: number | null;
}

export interface QueryPageDailyRow {
  metric_date: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
}

export type OpportunityCategory =
  | "strike-now"
  | "page-2"
  | "high-impression-low-ctr"
  | "rising"
  | "falling"
  | "new"
  | "lost"
  | "ranking-url-changed"
  | "cannibalisation"
  | "wrong-page"
  | "content-decay";

export type KeywordTrend = "rising" | "falling" | "stable" | "new" | "lost";

export interface KeywordOpportunityRow {
  query: string;
  rankingUrl: string | null;
  previousRankingUrl: string | null;
  competingUrls: string[];
  clicks: number;
  clicksPrev: number;
  clicksChangePct: number | null;
  impressions: number;
  impressionsPrev: number;
  impressionsChangePct: number | null;
  ctr: number | null;
  currentPosition: number | null;
  previousPosition: number | null;
  positionChange: number | null;
  positionStability: number | null;
  firstSeen: string;
  lastSeen: string;
  trend: KeywordTrend;
  branded: boolean;
  bingImpressions: number;
  categories: OpportunityCategory[];
  score: OpportunityScoreResult;
  recommendedAction: string;
}

// Thresholds - deliberately conservative and named so they're easy to tune.
const MIN_IMPRESSIONS_FOR_OPPORTUNITY = 10;
const HIGH_IMPRESSION_THRESHOLD = 100;
const LOW_CTR_RATIO = 0.5; // actual CTR below 50% of the position benchmark
const RISING_THRESHOLD_PCT = 15;
const FALLING_THRESHOLD_PCT = -15;
const DECAY_MIN_PREVIOUS_CLICKS = 10;
const DECAY_DROP_PCT = -25;
const CANNIBALISATION_MIN_IMPRESSIONS = 5;
const BING_CORROBORATION_MIN_IMPRESSIONS = 5;

function isoMinus(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function weightedCtrOf(
  rows: { clicks: number; impressions: number }[],
): number | null {
  const clicks = sumBy(rows, (r) => r.clicks);
  const impressions = sumBy(rows, (r) => r.impressions);
  return impressions > 0 ? clicks / impressions : null;
}

function weightedPositionOf(
  rows: { impressions: number; average_position: number | null }[],
): number | null {
  let weighted = 0;
  let impressions = 0;
  for (const r of rows) {
    if (r.average_position == null || r.impressions <= 0) continue;
    weighted += r.average_position * r.impressions;
    impressions += r.impressions;
  }
  return impressions === 0 ? null : weighted / impressions;
}

function positionStdDev(
  rows: { average_position: number | null }[],
): number | null {
  const positions = rows
    .map((r) => r.average_position)
    .filter((p): p is number => p != null);
  if (positions.length < 3) return null;
  const mean = positions.reduce((a, b) => a + b, 0) / positions.length;
  const variance =
    positions.reduce((a, b) => a + (b - mean) ** 2, 0) / positions.length;
  return Math.sqrt(variance);
}

/** Top page by clicks (tie-broken by impressions) for a set of same-query
 * query-page rows - the one real, exact "ranking URL" GSC data supports. */
function topPageOf(
  rows: QueryPageDailyRow[],
): { page: string; competing: string[] } | null {
  if (rows.length === 0) return null;
  const byPage = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    const agg = byPage.get(r.page) ?? { clicks: 0, impressions: 0 };
    agg.clicks += r.clicks;
    agg.impressions += r.impressions;
    byPage.set(r.page, agg);
  }
  const ranked = [...byPage.entries()].sort(
    (a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions,
  );
  const competing = ranked
    .filter(([, agg]) => agg.impressions >= CANNIBALISATION_MIN_IMPRESSIONS)
    .map(([page]) => page);
  return { page: ranked[0][0], competing };
}

/** Weak heuristic only - flagged as such wherever it's shown. A ranking URL
 * whose path contains none of the query's own significant words is *possibly*
 * a content/intent mismatch, not proof of one. */
function looksLikeWrongPage(query: string, url: string): boolean {
  const queryTokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (queryTokens.length === 0) return false;
  const urlText = url.toLowerCase();
  const matches = queryTokens.filter((t) => urlText.includes(t));
  return matches.length === 0;
}

function recommendedActionFor(
  categories: OpportunityCategory[],
  row: Pick<
    KeywordOpportunityRow,
    "currentPosition" | "competingUrls" | "rankingUrl"
  >,
): string {
  if (categories.includes("cannibalisation")) {
    return `${row.competingUrls.length} pages compete for this query - pick one as canonical, strengthen it, and de-optimise or merge the others.`;
  }
  if (categories.includes("ranking-url-changed")) {
    return "The ranking URL changed recently - confirm the new page is the right one and update internal links pointing to the old URL.";
  }
  if (categories.includes("content-decay")) {
    return "Clicks have dropped sharply - refresh the content, check for a ranking loss, and verify the page still matches search intent.";
  }
  if (categories.includes("strike-now")) {
    return "Close to page 1 - strengthen on-page content, add internal links, and target the query's exact phrasing in the title/H1.";
  }
  if (categories.includes("wrong-page")) {
    return "The ranking page doesn't obviously match this query - consider a more relevant page or adding content that targets it directly.";
  }
  if (categories.includes("high-impression-low-ctr")) {
    return "Good visibility but a weak click-through rate - rewrite the title and meta description to better match the query intent.";
  }
  if (categories.includes("page-2")) {
    return "On page 2 - needs a bigger push (content depth, internal links, or a dedicated page) to reach page 1.";
  }
  if (categories.includes("falling")) {
    return "Losing clicks recently - check for a ranking drop, a competitor gaining ground, or seasonal demand change.";
  }
  if (categories.includes("rising")) {
    return "Gaining clicks - double down with more internal links or supporting content while the momentum is real.";
  }
  if (categories.includes("new")) {
    return "A newly-appearing query - monitor it and consider a dedicated page or section if the demand holds up.";
  }
  if (categories.includes("lost")) {
    return "This query stopped appearing - check for a ranking loss, a removed/redirected page, or seasonality.";
  }
  return "Monitor - no strong signal yet.";
}

export interface ComputeOpportunitiesInput {
  site: { domain: string; name: string };
  queryRows: QueryDailyRow[]; // engine=google
  bingQueryRows: QueryDailyRow[]; // engine=bing
  queryPageRows: QueryPageDailyRow[]; // engine=google
  days: number;
}

/**
 * Build one KeywordOpportunityRow per query seen in the current or previous
 * window (union - a "lost" query has current=0 but must still appear).
 * Anchored to the latest date actually present in the data, same pattern as
 * lib/search-terms.ts, so a reporting lag never skews the comparison.
 */
export function computeKeywordOpportunities(
  input: ComputeOpportunitiesInput,
): KeywordOpportunityRow[] {
  const { queryRows, bingQueryRows, queryPageRows, days } = input;
  if (queryRows.length === 0) return [];

  let latest = queryRows[0].metric_date;
  for (const r of queryRows) if (r.metric_date > latest) latest = r.metric_date;

  const currentStart = isoMinus(latest, days - 1);
  const previousStart = isoMinus(latest, days * 2 - 1);

  const byQuery = new Map<
    string,
    {
      current: QueryDailyRow[];
      previous: QueryDailyRow[];
      all: QueryDailyRow[];
    }
  >();
  for (const r of queryRows) {
    let bucket = byQuery.get(r.query);
    if (!bucket) {
      bucket = { current: [], previous: [], all: [] };
      byQuery.set(r.query, bucket);
    }
    bucket.all.push(r);
    if (r.metric_date >= currentStart) bucket.current.push(r);
    else if (r.metric_date >= previousStart) bucket.previous.push(r);
  }

  const bingByQuery = new Map<string, QueryDailyRow[]>();
  for (const r of bingQueryRows) {
    if (r.metric_date < currentStart) continue;
    const list = bingByQuery.get(r.query) ?? [];
    list.push(r);
    bingByQuery.set(r.query, list);
  }

  const pageRowsByQuery = new Map<
    string,
    { current: QueryPageDailyRow[]; previous: QueryPageDailyRow[] }
  >();
  for (const r of queryPageRows) {
    let bucket = pageRowsByQuery.get(r.query);
    if (!bucket) {
      bucket = { current: [], previous: [] };
      pageRowsByQuery.set(r.query, bucket);
    }
    if (r.metric_date >= currentStart) bucket.current.push(r);
    else if (r.metric_date >= previousStart) bucket.previous.push(r);
  }

  const brandTokens = brandTokensFor(input.site);

  const out: KeywordOpportunityRow[] = [];

  for (const [query, bucket] of byQuery) {
    const clicks = sumBy(bucket.current, (r) => r.clicks);
    const impressions = sumBy(bucket.current, (r) => r.impressions);
    const clicksPrev = sumBy(bucket.previous, (r) => r.clicks);
    const impressionsPrev = sumBy(bucket.previous, (r) => r.impressions);
    const ctr = weightedCtrOf(bucket.current);
    const currentPosition = weightedPositionOf(bucket.current);
    const previousPosition = weightedPositionOf(bucket.previous);
    const positionChange =
      currentPosition != null && previousPosition != null
        ? previousPosition - currentPosition
        : null;
    const positionStability = positionStdDev(bucket.current);

    const firstSeen = bucket.all.reduce(
      (min, r) => (r.metric_date < min ? r.metric_date : min),
      bucket.all[0].metric_date,
    );
    const lastSeen = bucket.all.reduce(
      (max, r) => (r.metric_date > max ? r.metric_date : max),
      bucket.all[0].metric_date,
    );

    const hasCurrent = clicks > 0 || impressions > 0;
    const hasPrevious = clicksPrev > 0 || impressionsPrev > 0;

    let trend: KeywordTrend;
    if (hasCurrent && !hasPrevious && firstSeen >= currentStart) {
      trend = "new";
    } else if (!hasCurrent && hasPrevious) {
      trend = "lost";
    } else {
      const pct = percentageChange(clicks, clicksPrev);
      if (pct != null && pct >= RISING_THRESHOLD_PCT) trend = "rising";
      else if (pct != null && pct <= FALLING_THRESHOLD_PCT) trend = "falling";
      else trend = "stable";
    }

    const pageRows = pageRowsByQuery.get(query);
    const currentPages = pageRows ? topPageOf(pageRows.current) : null;
    const previousPages = pageRows ? topPageOf(pageRows.previous) : null;
    const rankingUrl = currentPages?.page ?? null;
    const previousRankingUrl = previousPages?.page ?? null;
    const competingUrls = currentPages?.competing ?? [];
    const rankingUrlChanged =
      rankingUrl != null &&
      previousRankingUrl != null &&
      rankingUrl !== previousRankingUrl;

    const bingRows = bingByQuery.get(query) ?? [];
    const bingImpressions = sumBy(bingRows, (r) => r.impressions);
    const bingCorroboration =
      bingImpressions >= BING_CORROBORATION_MIN_IMPRESSIONS;

    const branded = isBrandedQuery(query, brandTokens);

    const categories: OpportunityCategory[] = [];
    const meaningfulImpressions =
      impressions >= MIN_IMPRESSIONS_FOR_OPPORTUNITY;

    if (
      meaningfulImpressions &&
      currentPosition != null &&
      currentPosition >= 4 &&
      currentPosition <= 10
    ) {
      categories.push("strike-now");
    }
    if (
      meaningfulImpressions &&
      currentPosition != null &&
      currentPosition > 10 &&
      currentPosition <= 20
    ) {
      categories.push("page-2");
    }
    if (
      impressions >= HIGH_IMPRESSION_THRESHOLD &&
      ctr != null &&
      currentPosition != null &&
      ctr < expectedCtrForPosition(currentPosition) * LOW_CTR_RATIO
    ) {
      categories.push("high-impression-low-ctr");
    }
    if (trend === "rising") categories.push("rising");
    if (trend === "falling") categories.push("falling");
    if (trend === "new") categories.push("new");
    if (trend === "lost") categories.push("lost");
    if (rankingUrlChanged) categories.push("ranking-url-changed");
    if (competingUrls.length >= 2) categories.push("cannibalisation");
    if (
      rankingUrl &&
      meaningfulImpressions &&
      currentPosition != null &&
      currentPosition > 10 &&
      looksLikeWrongPage(query, rankingUrl)
    ) {
      categories.push("wrong-page");
    }
    if (
      clicksPrev >= DECAY_MIN_PREVIOUS_CLICKS &&
      (percentageChange(clicks, clicksPrev) ?? 0) <= DECAY_DROP_PCT
    ) {
      categories.push("content-decay");
    }

    const score = computeOpportunityScore({
      currentPosition,
      previousPosition,
      impressions,
      ctr,
      clicksChangePct: percentageChange(clicks, clicksPrev),
      positionStability,
      competingUrlCount: competingUrls.length,
      bingCorroboration,
    });

    const row: KeywordOpportunityRow = {
      query,
      rankingUrl,
      previousRankingUrl,
      competingUrls,
      clicks,
      clicksPrev,
      clicksChangePct: percentageChange(clicks, clicksPrev),
      impressions,
      impressionsPrev,
      impressionsChangePct: percentageChange(impressions, impressionsPrev),
      ctr,
      currentPosition,
      previousPosition,
      positionChange,
      positionStability,
      firstSeen,
      lastSeen,
      trend,
      branded,
      bingImpressions,
      categories,
      score,
      recommendedAction: "",
    };
    row.recommendedAction = recommendedActionFor(categories, row);
    out.push(row);
  }

  return out.sort((a, b) => b.score.score - a.score.score);
}
