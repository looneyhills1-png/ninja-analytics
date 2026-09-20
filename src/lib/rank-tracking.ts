// Real tracked-keyword rank tracking (CLAUDE.md Phase 2). Pure computation
// over tracked_rank_keywords + rank_snapshots rows the browser already
// fetched. Every observation this app has ever recorded stays in history -
// this module only reads it, it never overwrites or collapses it. GSC's
// average position is looked up separately and kept as its own field on the
// output row - it must never be confused with, or silently substituted for,
// an actual observed rank.

export type RankEngine = "google" | "bing";
export type RankDevice = "desktop" | "mobile";
export type RankSource = "manual" | "observed_serp";

export interface TrackedRankKeywordRow {
  id: string;
  siteId: string;
  query: string;
  engine: RankEngine;
  device: RankDevice;
  country: string | null;
  location: string | null;
  createdAt: string;
}

export interface RankSnapshotRow {
  id: string;
  siteId: string;
  query: string;
  engine: RankEngine;
  device: RankDevice;
  country: string | null;
  location: string | null;
  rankingUrl: string | null;
  observedRank: number | null;
  source: RankSource;
  checkedAt: string;
}

export interface RankMovement {
  d1: number | null;
  d7: number | null;
  d28: number | null;
}

export interface TrackedKeywordInsight {
  keyword: TrackedRankKeywordRow;
  /** Every matching snapshot, oldest first - the full observation history. */
  history: RankSnapshotRow[];
  currentRank: number | null;
  currentRankingUrl: string | null;
  currentSource: RankSource | null;
  currentCheckedAt: string | null;
  bestRank: number | null;
  worstRank: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Positive = improved (rank number went down) over that window. */
  movement: RankMovement;
  /** Cross-referenced from GSC's own average_position for the same query -
   * deliberately a separate field, never blended into currentRank. */
  gscAveragePosition: number | null;
}

function dimensionKey(row: {
  siteId: string;
  query: string;
  engine: RankEngine;
  device: RankDevice;
  country: string | null;
  location: string | null;
}): string {
  return [
    row.siteId,
    row.query,
    row.engine,
    row.device,
    row.country ?? "",
    row.location ?? "",
  ].join("\u0000");
}

function movementFor(
  history: RankSnapshotRow[],
  currentRank: number | null,
  nowMs: number,
  days: number,
): number | null {
  if (currentRank == null) return null;
  const cutoff = nowMs - days * 86_400_000;
  // The most recent snapshot at or before the cutoff - the closest thing to
  // "what was the rank N days ago" this observation history supports.
  let reference: RankSnapshotRow | null = null;
  for (const snap of history) {
    const t = Date.parse(snap.checkedAt);
    if (
      t <= cutoff &&
      (reference == null || t > Date.parse(reference.checkedAt))
    ) {
      reference = snap;
    }
  }
  if (!reference || reference.observedRank == null) return null;
  return reference.observedRank - currentRank;
}

export interface EngineQueryPositionRow {
  engine: RankEngine;
  query: string;
  impressions: number;
  averagePosition: number | null;
}

/**
 * Impressions-weighted average position per (engine, query), keyed the same
 * way computeTrackedKeywordInsights expects - so a Bing-tracked keyword only
 * ever picks up a Bing average position, never Google's.
 */
export function computeEngineAveragePositions(
  rows: EngineQueryPositionRow[],
): Map<string, number | null> {
  const byKey = new Map<string, { weighted: number; impressions: number }>();
  for (const row of rows) {
    if (row.averagePosition == null || row.impressions <= 0) continue;
    const key = `${row.engine}\u0000${row.query.toLowerCase()}`;
    const agg = byKey.get(key) ?? { weighted: 0, impressions: 0 };
    agg.weighted += row.averagePosition * row.impressions;
    agg.impressions += row.impressions;
    byKey.set(key, agg);
  }
  const out = new Map<string, number | null>();
  for (const [key, agg] of byKey) {
    out.set(key, agg.impressions > 0 ? agg.weighted / agg.impressions : null);
  }
  return out;
}

/**
 * Builds one insight row per tracked keyword, matching snapshots by the same
 * (site, query, engine, device, country, location) dimensions. `gscPositions`
 * maps `${engine}\u0000${query}` (lowercased) to GSC's average_position, so
 * Bing-tracked keywords never accidentally pick up a Google GSC number.
 */
export function computeTrackedKeywordInsights(
  keywords: TrackedRankKeywordRow[],
  snapshots: RankSnapshotRow[],
  gscPositions: Map<string, number | null>,
  now: Date = new Date(),
): TrackedKeywordInsight[] {
  const byDimension = new Map<string, RankSnapshotRow[]>();
  for (const snap of snapshots) {
    const key = dimensionKey(snap);
    const list = byDimension.get(key) ?? [];
    list.push(snap);
    byDimension.set(key, list);
  }
  for (const list of byDimension.values()) {
    list.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  }

  const nowMs = now.getTime();

  return keywords.map((keyword) => {
    const history = byDimension.get(dimensionKey(keyword)) ?? [];
    const latest = history.length ? history[history.length - 1] : null;
    const ranked = history.filter((h) => h.observedRank != null);
    const bestRank = ranked.length
      ? Math.min(...ranked.map((h) => h.observedRank!))
      : null;
    const worstRank = ranked.length
      ? Math.max(...ranked.map((h) => h.observedRank!))
      : null;

    const gscKey = `${keyword.engine}\u0000${keyword.query.toLowerCase()}`;

    return {
      keyword,
      history,
      currentRank: latest?.observedRank ?? null,
      currentRankingUrl: latest?.rankingUrl ?? null,
      currentSource: latest?.source ?? null,
      currentCheckedAt: latest?.checkedAt ?? null,
      bestRank,
      worstRank,
      firstSeen: history.length ? history[0].checkedAt : null,
      lastSeen: latest?.checkedAt ?? null,
      movement: {
        d1: movementFor(history, latest?.observedRank ?? null, nowMs, 1),
        d7: movementFor(history, latest?.observedRank ?? null, nowMs, 7),
        d28: movementFor(history, latest?.observedRank ?? null, nowMs, 28),
      },
      gscAveragePosition: gscPositions.get(gscKey) ?? null,
    };
  });
}
