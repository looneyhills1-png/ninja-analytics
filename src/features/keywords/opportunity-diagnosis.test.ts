import { describe, expect, it } from "vitest";
import {
  computeKeywordOpportunities,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";
import { diagnoseOpportunity } from "@/features/keywords/opportunity-diagnosis";

const SITE = { domain: "ninjatickets.com", name: "NinjaTickets" };

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

describe("diagnoseOpportunity", () => {
  it("flags CTR as the first priority for a good position with high impressions and poor CTR", () => {
    // Position ~5, 150 impressions, 2 clicks - well ranked, badly clicked.
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("west end tickets", "2026-01-10", 2, 150, 5)],
      bingQueryRows: [],
      queryPageRows: [
        qp("west end tickets", "/event/example/", "2026-01-10", 2, 150),
      ],
      days: 7,
    });
    expect(row.categories).toContain("high-impression-low-ctr");

    const diagnosis = diagnoseOpportunity(row);

    expect(diagnosis.ctrFirst).toBe(true);
    expect(diagnosis.priorityAction).toContain("CTR is the first priority");
    expect(diagnosis.priorityAction).toContain(
      "the ranking itself already proves relevance",
    );
  });

  it("flags relevance/content/internal-link strength as the priority for a page-2 opportunity", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("wine tasting birmingham", "2026-01-10", 3, 50, 15)],
      bingQueryRows: [],
      queryPageRows: [
        qp(
          "wine tasting birmingham",
          "/event/wine-tasting-birmingham/",
          "2026-01-10",
          3,
          50,
        ),
      ],
      days: 7,
    });
    expect(row.categories).toContain("page-2");

    const diagnosis = diagnoseOpportunity(row);

    expect(diagnosis.ctrFirst).toBe(false);
    expect(diagnosis.priorityAction).toContain(
      "Relevance, content depth, and internal-link strength",
    );
    expect(diagnosis.seoWeakness).toContain("On page 2");
  });

  it("tells you to inspect competing URLs before recommending new content for cannibalisation", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("wine tasting birmingham", "2026-01-10", 3, 50, 25)],
      bingQueryRows: [],
      queryPageRows: [
        qp(
          "wine tasting birmingham",
          "/event/wine-tasting-birmingham/",
          "2026-01-10",
          3,
          40,
        ),
        qp(
          "wine tasting birmingham",
          "/things-to-do-in-birmingham/",
          "2026-01-10",
          1,
          10,
        ),
      ],
      days: 7,
    });
    expect(row.categories).toContain("cannibalisation");

    const diagnosis = diagnoseOpportunity(row);

    expect(diagnosis.priorityAction).toContain(
      "Inspect every competing URL below before recommending new content",
    );
    expect(diagnosis.seoWeakness).toContain("2 internal pages are competing");
  });

  it("tells you to identify what changed before rewriting for content decay", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      // Position 35 keeps this out of the strike-now (4-10) and page-2
      // (11-20) ranges, so content-decay is the only category and its
      // priority action isn't shadowed by a higher-priority category.
      queryRows: [
        q("panto tickets", "2026-01-08", 2, 40, 35),
        q("panto tickets", "2026-01-01", 30, 40, 35),
      ],
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).toContain("content-decay");

    const diagnosis = diagnoseOpportunity(row);

    expect(diagnosis.priorityAction).toContain("Identify what changed");
    expect(diagnosis.priorityAction).toContain(
      "don't assume the content is simply stale",
    );
  });

  it("preserves existing visibility as something to keep, not rewrite", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });

    const diagnosis = diagnoseOpportunity(row);

    expect(diagnosis.preserve).toContain("Already ranks at position");
    expect(diagnosis.preserve).toContain(
      "preserve it, don't rewrite the page from scratch",
    );
  });

  it("never gives a generic 'improve content' action for any category", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [
        q("event tickets", "2026-01-10", 5, 50, 7),
        q("wine tasting birmingham", "2026-01-10", 3, 50, 15),
      ],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
        qp(
          "wine tasting birmingham",
          "/event/wine-tasting-birmingham/",
          "2026-01-10",
          3,
          50,
        ),
      ],
      days: 7,
    });

    for (const row of rows) {
      const diagnosis = diagnoseOpportunity(row);
      expect(diagnosis.priorityAction.toLowerCase()).not.toBe(
        "improve content",
      );
      expect(diagnosis.priorityAction.toLowerCase()).not.toContain(
        "simply improve content",
      );
    }
  });
});
