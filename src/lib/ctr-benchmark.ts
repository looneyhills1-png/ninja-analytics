// The Ninja CTR benchmark curve for the CTR Optimizer (Phase 3): an
// expected-CTR-by-position estimate used only to compute a CTR gap and
// estimated missed clicks - never presented as a guarantee, never invented.
//
// Per position bucket, this prefers the SITE'S OWN OBSERVED CTR - computed
// from its own already-loaded Search Console data (no new fetch) - when
// there's enough first-party volume at that bucket to trust it, and falls
// back to opportunity-score.ts's documented generic industry-pattern
// heuristic curve otherwise. Every result says which source produced it, so
// nothing is ever silently presented as more authoritative than it is - see
// CtrBenchmarkResult.source.
import { expectedCtrForPosition as heuristicExpectedCtrForPosition } from "@/lib/opportunity-score";
import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";

export type CtrBenchmarkSource = "observed" | "heuristic";

export interface CtrBenchmarkResult {
  value: number;
  source: CtrBenchmarkSource;
  /** Only meaningful when source is "observed" - how much real first-party
   * data backs this value. */
  sampleImpressions: number | null;
  sampleQueries: number | null;
}

// A bucket needs at least this much real volume before its observed CTR is
// trusted over the generic heuristic - otherwise a handful of noisy queries
// could produce a wildly unreliable "expected" value. Deliberately
// conservative and named so it's easy to tune as real data volume grows.
const MIN_BUCKET_IMPRESSIONS = 500;
const MIN_BUCKET_QUERIES = 5;

/** Buckets a position to an integer 1-20 (where most opportunity-relevant
 * traffic sits and per-position volume is highest), or the nearest 10 above
 * that - loosely matching the heuristic curve's own breakpoints so the two
 * stay comparable position-for-position. */
function bucketKey(position: number): number {
  if (position <= 20) return Math.max(1, Math.round(position));
  return Math.round(position / 10) * 10;
}

interface BucketAggregate {
  impressions: number;
  clicks: number;
  queries: number;
}

export interface ObservedCtrCurve {
  buckets: ReadonlyMap<number, BucketAggregate>;
}

/**
 * Aggregates this site's own already-loaded opportunity rows into a
 * position-bucketed observed CTR curve. Compute once per site/date-window
 * and reuse for every opportunity - O(rows), no new fetch, no new GSC call.
 */
export function computeObservedCtrCurve(
  rows: readonly KeywordOpportunityRow[],
): ObservedCtrCurve {
  const buckets = new Map<number, BucketAggregate>();
  for (const row of rows) {
    if (row.currentPosition == null || row.impressions <= 0) continue;
    const key = bucketKey(row.currentPosition);
    const agg = buckets.get(key) ?? { impressions: 0, clicks: 0, queries: 0 };
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
    agg.queries += 1;
    buckets.set(key, agg);
  }
  return { buckets };
}

/**
 * The benchmark CTR for a position: this site's own observed rate when
 * there's enough first-party volume at that position's bucket, otherwise
 * the documented generic heuristic curve (opportunity-score.ts's
 * expectedCtrForPosition) - always labelled which one was used.
 */
export function expectedCtrFor(
  position: number,
  curve: ObservedCtrCurve,
): CtrBenchmarkResult {
  const bucket = curve.buckets.get(bucketKey(position));
  if (
    bucket &&
    bucket.impressions >= MIN_BUCKET_IMPRESSIONS &&
    bucket.queries >= MIN_BUCKET_QUERIES
  ) {
    return {
      value: bucket.clicks / bucket.impressions,
      source: "observed",
      sampleImpressions: bucket.impressions,
      sampleQueries: bucket.queries,
    };
  }
  return {
    value: heuristicExpectedCtrForPosition(position),
    source: "heuristic",
    sampleImpressions: null,
    sampleQueries: null,
  };
}
