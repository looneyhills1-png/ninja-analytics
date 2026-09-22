import { describe, expect, it } from "vitest";
import {
  computeKeywordOpportunities,
  type QueryDailyRow,
  type QueryPageDailyRow,
} from "@/lib/keyword-opportunities";
import { buildFixPrompt } from "@/features/keywords/generateFixPrompt";
import type { InternalLinkSuggestion } from "@/features/keywords/internal-link-engine";
import { findCtrOpportunities } from "@/features/keywords/ctr-optimizer";
import type { SiteAuditPageEvidence } from "@/features/keywords/ctr-optimizer";

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
    // No title/H1 rewrite instruction is injected for a row with no
    // relevant category - it's never an automatic, unconditional command.
    expect(prompt).not.toContain("Improve title/H1/meta");
    expect(prompt).not.toMatch(/Rewrite the (title|H1)\b/i);
  });

  it("gives CTR-first advice for a high-ranking, zero-click page", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("west end tickets", "2026-01-10", 0, 30, 5)],
      bingQueryRows: [],
      queryPageRows: [
        qp("west end tickets", "/event/example-2/", "2026-01-10", 0, 30),
      ],
      days: 7,
    });
    expect(row.currentPosition).toBeCloseTo(5, 1);
    expect(row.clicks).toBe(0);
    expect(row.impressions).toBe(30);

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain("CTR-first");
    expect(prompt).toContain(
      "the ranking itself is already strong enough that CTR is the primary measurable weakness",
    );
    expect(prompt).toContain(
      "Focus first on title tag, meta description, and on-page summary/snippet clarity",
    );
    expect(prompt).toContain(
      "Avoid a large content rewrite unless it's independently justified below.",
    );
    // The diagnosis section names the same CTR weakness explicitly.
    expect(prompt).toContain(
      "CTR is effectively zero on 30 impressions - this is the primary measurable weakness right now.",
    );
  });

  it("keeps the title/H1 rewrite instruction conditional, not automatic", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain(
      "Improve title/H1/meta only if genuinely justified by the above.",
    );
    expect(prompt).not.toMatch(/Rewrite the (title|H1)\b/i);
  });

  it("includes the user-value improvement rules and event-page checklist for every row", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    const prompt = buildFixPrompt(SITE, row);

    // The three-goal general checklist.
    expect(prompt).toContain("search intent match");
    expect(prompt).toContain("CTR/snippet appeal");
    expect(prompt).toContain("originality and usefulness");
    expect(prompt).toContain("affiliate-page value beyond just outbound links");
    expect(prompt).toContain("structured data");
    expect(prompt).toContain("trust/accuracy");
    // The event/ticket-page-specific checklist.
    expect(prompt).toContain("what the ticket includes");
    expect(prompt).toContain("verified price or from-price");
    expect(prompt).toContain("expected visit duration");
    expect(prompt).toContain("accessibility");
    expect(prompt).toContain("parking/public transport");
    expect(prompt).toContain('practical "before you go" advice');
    expect(prompt).toContain("FAQs based on real search intent");
    // The stand-alone "useful without a click" rule.
    expect(prompt).toContain(
      "the page should provide enough useful information that a visitor benefits even if they never click an affiliate link",
    );
  });

  it("uses non-promissory AdSense-readiness wording", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain(
      "Improve this page's overall content quality and usefulness so it is stronger for users and better aligned with monetisation-quality expectations.",
    );
    expect(prompt).toContain(
      "Do not claim the page qualifies for AdSense or guarantee approval.",
    );
    // Never an affirmative/promissory claim of approval.
    expect(prompt).not.toContain("This page qualifies for AdSense");
    expect(prompt).not.toContain("is guaranteed");
    expect(prompt).not.toContain("will be approved");
  });

  it("never invents page-content or diagnosis details it cannot verify", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    const prompt = buildFixPrompt(SITE, row);

    // Every page-evidence field is explicitly marked unavailable, never
    // guessed at.
    for (const field of [
      "Title",
      "Meta description",
      "H1",
      "Main content",
      "Price",
      "CTA/provider",
      "Structured data",
      "Internal links",
      "Images",
    ]) {
      expect(prompt).toContain(`- ${field}: Not inspected / unavailable`);
    }
    expect(prompt).toContain(
      "User-value/content weakness: Not inspected / unavailable",
    );
    expect(prompt).toContain(
      "Monetisation-quality weakness: Not inspected / unavailable",
    );
    expect(prompt).toContain(
      "Do not invent facts, prices, dates, accessibility details, opening hours or facilities.",
    );
    expect(prompt).toContain(
      "If information cannot be verified, omit it or clearly mark it as unavailable.",
    );
  });

  it("includes internal-link suggestions when provided, with honest existing-link wording", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });
    const suggestion = (
      targetLinkStatus: InternalLinkSuggestion["targetLinkStatus"],
    ): InternalLinkSuggestion => ({
      sourceUrl: "https://ninjatickets.com/things-to-do-in-london/",
      sourceTitle: "Things to Do in London",
      targetUrl: "/event/example/",
      matchedTerms: ["london", "event"],
      hasSearchVisibility: true,
      relevanceScore: 3,
      suggestedAnchor: "Example Event",
      targetLinkStatus,
    });

    const notVerifiedPrompt = buildFixPrompt(SITE, row, [
      suggestion("not-verified"),
    ]);
    expect(notVerifiedPrompt).toContain("Internal link opportunities");
    expect(notVerifiedPrompt).toContain(
      "https://ninjatickets.com/things-to-do-in-london/",
    );
    expect(notVerifiedPrompt).toContain('"Example Event"');
    expect(notVerifiedPrompt).toContain("london, event");
    expect(notVerifiedPrompt).toContain(
      "this source page already has its own Search Console visibility",
    );
    expect(notVerifiedPrompt).toContain("existing link not verified");
    expect(notVerifiedPrompt).toContain(
      "Analyse and recommend only - do not add these links yet.",
    );

    const weakPrompt = buildFixPrompt(SITE, row, [
      suggestion("target-weakly-linked"),
    ]);
    expect(weakPrompt).toContain("flags this target as weakly linked");

    const wellLinkedPrompt = buildFixPrompt(SITE, row, [
      suggestion("target-well-linked"),
    ]);
    expect(wellLinkedPrompt).toContain("already adequately linked overall");
  });

  it("says no relevant page was found rather than suggesting an unrelated one", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });

    const prompt = buildFixPrompt(SITE, row, []);

    expect(prompt).toContain(
      "No genuinely relevant existing page found in the current page inventory",
    );
    expect(prompt).toContain(
      "do not add an internal link from an unrelated page just for SEO",
    );
  });

  it("says internal links weren't analysed when no page inventory was passed at all", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).toContain(
      "Not analysed this run - no page inventory was available.",
    );
  });

  it("adds a CTR Fix Prompt section with real numbers and diagnosis when a CTR opportunity is provided", () => {
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
    const [row] = rows;

    const [ctrOpportunity] = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map(),
    });
    expect(ctrOpportunity).toBeDefined();

    const prompt = buildFixPrompt(SITE, row, undefined, ctrOpportunity);

    expect(prompt).toContain("CTR opportunity diagnosis (Phase 3)");
    expect(prompt).toContain("Actual CTR: 0.00%");
    expect(prompt).toContain("Expected CTR:");
    expect(prompt).toContain("CTR gap:");
    expect(prompt).toContain("Estimated missed clicks:");
    expect(prompt).toContain("title-clarity");
    expect(prompt).toContain("title-intent-mismatch");
    expect(prompt).toContain("weak-value-proposition");
    expect(prompt).toContain("missing-ticket-context");
    expect(prompt).toContain("vague-meta-description");
    expect(prompt).toContain("poor-differentiation");
    expect(prompt).toContain("snippet-rewrite-likely");
    expect(prompt).toContain("Recommended change:");
    expect(prompt).toContain("## 8. CTR-specific rules");
    expect(prompt).toContain("Improve search-result appeal without clickbait.");
    expect(prompt).toContain("Keep the title within a sensible SERP length");
    expect(prompt).toContain(
      "so Google is more likely to use the intended snippet",
    );
    // No site-audit evidence supplied for this row - still honestly marked.
    expect(prompt).toContain("- Title: Not inspected / unavailable");
  });

  it("uses real captured title/meta from the last Site Audit crawl in the CTR Fix Prompt instead of 'Not inspected'", () => {
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
    const [row] = rows;

    const evidence: SiteAuditPageEvidence = {
      title: "Home | NinjaTickets",
      titleLength: 19,
      metaDescription: null,
      metaDescriptionLength: null,
      h1Count: 1,
    };
    const [ctrOpportunity] = findCtrOpportunities({
      rows,
      pageEvidenceByUrl: new Map([["/event/west-end-show/", evidence]]),
    });

    const prompt = buildFixPrompt(SITE, row, undefined, ctrOpportunity);

    expect(prompt).toContain('- Title: "Home | NinjaTickets"');
    expect(prompt).toContain("from the last Site Audit crawl");
    expect(prompt).toContain(
      "- Meta description: Not captured by the last Site Audit crawl",
    );
    expect(prompt).toContain(
      "H1: Not captured as text anywhere in this app (only a count is tracked: 1)",
    );
  });

  it("never renders the CTR Fix Prompt section when no CTR opportunity is provided", () => {
    const [row] = computeKeywordOpportunities({
      site: SITE,
      queryRows: [q("event tickets", "2026-01-10", 5, 50, 7)],
      bingQueryRows: [],
      queryPageRows: [
        qp("event tickets", "/event/example/", "2026-01-10", 5, 50),
      ],
      days: 7,
    });

    const prompt = buildFixPrompt(SITE, row);

    expect(prompt).not.toContain("CTR opportunity diagnosis");
    expect(prompt).not.toContain("## 8. CTR-specific rules");
  });
});
