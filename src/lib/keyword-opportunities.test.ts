import { describe, expect, it } from "vitest";
import {
  computeKeywordOpportunities,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";

const SITE = { domain: "acme.com", name: "Acme Widgets" };

// Window: days=7. latest=2026-01-14 -> current 2026-01-08..14, previous
// 2026-01-01..07.
function q(
  query: string,
  metric_date: string,
  clicks: number,
  impressions: number,
  average_position: number | null,
): QueryDailyRow {
  return {
    query,
    metric_date,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    average_position,
  };
}

function qp(
  query: string,
  page: string,
  metric_date: string,
  clicks: number,
  impressions: number,
): QueryPageDailyRow {
  return { query, page, metric_date, clicks, impressions };
}

describe("computeKeywordOpportunities", () => {
  it("aggregates current/previous clicks, impressions and weighted position", () => {
    const rows: QueryDailyRow[] = [
      q("blue widgets", "2026-01-08", 10, 100, 6),
      q("blue widgets", "2026-01-09", 10, 100, 6),
      q("blue widgets", "2026-01-02", 5, 100, 8),
    ];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.clicks).toBe(20);
    expect(row.impressions).toBe(200);
    expect(row.clicksPrev).toBe(5);
    expect(row.currentPosition).toBeCloseTo(6);
    expect(row.previousPosition).toBeCloseTo(8);
    // Position improved (8 -> 6), so positionChange is positive.
    expect(row.positionChange).toBeCloseTo(2);
  });

  it("flags strike-now for positions 4-10 with meaningful impressions", () => {
    const rows = [q("mid rank query", "2026-01-10", 5, 50, 7)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).toContain("strike-now");
    expect(row.categories).not.toContain("page-2");
  });

  it("flags page-2 for positions 11-20", () => {
    const rows = [q("page two query", "2026-01-10", 2, 50, 14)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).toContain("page-2");
  });

  it("does not flag strike-now/page-2 below the impression floor", () => {
    const rows = [q("tiny query", "2026-01-10", 0, 3, 7)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).not.toContain("strike-now");
  });

  it("flags high-impression-low-ctr when CTR is well below the position benchmark", () => {
    const rows = [q("popular query", "2026-01-10", 1, 500, 3)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).toContain("high-impression-low-ctr");
  });

  it("detects a new query (only current-window data, first seen in window)", () => {
    const rows = [q("brand new query", "2026-01-10", 3, 30, 12)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.trend).toBe("new");
    expect(row.categories).toContain("new");
  });

  it("detects a lost query (only previous-window data)", () => {
    // "latest" is anchored to the max date across ALL rows, so a second,
    // unrelated query with a current-window date is needed here to establish
    // that anchor - otherwise "vanished query"'s own (only) date would itself
    // become "latest" and trivially count as current-window.
    const rows = [
      q("vanished query", "2026-01-03", 20, 200, 5),
      q("anchor query", "2026-01-10", 1, 10, 3),
    ];
    const rowsByQuery = new Map(
      computeKeywordOpportunities({
        site: SITE,
        queryRows: rows,
        bingQueryRows: [],
        queryPageRows: [],
        days: 7,
      }).map((r) => [r.query, r]),
    );
    const row = rowsByQuery.get("vanished query")!;
    expect(row.trend).toBe("lost");
    expect(row.categories).toContain("lost");
    expect(row.clicks).toBe(0);
  });

  it("classifies rising and falling by click change", () => {
    const rising = q("rising query", "2026-01-10", 100, 500, 5);
    const risingPrev = q("rising query", "2026-01-03", 20, 500, 5);
    const falling = q("falling query", "2026-01-10", 5, 500, 5);
    const fallingPrev = q("falling query", "2026-01-03", 100, 500, 5);
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [rising, risingPrev, falling, fallingPrev],
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    const risingRow = rows.find((r) => r.query === "rising query")!;
    const fallingRow = rows.find((r) => r.query === "falling query")!;
    expect(risingRow.trend).toBe("rising");
    expect(fallingRow.trend).toBe("falling");
    expect(fallingRow.categories).toContain("content-decay");
  });

  it("detects cannibalisation when 2+ pages get impressions for the same query", () => {
    const rows = [q("shared query", "2026-01-10", 10, 200, 8)];
    const pageRows: QueryPageDailyRow[] = [
      qp("shared query", "/page-a", "2026-01-10", 8, 150),
      qp("shared query", "/page-b", "2026-01-10", 2, 50),
    ];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: pageRows,
      days: 7,
    });
    expect(row.categories).toContain("cannibalisation");
    expect(row.rankingUrl).toBe("/page-a"); // more clicks
    expect(row.competingUrls).toEqual(
      expect.arrayContaining(["/page-a", "/page-b"]),
    );
  });

  it("detects a ranking URL change between previous and current windows", () => {
    const rows = [
      q("moved query", "2026-01-10", 10, 100, 6),
      q("moved query", "2026-01-03", 10, 100, 6),
    ];
    const pageRows: QueryPageDailyRow[] = [
      qp("moved query", "/new-page", "2026-01-10", 10, 100),
      qp("moved query", "/old-page", "2026-01-03", 10, 100),
    ];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: pageRows,
      days: 7,
    });
    expect(row.categories).toContain("ranking-url-changed");
    expect(row.rankingUrl).toBe("/new-page");
    expect(row.previousRankingUrl).toBe("/old-page");
  });

  it("classifies branded vs non-branded queries using the site's own name/domain", () => {
    // SITE's own tokens are "acme" and "widgets" (from "Acme Widgets") - the
    // non-branded fixture deliberately avoids both so it's a clean negative.
    const rows = [
      q("acme discount code", "2026-01-10", 5, 50, 3),
      q("best gadgets 2026", "2026-01-10", 5, 50, 8),
    ];
    const out = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    const branded = out.find((r) => r.query === "acme discount code")!;
    const nonBranded = out.find((r) => r.query === "best gadgets 2026")!;
    expect(branded.branded).toBe(true);
    expect(nonBranded.branded).toBe(false);
  });

  it("marks Bing corroboration when the query also has meaningful Bing impressions", () => {
    const rows = [q("cross engine query", "2026-01-10", 5, 50, 6)];
    const bingRows = [{ ...q("cross engine query", "2026-01-10", 2, 20, 6) }];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: bingRows,
      queryPageRows: [],
      days: 7,
    });
    expect(row.bingImpressions).toBe(20);
  });

  it("returns an empty array for no data", () => {
    expect(
      computeKeywordOpportunities({
        site: SITE,
        queryRows: [],
        bingQueryRows: [],
        queryPageRows: [],
        days: 7,
      }),
    ).toEqual([]);
  });

  it("sorts rows by opportunity score, highest first", () => {
    const rows = [
      q("strong opportunity", "2026-01-10", 5, 500, 6),
      q("weak opportunity", "2026-01-10", 0, 5, 45),
    ];
    const out = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(out[0].score.score).toBeGreaterThanOrEqual(out[1].score.score);
  });

  it("every row carries a non-empty recommended action", () => {
    const rows = [q("any query", "2026-01-10", 5, 50, 6)];
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: rows,
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.recommendedAction.length).toBeGreaterThan(0);
  });
});
