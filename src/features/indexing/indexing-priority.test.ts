import { describe, expect, it } from "vitest";
import {
  buildIndexingCandidates,
  classifyPageType,
  summarizeIndexingCandidates,
  summaryBucketFor,
} from "@/features/indexing/indexing-priority";
import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";
import type { UrlInspection } from "@/types/database";

function row(
  overrides: Partial<KeywordOpportunityRow> = {},
): KeywordOpportunityRow {
  return {
    query: "llandudno chocolate experience tickets",
    rankingUrl:
      "https://ninjatickets.com/event/llandudno-chocolate-experience-llandudno/",
    previousRankingUrl: null,
    competingUrls: [],
    clicks: 0,
    clicksPrev: 0,
    clicksChangePct: null,
    impressions: 30,
    impressionsPrev: 0,
    impressionsChangePct: null,
    ctr: 0,
    currentPosition: 5,
    previousPosition: null,
    positionChange: null,
    positionStability: null,
    firstSeen: "2026-09-01",
    lastSeen: "2026-09-20",
    trend: "stable",
    branded: false,
    bingImpressions: 0,
    categories: [],
    score: { score: 60, factors: [] },
    recommendedAction: "",
    ...overrides,
  };
}

function inspection(overrides: Partial<UrlInspection> = {}): UrlInspection {
  return {
    site_id: "site-1",
    url: "https://ninjatickets.com/event/llandudno-chocolate-experience-llandudno/",
    last_inspected_at: "2026-09-10T00:00:00Z",
    inspected_by: null,
    verdict: "PASS",
    coverage_state: "Submitted and indexed",
    robots_txt_state: "ALLOWED",
    indexing_state: "INDEXING_ALLOWED",
    page_fetch_state: "SUCCESSFUL",
    google_canonical: null,
    user_canonical: null,
    last_crawl_time: "2026-09-05T00:00:00Z",
    crawled_as: "MOBILE",
    sitemaps: [],
    ninja_status: "indexed",
    site_lastmod: null,
    raw_response: null,
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-22T12:00:00Z");

describe("classifyPageType", () => {
  it("classifies the brief's own worked example as an event page", () => {
    expect(
      classifyPageType(
        "https://ninjatickets.com/event/llandudno-chocolate-experience-llandudno/",
      ),
    ).toBe("event");
  });
  it("classifies a guide URL", () => {
    expect(
      classifyPageType(
        "https://ninjatickets.com/guides/anastacia-uk-tour-2026-tickets/",
      ),
    ).toBe("guide");
  });
  it("classifies the homepage", () => {
    expect(classifyPageType("https://ninjatickets.com/")).toBe("homepage");
  });
});

describe("buildIndexingCandidates", () => {
  it("detects the brief's Llandudno Chocolate Experience example as a high-priority CTR-and-position candidate", () => {
    const candidates = buildIndexingCandidates({
      opportunityRows: [row()], // position 5, 30 impressions, 0 clicks/CTR
      siteLastmods: new Map(),
      inspections: new Map(),
      now: NOW,
    });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.currentPosition).toBe(5);
    expect(c.priorityScore).toBeGreaterThan(0);
    expect(c.reasons.some((r) => r.includes("4-15 band"))).toBe(true);
    expect(c.reasons.some((r) => r.includes("CTR"))).toBe(true);
    // Never inspected -> included in reasons and bucketed accordingly.
    expect(c.reasons.some((r) => r.includes("Never inspected"))).toBe(true);
    expect(summaryBucketFor(c)).toBe("never_inspected");
  });

  it("flags a page changed after Google's last crawl (the Oasis Tickets 2027 example)", () => {
    const url = "https://ninjatickets.com/oasis-tickets/";
    const candidates = buildIndexingCandidates({
      opportunityRows: [
        row({
          rankingUrl: url,
          query: "oasis tickets 2027",
          currentPosition: 10,
          impressions: 500,
          ctr: 0.005,
        }),
      ],
      siteLastmods: new Map([[url, "2026-09-20"]]), // changed 20th
      inspections: new Map([
        [url, inspection({ url, last_crawl_time: "2026-09-10T00:00:00Z" })], // crawled 10th
      ]),
      now: NOW,
    });
    const c = candidates.find((x) => x.url === url)!;
    expect(c.reasons.some((r) => r.includes("after Google's last crawl"))).toBe(
      true,
    );
    expect(c.priorityLevel === "high" || c.priorityLevel === "critical").toBe(
      true,
    );
  });

  it("does not claim a material change when the site lastmod predates Google's last crawl", () => {
    const url = "https://ninjatickets.com/event/some-event/";
    const candidates = buildIndexingCandidates({
      opportunityRows: [
        row({
          rankingUrl: url,
          currentPosition: 8,
          impressions: 50,
          ctr: 0.02,
        }),
      ],
      siteLastmods: new Map([[url, "2026-09-01"]]),
      inspections: new Map([
        [url, inspection({ url, last_crawl_time: "2026-09-15T00:00:00Z" })],
      ]),
      now: NOW,
    });
    const c = candidates.find((x) => x.url === url)!;
    expect(c.reasons.some((r) => r.includes("after Google's last crawl"))).toBe(
      false,
    );
  });

  it("gives /event/ pages an affiliate-value reason and technical flags a technical reason", () => {
    const url = "https://ninjatickets.com/event/high-value/";
    const candidates = buildIndexingCandidates({
      opportunityRows: [
        row({
          rankingUrl: url,
          currentPosition: 6,
          impressions: 20,
          ctr: 0.01,
        }),
      ],
      siteLastmods: new Map(),
      inspections: new Map([[url, inspection({ url })]]),
      technicalFlagsByUrl: new Map([[url, ["noindex", "non-self canonical"]]]),
      now: NOW,
    });
    const c = candidates.find((x) => x.url === url)!;
    expect(c.reasons.some((r) => r.includes("High-value ticket page"))).toBe(
      true,
    );
    expect(c.reasons.some((r) => r.includes("Technical concerns"))).toBe(true);
  });

  it("never invents a candidate URL with no real signal at all", () => {
    const candidates = buildIndexingCandidates({
      opportunityRows: [row({ rankingUrl: null })], // no ranking URL -> excluded
      siteLastmods: new Map(),
      inspections: new Map(),
      now: NOW,
    });
    expect(candidates).toHaveLength(0);
  });

  it("excludes low-impression rows from the candidate set (do not inspect blindly)", () => {
    const candidates = buildIndexingCandidates({
      opportunityRows: [row({ impressions: 1 })],
      siteLastmods: new Map(),
      inspections: new Map(),
      now: NOW,
    });
    expect(candidates).toHaveLength(0);
  });

  it("sorts by priority score descending", () => {
    const strong = row({
      rankingUrl: "https://ninjatickets.com/event/a/",
      currentPosition: 5,
      impressions: 200,
      ctr: 0.001,
    });
    const weak = row({
      rankingUrl: "https://ninjatickets.com/event/b/",
      currentPosition: 45,
      impressions: 6,
      ctr: 0.02,
    });
    const candidates = buildIndexingCandidates({
      opportunityRows: [strong, weak],
      siteLastmods: new Map(),
      inspections: new Map(),
      now: NOW,
    });
    expect(candidates[0].url).toBe("https://ninjatickets.com/event/a/");
    expect(candidates[0].priorityScore).toBeGreaterThanOrEqual(
      candidates[1].priorityScore,
    );
  });
});

describe("summarizeIndexingCandidates", () => {
  it("buckets a mix of statuses, treating never-inspected and 'unknown' the same", () => {
    const base = {
      url: "u",
      pageType: "event" as const,
      bestQuery: null,
      currentPosition: null,
      impressions: 0,
      clicks: 0,
      actualCtr: null,
      opportunityScore: null,
      siteLastmod: null,
      technicalFlags: [],
      priorityScore: 0,
      priorityLevel: "low" as const,
      reasons: [],
    };
    const candidates = [
      { ...base, inspection: inspection({ ninja_status: "indexed" }) },
      { ...base, inspection: inspection({ ninja_status: "blocked" }) },
      { ...base, inspection: inspection({ ninja_status: "unknown" }) },
      { ...base, inspection: null },
    ];
    const summary = summarizeIndexingCandidates(candidates);
    expect(summary.indexed).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.never_inspected).toBe(2);
  });
});
