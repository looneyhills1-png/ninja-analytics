import { describe, expect, it } from "vitest";
import {
  computeKeywordOpportunities,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";
import { buildFixPrompt } from "@/features/keywords/generateFixPrompt";

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

describe("buildFixPrompt", () => {
  it("includes every required field for a strike-now opportunity with a ranking URL", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    expect(row.categories).toContain("strike-now");

    const prompt = buildFixPrompt(SITE, row);

    // Site/domain, query, ranking URL.
    expect(prompt).toContain("ninjatickets.com");
    expect(prompt).toContain("NinjaTickets");
    expect(prompt).toContain('"event tickets"');
    expect(prompt).toContain("/event/example/");
    // Position, clicks, impressions, CTR.
    expect(prompt).toContain(row.currentPosition!.toFixed(1));
    expect(prompt).toContain("50");
    expect(prompt).toContain("10.00%"); // 5/50
    // Category, score, recommended action.
    expect(prompt).toContain("Strike now");
    expect(prompt).toContain(`${row.score.score}/100`);
    expect(prompt).toContain(row.recommendedAction);
    // Why-the-score section names at least one real factor.
    expect(prompt).toContain("Position proximity");
    // Strike-now implementation checklist, verbatim per the brief.
    expect(prompt).toContain("Inspect the existing ranking page first.");
    expect(prompt).toContain(
      "Do not create a competing URL unless clearly necessary.",
    );
    expect(prompt).toContain("Preserve existing affiliate/event functionality");
    // Trailing rules, verbatim per the brief.
    expect(prompt).toContain("Inspect before editing.");
    expect(prompt).toContain("Make only evidence-based changes.");
    expect(prompt).toContain(
      "Run all relevant NinjaTickets quality/SEO gates.",
    );
    expect(prompt).toContain("Make one coherent commit.");
    expect(prompt).toContain("Deploy once.");
    expect(prompt).toContain("Do not repeatedly poll deploy status.");
    expect(prompt).toContain(
      "Report: files changed, commit hash, test/build result, deploy result.",
    );
  });

  it("lists competing URLs and the cannibalisation checklist when cannibalisation is detected", () => {
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
    expect(row.competingUrls.length).toBeGreaterThanOrEqual(2);

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain("Cannibalisation");
    for (const url of row.competingUrls) {
      expect(prompt).toContain(url);
    }
    expect(prompt).toContain("Inspect every competing URL listed below.");
    expect(prompt).toContain(
      "Choose the single strongest, most intended page as canonical for this query.",
    );
  });

  it("shows 'none on record' and 'no competing URLs' when there is no ranking-URL data", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("brand new query", "2026-01-10", 20, 60, 2)],
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.rankingUrl).toBeNull();
    expect(row.competingUrls).toHaveLength(0);

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain("none on record for this query");
    expect(prompt).toContain(
      "No competing internal URLs detected for this query in the current window.",
    );
  });

  it("falls back to the general rules when no category has a dedicated checklist", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [
        q("steady riser", "2026-01-08", 30, 60, 2),
        q("steady riser", "2026-01-01", 10, 60, 2),
      ],
      bingQueryRows: [],
      queryPageRows: [],
      days: 7,
    });
    expect(row.categories).toEqual(["rising"]);

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain(
      "No category-specific checklist applies here beyond the recommended action above",
    );
  });
});
