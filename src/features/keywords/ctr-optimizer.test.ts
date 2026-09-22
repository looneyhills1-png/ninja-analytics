import { describe, expect, it } from "vitest";
import {
  computeKeywordOpportunities,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";
import {
  diagnoseCtrWeakness,
  findCtrOpportunities,
  type SiteAuditPageEvidence,
} from "@/features/keywords/ctr-optimizer";

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

describe("findCtrOpportunities", () => {
  it("identifies the brief's exact example (position ~5, 30+ impressions, 0 clicks) as a CTR opportunity, not a rewrite candidate", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [
        q("llandudno chocolate experience tickets", "2026-01-10", 0, 35, 5),
      ],
      bingQueryRows: [],
      queryPageRows: [
        qp(
          "llandudno chocolate experience tickets",
          "/event/llandudno-chocolate-experience-llandudno/",
          "2026-01-10",
          0,
          35,
        ),
      ],
      days: 7,
    });

    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });

    expect(opportunities).toHaveLength(1);
    const opp = opportunities[0];
    expect(opp.query).toBe("llandudno chocolate experience tickets");
    expect(opp.currentPosition).toBeCloseTo(5, 1);
    expect(opp.impressions).toBe(35);
    expect(opp.clicks).toBe(0);
    expect(opp.actualCtr).toBe(0);
    expect(opp.expectedCtr).toBeGreaterThan(0);
    expect(opp.ctrGapAbsolute).toBeGreaterThan(0);
    expect(opp.estimatedMissedClicks).toBeGreaterThan(0);
    // No site-audit evidence supplied - honestly marked, not guessed.
    expect(opp.pageEvidence.source).toBe("not-inspected");
    expect(opp.recommendedChange).toContain(
      "Do not assume a rewrite is needed",
    );
  });

  it("does not flag a page ranking well with CTR already at or above benchmark", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 30, 100, 3)], // 30% CTR at position 3, well above typical
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 30, 100),
      ],
      days: 7,
    });

    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });
    expect(opportunities).toHaveLength(0);
  });

  it("excludes pages ranking outside position 1-10 even with a large CTR gap", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("far back query", "2026-01-10", 0, 100, 25)],
      bingQueryRows: [],
      queryPageRows: [
        qp("far back query", "/event/far-back/", "2026-01-10", 0, 100),
      ],
      days: 7,
    });

    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });
    expect(opportunities).toHaveLength(0);
  });

  it("excludes rows below the meaningful-impressions floor", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("tiny query", "2026-01-10", 0, 3, 5)],
      bingQueryRows: [],
      queryPageRows: [qp("tiny query", "/event/tiny/", "2026-01-10", 0, 3)],
      days: 7,
    });

    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });
    expect(opportunities).toHaveLength(0);
  });

  it("sorts by biggest CTR gap first", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [
        q("small gap query", "2026-01-10", 1, 40, 6), // some clicks, smaller gap
        q("big gap query", "2026-01-10", 0, 40, 6), // zero clicks, bigger gap
      ],
      bingQueryRows: [],
      queryPageRows: [
        qp("small gap query", "/event/small-gap/", "2026-01-10", 1, 40),
        qp("big gap query", "/event/big-gap/", "2026-01-10", 0, 40),
      ],
      days: 7,
    });

    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });
    expect(opportunities.length).toBeGreaterThanOrEqual(2);
    expect(opportunities[0].query).toBe("big gap query");
  });

  it("uses real site-audit page evidence when available and never invents H1 text", () => {
    const rows = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("west end show tickets", "2026-01-10", 0, 40, 4)],
      bingQueryRows: [],
      queryPageRows: [
        qp(
          "west end show tickets",
          "/event/west-end-show/",
          "2026-01-10",
          0,
          40,
        ),
      ],
      days: 7,
    });

    const evidence: SiteAuditPageEvidence = {
      title: "Home | NinjaTickets",
      titleLength: 19,
      metaDescription: null,
      metaDescriptionLength: null,
      h1Count: 1,
    };
    const opportunities = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map([["/event/west-end-show/", evidence]]),
    });

    expect(opportunities).toHaveLength(1);
    const opp = opportunities[0];
    expect(opp.pageEvidence.source).toBe("site-audit");
    expect(opp.pageEvidence.title).toBe("Home | NinjaTickets");
    // h1Count is a real captured field, but the actual H1 text is never
    // fabricated - the type simply has no h1Text field at all.
    expect(opp.pageEvidence.h1Count).toBe(1);
    expect(
      opp.diagnosisFlags.find((f) => f.weakness === "title-intent-mismatch")
        ?.confidence,
    ).toBe("evidence-based");
  });
});

describe("diagnoseCtrWeakness", () => {
  it("returns exactly the seven weakness categories from the brief, every time", () => {
    const flags = diagnoseCtrWeakness({
      query: "llandudno chocolate experience",
      title: null,
      titleLength: null,
      metaDescription: null,
      metaDescriptionLength: null,
    });
    expect(flags.map((f) => f.weakness).sort()).toEqual(
      [
        "missing-ticket-context",
        "poor-differentiation",
        "snippet-rewrite-likely",
        "title-clarity",
        "title-intent-mismatch",
        "vague-meta-description",
        "weak-value-proposition",
      ].sort(),
    );
  });

  it("never assumes a rewrite is needed when no page evidence exists - everything is not-assessable", () => {
    const flags = diagnoseCtrWeakness({
      query: "llandudno chocolate experience",
      title: null,
      titleLength: null,
      metaDescription: null,
      metaDescriptionLength: null,
    });
    for (const f of flags) {
      expect(f.confidence).not.toBe("evidence-based");
    }
  });

  it("flags title-intent-mismatch with evidence-based confidence only when a real title is known and shares no query terms", () => {
    const flags = diagnoseCtrWeakness({
      query: "llandudno chocolate experience tickets",
      title: "Home | NinjaTickets",
      titleLength: 19,
      metaDescription: null,
      metaDescriptionLength: null,
    });
    const mismatch = flags.find((f) => f.weakness === "title-intent-mismatch")!;
    expect(mismatch.confidence).toBe("evidence-based");
    expect(mismatch.explanation).toContain("shares no words");
  });

  it("does not flag title-intent-mismatch when the title genuinely contains query terms", () => {
    const flags = diagnoseCtrWeakness({
      query: "llandudno chocolate experience tickets",
      title: "Llandudno Chocolate Experience Tickets | NinjaTickets",
      titleLength: 54,
      metaDescription:
        "Book tickets for the Llandudno Chocolate Experience - see prices, dates and availability.",
      metaDescriptionLength: 91,
    });
    const mismatch = flags.find((f) => f.weakness === "title-intent-mismatch")!;
    expect(mismatch.explanation).toContain("looks fine");
    const meta = flags.find((f) => f.weakness === "vague-meta-description")!;
    expect(meta.explanation).toContain("looks fine");
  });

  it("flags snippet-rewrite-likely with evidence-based confidence for an over-length title", () => {
    const flags = diagnoseCtrWeakness({
      query: "west end show tickets",
      title:
        "West End Show Tickets - Book Now for the Best Prices and Availability on All Performances",
      titleLength: 90,
      metaDescription: null,
      metaDescriptionLength: null,
    });
    const rewrite = flags.find((f) => f.weakness === "snippet-rewrite-likely")!;
    expect(rewrite.confidence).toBe("evidence-based");
    expect(rewrite.explanation).toContain("90 characters");
  });

  it("flags vague-meta-description with evidence-based confidence for a missing meta", () => {
    const flags = diagnoseCtrWeakness({
      query: "west end show tickets",
      title: "West End Show Tickets | NinjaTickets",
      titleLength: 37,
      metaDescription: null,
      metaDescriptionLength: null,
    });
    const meta = flags.find((f) => f.weakness === "vague-meta-description")!;
    expect(meta.confidence).toBe("evidence-based");
    expect(meta.explanation).toContain("No meta description captured");
  });
});
