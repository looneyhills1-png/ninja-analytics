import { describe, expect, it } from "vitest";
import type { CommonCrawlPage } from "@/types/database";
import {
  findInternalLinkOpportunities,
  naturalAnchorFromSlug,
} from "@/features/keywords/internal-link-engine";

function page(url: string, title: string | null): CommonCrawlPage {
  return {
    id: url,
    domain: "ninjatickets.com",
    url,
    first_seen: "2026-01-01",
    last_seen: "2026-01-01",
    cdx_status_code: 200,
    last_status_code: 200,
    mime_type: "text/html",
    title,
    is_active: true,
    last_checked_at: "2026-01-01T00:00:00Z",
  } as CommonCrawlPage;
}

describe("findInternalLinkOpportunities", () => {
  it("suggests genuinely relevant existing pages for the Llandudno example from the brief", () => {
    const candidates = [
      page(
        "https://ninjatickets.com/things-to-do-in-llandudno/",
        "Things to Do in Llandudno | North Wales Guide",
      ),
      page(
        "https://ninjatickets.com/north-wales-family-attractions/",
        "North Wales Family Attractions: Llandudno, Conwy & Anglesey",
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
      candidatePages: candidates,
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
    expect(llandudnoPage.existingLinkStatus).toBe("not-inspected");
    expect(llandudnoPage.suggestedAnchor).toBe(
      "Llandudno Chocolate Experience",
    );
  });

  it("never suggests the target page as a link source for itself", () => {
    const candidates = [
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
      candidatePages: candidates,
      pagesWithSearchVisibility: new Set(),
    });

    expect(
      suggestions.some((s) =>
        s.sourceUrl.includes("llandudno-chocolate-experience-llandudno"),
      ),
    ).toBe(false);
  });

  it("prefers pages with existing search visibility when scoring", () => {
    const candidates = [
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
      candidatePages: candidates,
      pagesWithSearchVisibility: new Set([
        "/north-wales-llandudno-guide/",
      ]),
    });

    const visible = suggestions.find((s) =>
      s.sourceUrl.includes("north-wales-llandudno-guide"),
    )!;
    expect(visible.hasSearchVisibility).toBe(true);
    // The visible page should rank at or above an equally-matched page with
    // no known visibility, since visibility only ever adds to the score.
    const other = suggestions.find((s) =>
      s.sourceUrl.includes("things-to-do-in-llandudno"),
    )!;
    expect(visible.relevanceScore).toBeGreaterThanOrEqual(
      other.relevanceScore,
    );
  });

  it("caps suggestions at maxSuggestions to avoid excessive sitewide linking", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      page(
        `https://ninjatickets.com/llandudno-guide-${i}/`,
        `Llandudno Guide ${i}`,
      ),
    );

    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate experience",
      candidatePages: candidates,
      pagesWithSearchVisibility: new Set(),
      maxSuggestions: 3,
    });

    expect(suggestions).toHaveLength(3);
  });

  it("returns nothing when the target has no meaningful query/URL tokens", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/tickets/",
      targetQuery: "tickets",
      candidatePages: [page("https://ninjatickets.com/about/", "About")],
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toEqual([]);
  });

  it("handles candidate rows stored as a bare path instead of an absolute URL", () => {
    const suggestions = findInternalLinkOpportunities({
      targetUrl: "/event/llandudno-chocolate-experience-llandudno/",
      targetQuery: "llandudno chocolate",
      candidatePages: [
        page("/things-to-do-in-llandudno/", "Things to Do in Llandudno"),
      ],
      pagesWithSearchVisibility: new Set(),
    });
    expect(suggestions).toHaveLength(1);
  });
});

describe("naturalAnchorFromSlug", () => {
  it("collapses a repeated word from a real event slug (location as both prefix and suffix)", () => {
    expect(
      naturalAnchorFromSlug(
        "/event/llandudno-chocolate-experience-llandudno/",
      ),
    ).toBe("Llandudno Chocolate Experience");
  });

  it("title-cases a simple slug with no repeats", () => {
    expect(naturalAnchorFromSlug("/event/west-end-theatre-week/")).toBe(
      "West End Theatre Week",
    );
  });
});
