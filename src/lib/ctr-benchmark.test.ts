import { describe, expect, it } from "vitest";
import { computeObservedCtrCurve, expectedCtrFor } from "@/lib/ctr-benchmark";
import { expectedCtrForPosition } from "@/lib/opportunity-score";
import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";

function row(
  currentPosition: number | null,
  impressions: number,
  clicks: number,
): KeywordOpportunityRow {
  return {
    query: "q",
    rankingUrl: null,
    previousRankingUrl: null,
    competingUrls: [],
    clicks,
    clicksPrev: 0,
    clicksChangePct: null,
    impressions,
    impressionsPrev: 0,
    impressionsChangePct: null,
    ctr: impressions > 0 ? clicks / impressions : null,
    currentPosition,
    previousPosition: null,
    positionChange: null,
    positionStability: null,
    firstSeen: "2026-01-01",
    lastSeen: "2026-01-01",
    trend: "stable",
    branded: false,
    bingImpressions: 0,
    categories: [],
    score: { score: 0, factors: [] },
    recommendedAction: "",
  };
}

describe("expectedCtrFor", () => {
  it("falls back to the heuristic curve when there isn't enough first-party volume at a position", () => {
    const curve = computeObservedCtrCurve([row(5, 50, 2)]); // far below the 500-impression/5-query bar
    const result = expectedCtrFor(5, curve);
    expect(result.source).toBe("heuristic");
    expect(result.value).toBeCloseTo(expectedCtrForPosition(5), 5);
    expect(result.sampleImpressions).toBeNull();
  });

  it("uses this site's own observed CTR once a position bucket has enough real volume", () => {
    // 10 queries at position 5, 100 impressions each (1000 total, >=500),
    // 30 total clicks -> observed CTR 3%, clearly different from the
    // heuristic curve's ~6% at position 5.
    const rows = Array.from({ length: 10 }, () => row(5, 100, 3));
    const curve = computeObservedCtrCurve(rows);
    const result = expectedCtrFor(5, curve);
    expect(result.source).toBe("observed");
    expect(result.value).toBeCloseTo(0.03, 5);
    expect(result.sampleImpressions).toBe(1000);
    expect(result.sampleQueries).toBe(10);
    expect(result.value).not.toBeCloseTo(expectedCtrForPosition(5), 2);
  });

  it("never invents a value - rows with no position or zero impressions are excluded from the observed curve", () => {
    const curve = computeObservedCtrCurve([row(null, 1000, 500), row(5, 0, 0)]);
    expect(curve.buckets.size).toBe(0);
    const result = expectedCtrFor(5, curve);
    expect(result.source).toBe("heuristic");
  });

  it("buckets nearby positions together (rounds to nearest integer within 1-20)", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row(4.6, 100, 5)),
      ...Array.from({ length: 5 }, () => row(5.4, 100, 5)),
    ];
    const curve = computeObservedCtrCurve(rows);
    // Both 4.6 and 5.4 round to bucket 5.
    const result = expectedCtrFor(5, curve);
    expect(result.source).toBe("observed");
    expect(result.sampleQueries).toBe(10);
  });
});
