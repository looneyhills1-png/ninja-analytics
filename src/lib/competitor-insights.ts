// Observed competitor discovery + Observed Keyword Gap (CLAUDE.md Phase 2).
// Built bottom-up, entirely from SERP observations this app's own admins
// have actually recorded (observed_serp_results) - never a claim to a
// complete Google-wide keyword database, and never a paid competitor-data
// API. "Observed" in every name here is load-bearing: a domain or keyword
// this shows nothing for may simply never have been checked, not proof it
// doesn't exist.

export type RankEngine = "google" | "bing";

export interface CompetitorDomainRow {
  id: string;
  siteId: string;
  domain: string;
  label: string | null;
  note: string | null;
  autoDiscovered: boolean;
  createdAt: string;
}

export interface ObservedSerpResultRow {
  id: string;
  siteId: string;
  query: string;
  engine: RankEngine;
  observedAt: string;
  domain: string;
  url: string | null;
  rankObserved: number | null;
  isOwnSite: boolean;
}

export type KeywordGapCategory =
  | "missing" // competitor observed ranking, we were not
  | "unique" // we were observed ranking, competitor was not
  | "stronger" // both observed, our rank is better (lower)
  | "weaker" // both observed, our rank is worse (higher)
  | "shared"; // both observed, tied (or rank unknown for one/both)

export interface KeywordGapRow {
  query: string;
  engine: RankEngine;
  category: KeywordGapCategory;
  ourRank: number | null;
  ourUrl: string | null;
  competitorRank: number | null;
  competitorUrl: string | null;
  lastObservedAt: string;
}

export interface AppearanceTrendPoint {
  date: string; // yyyy-MM-dd
  count: number;
}

export interface CompetitorInsight {
  domain: string;
  label: string | null;
  autoDiscovered: boolean;
  appearanceCount: number;
  appearanceTrend: AppearanceTrendPoint[];
  gap: KeywordGapRow[];
  sharedCount: number;
  strongerCount: number;
  weakerCount: number;
  missingCount: number;
  uniqueCount: number;
}

interface ObservationGroup {
  query: string;
  engine: RankEngine;
  observedAt: string;
  own: ObservedSerpResultRow | null;
  competitor: ObservedSerpResultRow | null;
}

/** Groups raw SERP-result rows into one row per (query, engine, observedAt)
 * "observation session" - the unit a single admin SERP check produced. */
function groupObservations(
  rows: ObservedSerpResultRow[],
  domain: string,
): ObservationGroup[] {
  const bySession = new Map<string, ObservationGroup>();
  for (const row of rows) {
    if (!row.isOwnSite && row.domain !== domain) continue;
    const key = `${row.query}\u0000${row.engine}\u0000${row.observedAt}`;
    let group = bySession.get(key);
    if (!group) {
      group = {
        query: row.query,
        engine: row.engine,
        observedAt: row.observedAt,
        own: null,
        competitor: null,
      };
      bySession.set(key, group);
    }
    if (row.isOwnSite) group.own = row;
    if (row.domain === domain) group.competitor = row;
  }
  return [...bySession.values()];
}

function classify(group: ObservationGroup): KeywordGapCategory {
  const ourRank = group.own?.rankObserved ?? null;
  const competitorRank = group.competitor?.rankObserved ?? null;
  if (group.own && !group.competitor) return "unique";
  if (!group.own && group.competitor) return "missing";
  if (ourRank == null || competitorRank == null) return "shared";
  if (ourRank < competitorRank) return "stronger";
  if (ourRank > competitorRank) return "weaker";
  return "shared";
}

/**
 * One CompetitorInsight per tracked competitor domain: how often it has
 * shown up in a recorded SERP observation, the trend of that over time, and
 * the current Observed Keyword Gap (one row per query, using each query's
 * most recent observation session so the gap table reflects current state
 * while appearanceCount/trend still reflect the full history).
 */
export function computeCompetitorInsights(
  competitors: CompetitorDomainRow[],
  serpResults: ObservedSerpResultRow[],
): CompetitorInsight[] {
  return competitors.map((competitor) => {
    const domainRows = serpResults.filter(
      (r) => r.domain === competitor.domain,
    );
    const appearanceCount = domainRows.length;

    const trendByDate = new Map<string, number>();
    for (const row of domainRows) {
      const date = row.observedAt.slice(0, 10);
      trendByDate.set(date, (trendByDate.get(date) ?? 0) + 1);
    }
    const appearanceTrend = [...trendByDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, count]) => ({ date, count }));

    const groups = groupObservations(serpResults, competitor.domain);
    const latestByQuery = new Map<string, ObservationGroup>();
    for (const group of groups) {
      const key = `${group.query}\u0000${group.engine}`;
      const existing = latestByQuery.get(key);
      if (!existing || group.observedAt > existing.observedAt) {
        latestByQuery.set(key, group);
      }
    }

    const gap: KeywordGapRow[] = [...latestByQuery.values()].map((group) => ({
      query: group.query,
      engine: group.engine,
      category: classify(group),
      ourRank: group.own?.rankObserved ?? null,
      ourUrl: group.own?.url ?? null,
      competitorRank: group.competitor?.rankObserved ?? null,
      competitorUrl: group.competitor?.url ?? null,
      lastObservedAt: group.observedAt,
    }));
    gap.sort((a, b) => (a.lastObservedAt < b.lastObservedAt ? 1 : -1));

    return {
      domain: competitor.domain,
      label: competitor.label,
      autoDiscovered: competitor.autoDiscovered,
      appearanceCount,
      appearanceTrend,
      gap,
      sharedCount: gap.filter((g) => g.category === "shared").length,
      strongerCount: gap.filter((g) => g.category === "stronger").length,
      weakerCount: gap.filter((g) => g.category === "weaker").length,
      missingCount: gap.filter((g) => g.category === "missing").length,
      uniqueCount: gap.filter((g) => g.category === "unique").length,
    };
  });
}

export interface CompetitorSuggestion {
  domain: string;
  appearanceCount: number;
  lastObservedAt: string;
}

const MIN_SUGGESTION_APPEARANCES = 2;

/**
 * "Auto-discover competitors from observed SERPs where data exists": domains
 * that keep showing up in recorded SERP observations but aren't already
 * tracked - a suggestion list, not an automatic addition, since a repeatedly
 * observed domain still needs a human call on whether it's a real
 * competitor.
 */
export function suggestCompetitorDomains(
  competitors: CompetitorDomainRow[],
  serpResults: ObservedSerpResultRow[],
  minAppearances = MIN_SUGGESTION_APPEARANCES,
): CompetitorSuggestion[] {
  const tracked = new Set(competitors.map((c) => c.domain));
  const byDomain = new Map<string, { count: number; lastObservedAt: string }>();
  for (const row of serpResults) {
    if (row.isOwnSite || tracked.has(row.domain)) continue;
    const existing = byDomain.get(row.domain);
    if (existing) {
      existing.count += 1;
      if (row.observedAt > existing.lastObservedAt) {
        existing.lastObservedAt = row.observedAt;
      }
    } else {
      byDomain.set(row.domain, { count: 1, lastObservedAt: row.observedAt });
    }
  }
  return [...byDomain.entries()]
    .filter(([, v]) => v.count >= minAppearances)
    .map(([domain, v]) => ({
      domain,
      appearanceCount: v.count,
      lastObservedAt: v.lastObservedAt,
    }))
    .sort((a, b) => b.appearanceCount - a.appearanceCount);
}
