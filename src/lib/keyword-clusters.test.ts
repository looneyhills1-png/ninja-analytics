import { describe, expect, it } from "vitest";
import { computeKeywordClusters } from "@/lib/keyword-clusters";
import { computeKeywordOpportunities } from "@/lib/keyword-opportunities";
import type {
  QueryDailyRow,
  QueryPageDailyRow,
} from "@/lib/keyword-opportunities";

const SITE = { domain: "acme.com", name: "Acme" };

function q(
  query: string,
  clicks: number,
  impressions: number,
  position: number,
): QueryDailyRow {
  return {
    query,
    metric_date: "2026-01-10",
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    average_position: position,
  };
}

function buildRows(queries: [string, number, number, number][]) {
  const queryRows = queries.map(([query, clicks, impressions, position]) =>
    q(query, clicks, impressions, position),
  );
  return computeKeywordOpportunities({
    site: SITE,
    queryRows,
    bingQueryRows: [],
    queryPageRows: [],
    days: 7,
  });
}

describe("computeKeywordClusters", () => {
  it("groups lexically similar queries into one cluster", () => {
    const rows = buildRows([
      ["blue widget for sale", 5, 50, 8],
      ["blue widget price", 4, 40, 9],
      ["red gadget review", 2, 20, 15],
    ]);
    const clusters = computeKeywordClusters(rows);
    const blueCluster = clusters.find((c) =>
      c.queries.some((r) => r.query === "blue widget for sale"),
    )!;
    expect(blueCluster.queries.map((r) => r.query)).toContain(
      "blue widget price",
    );
    expect(blueCluster.queries.map((r) => r.query)).not.toContain(
      "red gadget review",
    );
  });

  it("returns an empty array for no rows", () => {
    expect(computeKeywordClusters([])).toEqual([]);
  });

  it("maps a single-URL cluster with a strong position to existing-best-url", () => {
    const rows = buildRows([["only query here", 20, 200, 3]]);
    // No page rows were provided, so rankingUrl is null - mapping should
    // fall back to potential-new-page (no real URL to point to), not
    // existing-best-url. This documents that behaviour explicitly.
    const clusters = computeKeywordClusters(rows);
    expect(clusters[0].mapping).toBe("potential-new-page");
  });

  it("maps a cluster with a single, well-ranked page to existing-best-url", () => {
    const queryRows: QueryDailyRow[] = [q("evergreen topic guide", 30, 300, 4)];
    const pageRows: QueryPageDailyRow[] = [
      {
        query: "evergreen topic guide",
        page: "/guide",
        metric_date: "2026-01-10",
        clicks: 30,
        impressions: 300,
      },
    ];
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows,
      bingQueryRows: [],
      queryPageRows: pageRows,
      days: 7,
    });
    const clusters = computeKeywordClusters(rows);
    expect(clusters[0].mapping).toBe("existing-best-url");
    expect(clusters[0].cannibalisation).toBe(false);
  });

  it("flags cluster-level cannibalisation when queries in the cluster resolve to different URLs", () => {
    const queryRows: QueryDailyRow[] = [
      q("shared topic one", 10, 100, 8),
      q("shared topic two", 8, 80, 9),
    ];
    const pageRows: QueryPageDailyRow[] = [
      {
        query: "shared topic one",
        page: "/page-a",
        metric_date: "2026-01-10",
        clicks: 10,
        impressions: 100,
      },
      {
        query: "shared topic two",
        page: "/page-b",
        metric_date: "2026-01-10",
        clicks: 8,
        impressions: 80,
      },
    ];
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows,
      bingQueryRows: [],
      queryPageRows: pageRows,
      days: 7,
    });
    const clusters = computeKeywordClusters(rows);
    const cluster = clusters.find((c) => c.queries.length === 2);
    expect(cluster?.cannibalisation).toBe(true);
    expect(cluster?.mapping).toBe("improve-existing");
  });

  it("caps clustering at the top-impression queries", () => {
    const many: [string, number, number, number][] = Array.from(
      { length: 350 },
      (_, i) => [`unique query number ${i}`, 1, 350 - i, 20],
    );
    const rows = buildRows(many);
    const clusters = computeKeywordClusters(rows);
    const totalClustered = clusters.reduce((s, c) => s + c.queries.length, 0);
    expect(totalClustered).toBeLessThanOrEqual(300);
  });
});
