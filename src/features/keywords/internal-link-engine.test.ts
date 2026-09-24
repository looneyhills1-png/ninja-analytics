import { describe, expect, it } from "vitest";
import {
  findInternalLinkOpportunities,
  naturalAnchorFromSlug,
  type CandidatePage,
} from "@/features/keywords/internal-link-engine";

function page(
  url: string,
  title: string | null,
  extraText: string | null = null,
  source: CandidatePage["source"] = "search-index",
): CandidatePage {
  return { url, title, extraText, source };
}

describe("findInternalLinkOpportunities", () => {
  it("suggests genuinely relevant existing pages for the Llandudno example from the brief, using only primaryPages", () => {
    const primaryPages = [
      page(
        "https://ninjatickets.com/things-to-do-in-llandudno/",
        "Things to Do in Llandudno",
        "North Wales Guide",
      ),
      page(
        "https://ninjatickets.com/north-wales-family-attractions/",
        "North Wales Family Attractions",
        "Llandudno, Conwy & Anglesey",
      ),
      page(
        "https://ninjatickets.com/event/comedy-night-brighton/",
        "Comedy Night Brighton Tickets",
      ),
      page("https://ninjatickets.com/about/", "About NinjaTickets"),
    ];

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience tickets",
      primaryPages,
      pagesWithSearchVisibility: new Set(),
    });

    const sourceUrls = suggestions.map((s) => s.sourceUrl);
    expect(sourceUrls).toContain(
      "https://ninjatickets.com/things-to-do-in-llandudno/",
    );
    expect(sourceUrls).toContain(
      "https://ninjatickets.com/north-wales-family-attractions/",
    );
    // Genuinely unrelated pages are never suggested just to fill a quota.
    expect(sourceUrls).not.toContain(
      "https://ninjatickets.com/event/comedy-night-brighton/",
    );
    expect(sourceUrls).not.toContain("https://ninjatickets.com/about/");

    const llandudnoPage = suggestions.find((s) =>
      s.sourceUrl.includes("things-to-do-in-llandudno"),
    )!;
    expect(llandudnoPage.matchedTerms).toContain("llandudno");
    expect(llandudnoPage.suggestedAnchor).toBe(
      "Llandudno Chocolate Experience",
    );
  });

  it("works with zero Common Crawl / supplemental data - primaryPages alone is enough", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages: [
        page(
          "https://ninjatickets.com/things-to-do-in-llandudno/",
          "Things to Do in Llandudno",
        ),
      ],
      // supplementalPages omitted entirely.
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toHaveLength(1);
  });

  it("never suggests the target page as a link source for itself", () => {
    const primaryPages = [
      page(
        "https://ninjatickets.com/event/llandudno-chocolate-experience-llandudno/",
        "Llandudno Chocolate Experience Tickets",
      ),
      page(
        "https://ninjatickets.com/things-to-do-in-llandudno/",
        "Things to Do in Llandudno",
      ),
    ];

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience tickets",
      primaryPages,
      pagesWithSearchVisibility: new Set(),
    });

    expect(
      suggestions.some((s) =>
        s.sourceUrl.includes("llandudno-chocolate-experience-llandudno"),
      ),
    ).toBe(false);
  });

  it("prefers pages with existing search visibility when scoring", () => {
    const primaryPages = [
      page(
        "https://ninjatickets.com/things-to-do-in-llandudno/",
        "Things to Do in Llandudno",
      ),
      page(
        "https://ninjatickets.com/north-wales-llandudno-guide/",
        "Llandudno Guide",
      ),
    ];

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages,
      pagesWithSearchVisibility: new Set(["/north-wales-llandudno-guide/"]),
    });

    const visible = suggestions.find((s) =>
      s.sourceUrl.includes("north-wales-llandudno-guide"),
    )!;
    expect(visible.hasSearchVisibility).toBe(true);
    const other = suggestions.find((s) =>
      s.sourceUrl.includes("things-to-do-in-llandudno"),
    )!;
    expect(visible.relevanceScore).toBeGreaterThanOrEqual(other.relevanceScore);
  });

  it("caps suggestions at maxSuggestions to avoid excessive sitewide linking", () => {
    const primaryPages = Array.from({ length: 20 }, (_, i) =>
      page(
        `https://ninjatickets.com/llandudno-guide-${i}/`,
        `Llandudno Guide ${i}`,
      ),
    );

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages,
      pagesWithSearchVisibility: new Set(),
      maxSuggestions: 3,
    });

    expect(suggestions).toHaveLength(3);
  });

  it("returns nothing when the target has no meaningful query/URL tokens", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/tickets/",
      targetQuery: "tickets",
      primaryPages: [page("https://ninjatickets.com/about/", "About")],
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toEqual([]);
  });

  it("handles candidate rows stored as a bare path instead of an absolute URL", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate",
      primaryPages: [
        page("/things-to-do-in-llandudno/", "Things to Do in Llandudno"),
      ],
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toHaveLength(1);
  });

  it("merges supplementalPages (Common Crawl) but only to fill in URLs primaryPages doesn't already have", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages: [
        page(
          "https://ninjatickets.com/things-to-do-in-llandudno/",
          "Things to Do in Llandudno (current)",
        ),
      ],
      supplementalPages: [
        // Same URL as a primary page - primary's title should win, not be
        // duplicated as a second suggestion ("avoid duplicate target
        // suggestions").
        page(
          "https://ninjatickets.com/things-to-do-in-llandudno/",
          "Things to Do in Llandudno (stale Common Crawl copy)",
          null,
          "common-crawl",
        ),
        // A URL only Common Crawl knows about - historical enrichment.
        page(
          "https://ninjatickets.com/llandudno-old-guide/",
          "Llandudno Old Guide",
          null,
          "common-crawl",
        ),
      ],
      pagesWithSearchVisibility: new Set(),
    });

    const bySource = new Map(suggestions.map((s) => [s.sourceUrl, s]));
    expect(suggestions).toHaveLength(2);
    expect(
      bySource.get("https://ninjatickets.com/things-to-do-in-llandudno/")
        ?.sourceTitle,
    ).toBe("Things to Do in Llandudno (current)");
    expect(bySource.has("https://ninjatickets.com/llandudno-old-guide/")).toBe(
      true,
    );
  });

  it("reports targetLinkStatus honestly from the internal-link audit data, or not-verified when unavailable", () => {
    const primaryPages = [
      page(
        "https://ninjatickets.com/things-to-do-in-llandudno/",
        "Things to Do in Llandudno",
      ),
    ];
    const base = {
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages,
      pagesWithSearchVisibility: new Set<string>(),
    };

    const notVerified = findInternalLinkOpportunities(base);
    expect(notVerified[0].targetLinkStatus).toBe("not-verified");

    const weak = findInternalLinkOpportunities({
      ...base,
      weaklyLinkedTargetUrls: new Set([
        "/event/llandudno-chocolate-experience-llandudno/",
      ]),
    });
    expect(weak[0].targetLinkStatus).toBe("target-weakly-linked");

    const wellLinked = findInternalLinkOpportunities({
      ...base,
      weaklyLinkedTargetUrls: new Set(["/some-other-page/"]),
    });
    expect(wellLinked[0].targetLinkStatus).toBe("target-well-linked");
  });

  it("never suggests a page whose only shared term is generic ticketing/commerce filler (2026-09-24 Sale Sharks / Oasis regression)", () => {
    const primaryPages = [
      page(
        "https://ninjatickets.com/sale-sharks-tickets/",
        "Sale Sharks Tickets",
      ),
    ];

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/oasis-uk-tour-2026-tickets/",
      targetQuery: "when do oasis tickets go on sale",
      primaryPages,
      pagesWithSearchVisibility: new Set(),
    });

    expect(suggestions).toEqual([]);
  });

  it("uses extraText (blurb/category/city from search-index.json) for relevance, not just title/URL", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      primaryPages: [
        page(
          "https://ninjatickets.com/wales-guide/",
          "Wales Guide",
          "Covers Llandudno, Conwy and Bangor",
        ),
      ],
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].matchedTerms).toContain("llandudno");
  });
});

describe("naturalAnchorFromSlug", () => {
  it("collapses a repeated word from a real event slug (location as both prefix and suffix)", () => {
    expect(
      naturalAnchorFromSlug("/event/llandudno-chocolate-experience-llandudno/"),
    ).toBe("Llandudno Chocolate Experience");
  });

  it("title-cases a simple slug with no repeats", () => {
    expect(naturalAnchorFromSlug("/event/west-end-theatre-week/")).toBe(
      "West End Theatre Week",
    );
  });
});
