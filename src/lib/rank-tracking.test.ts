import { describe, expect, it } from "vitest";
import {
  computeEngineAveragePositions,
  computeTrackedKeywordInsights,
  type RankSnapshotRow,
  type TrackedRankKeywordRow,
} from "@/lib/rank-tracking";

const SITE = "site-1";

function kw(
  overrides: Partial<TrackedRankKeywordRow> = {},
): TrackedRankKeywordRow {
  return {
    id: "kw-1",
    siteId: SITE,
    query: "blue widgets",
    engine: "google",
    device: "desktop",
    country: null,
    location: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function snap(overrides: Partial<RankSnapshotRow> = {}): RankSnapshotRow {
  return {
    id: "snap",
    siteId: SITE,
    query: "blue widgets",
    engine: "google",
    device: "desktop",
    country: null,
    location: null,
    rankingUrl: "https://example.com/blue-widgets",
    observedRank: 8,
    source: "manual",
    checkedAt: "2026-01-15T00:00:00Z",
    ...overrides,
  };
}

describe("computeTrackedKeywordInsights", () => {
  it("returns nulls for a keyword with no observations yet", () => {
    const [row] = computeTrackedKeywordInsights([kw()], [], new Map());
    expect(row.currentRank).toBeNull();
    expect(row.bestRank).toBeNull();
    expect(row.firstSeen).toBeNull();
    expect(row.movement).toEqual({ d1: null, d7: null, d28: null });
  });

  it("picks the most recent snapshot as current, and tracks best/worst", () => {
    const snapshots = [
      snap({ id: "a", checkedAt: "2026-01-01T00:00:00Z", observedRank: 12 }),
      snap({ id: "b", checkedAt: "2026-01-10T00:00:00Z", observedRank: 6 }),
      snap({ id: "c", checkedAt: "2026-01-20T00:00:00Z", observedRank: 9 }),
    ];
    const [row] = computeTrackedKeywordInsights(
      [kw()],
      snapshots,
      new Map(),
      new Date("2026-01-20T12:00:00Z"),
    );
    expect(row.currentRank).toBe(9);
    expect(row.bestRank).toBe(6);
    expect(row.worstRank).toBe(12);
    expect(row.firstSeen).toBe("2026-01-01T00:00:00Z");
    expect(row.lastSeen).toBe("2026-01-20T00:00:00Z");
  });

  it("computes 7d movement as the reference rank minus the current rank", () => {
    const snapshots = [
      snap({ id: "a", checkedAt: "2026-01-01T00:00:00Z", observedRank: 15 }),
      snap({ id: "b", checkedAt: "2026-01-20T00:00:00Z", observedRank: 9 }),
    ];
    const [row] = computeTrackedKeywordInsights(
      [kw()],
      snapshots,
      new Map(),
      new Date("2026-01-20T12:00:00Z"),
    );
    // Reference for 7d is the snapshot at/before Jan 13 -> "a" (Jan 1, rank 15).
    // Improvement = 15 - 9 = 6 (positive = better).
    expect(row.movement.d7).toBe(6);
  });

  it("never mixes snapshots across a different device/engine/country", () => {
    const snapshots = [
      snap({ id: "mobile", device: "mobile", observedRank: 2 }),
      snap({ id: "bing", engine: "bing", observedRank: 3 }),
      snap({ id: "desktop-google", observedRank: 8 }),
    ];
    const [row] = computeTrackedKeywordInsights([kw()], snapshots, new Map());
    expect(row.currentRank).toBe(8);
    expect(row.history).toHaveLength(1);
  });

  it("keeps gscAveragePosition separate from the observed rank", () => {
    const gscPositions = new Map([["google\u0000blue widgets", 5.4]]);
    const snapshots = [snap({ observedRank: 11 })];
    const [row] = computeTrackedKeywordInsights(
      [kw()],
      snapshots,
      gscPositions,
    );
    expect(row.currentRank).toBe(11);
    expect(row.gscAveragePosition).toBe(5.4);
  });
});

describe("computeEngineAveragePositions", () => {
  it("weights the average position by impressions", () => {
    const map = computeEngineAveragePositions([
      {
        engine: "google",
        query: "blue widgets",
        impressions: 100,
        averagePosition: 10,
      },
      {
        engine: "google",
        query: "blue widgets",
        impressions: 300,
        averagePosition: 2,
      },
    ]);
    // (10*100 + 2*300) / 400 = 4
    expect(map.get("google\u0000blue widgets")).toBeCloseTo(4);
  });

  it("keeps google and bing positions for the same query separate", () => {
    const map = computeEngineAveragePositions([
      {
        engine: "google",
        query: "blue widgets",
        impressions: 100,
        averagePosition: 5,
      },
      {
        engine: "bing",
        query: "blue widgets",
        impressions: 100,
        averagePosition: 20,
      },
    ]);
    expect(map.get("google\u0000blue widgets")).toBe(5);
    expect(map.get("bing\u0000blue widgets")).toBe(20);
  });

  it("is case-insensitive on the query", () => {
    const map = computeEngineAveragePositions([
      {
        engine: "google",
        query: "Blue Widgets",
        impressions: 50,
        averagePosition: 7,
      },
    ]);
    expect(map.get("google\u0000blue widgets")).toBe(7);
  });
});
