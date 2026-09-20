import { describe, expect, it } from "vitest";
import {
  computeOpportunityScore,
  expectedCtrForPosition,
} from "@/lib/opportunity-score";

describe("expectedCtrForPosition", () => {
  it("is monotonically decreasing", () => {
    const positions = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50];
    for (let i = 1; i < positions.length; i += 1) {
      expect(expectedCtrForPosition(positions[i])).toBeLessThanOrEqual(
        expectedCtrForPosition(positions[i - 1]),
      );
    }
  });

  it("clamps below position 1", () => {
    expect(expectedCtrForPosition(0)).toBe(expectedCtrForPosition(1));
  });

  it("returns the last benchmark for very low positions", () => {
    expect(expectedCtrForPosition(200)).toBeCloseTo(0.0015);
  });
});

describe("computeOpportunityScore", () => {
  it("scores 0-100 and returns factors that sum to the score", () => {
    const result = computeOpportunityScore({
      currentPosition: 7,
      previousPosition: 9,
      impressions: 500,
      ctr: 0.01,
      clicksChangePct: 20,
      positionStability: 2,
      competingUrlCount: 1,
      bingCorroboration: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    const summed = result.factors.reduce((s, f) => s + f.points, 0);
    expect(result.score).toBe(Math.max(0, Math.min(100, summed)));
    expect(result.factors).toHaveLength(7);
    for (const f of result.factors) {
      expect(f.explanation.length).toBeGreaterThan(0);
    }
  });

  it("gives a strike-now position (rank 6) a higher position-proximity factor than rank 1", () => {
    const near = computeOpportunityScore({
      currentPosition: 6,
      previousPosition: null,
      impressions: 100,
      ctr: 0.03,
      clicksChangePct: null,
      positionStability: null,
      competingUrlCount: 1,
      bingCorroboration: false,
    });
    const top = computeOpportunityScore({
      currentPosition: 1,
      previousPosition: null,
      impressions: 100,
      ctr: 0.03,
      clicksChangePct: null,
      positionStability: null,
      competingUrlCount: 1,
      bingCorroboration: false,
    });
    const nearPos = near.factors.find((f) => f.key === "position")!;
    const topPos = top.factors.find((f) => f.key === "position")!;
    expect(nearPos.value).toBeGreaterThan(topPos.value);
  });

  it("returns 0 for a query with no data at all", () => {
    const result = computeOpportunityScore({
      currentPosition: null,
      previousPosition: null,
      impressions: 0,
      ctr: null,
      clicksChangePct: null,
      positionStability: null,
      competingUrlCount: 0,
      bingCorroboration: false,
    });
    expect(result.score).toBe(0);
  });

  it("rewards cannibalisation risk as a distinct factor", () => {
    const result = computeOpportunityScore({
      currentPosition: 15,
      previousPosition: 15,
      impressions: 200,
      ctr: 0.02,
      clicksChangePct: 0,
      positionStability: 5,
      competingUrlCount: 3,
      bingCorroboration: false,
    });
    const factor = result.factors.find((f) => f.key === "cannibalisation")!;
    expect(factor.value).toBeGreaterThan(0);
  });
});
