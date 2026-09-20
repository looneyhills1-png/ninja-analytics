import { describe, expect, it } from "vitest";
import {
  computeCompetitorInsights,
  suggestCompetitorDomains,
  type CompetitorDomainRow,
  type ObservedSerpResultRow,
} from "@/lib/competitor-insights";

const SITE = "site-1";

function competitor(
  overrides: Partial<CompetitorDomainRow> = {},
): CompetitorDomainRow {
  return {
    id: "comp-1",
    siteId: SITE,
    domain: "rival.com",
    label: null,
    note: null,
    autoDiscovered: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function serp(
  overrides: Partial<ObservedSerpResultRow>,
): ObservedSerpResultRow {
  return {
    id: `serp-${Math.random()}`,
    siteId: SITE,
    query: "blue widgets",
    engine: "google",
    observedAt: "2026-01-15T00:00:00Z",
    domain: "our-site.com",
    url: null,
    rankObserved: null,
    isOwnSite: false,
    ...overrides,
  };
}

describe("computeCompetitorInsights", () => {
  it("classifies a query as stronger when our rank beats the competitor's", () => {
    const rows = [
      serp({
        query: "blue widgets",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 3,
        url: "https://our-site.com/blue-widgets",
      }),
      serp({
        query: "blue widgets",
        domain: "rival.com",
        rankObserved: 7,
      }),
    ];
    const [insight] = computeCompetitorInsights([competitor()], rows);
    expect(insight.gap).toHaveLength(1);
    expect(insight.gap[0].category).toBe("stronger");
    expect(insight.strongerCount).toBe(1);
  });

  it("classifies weaker, missing and unique correctly", () => {
    const rows = [
      // weaker: both present, we rank worse
      serp({
        query: "weaker q",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 9,
      }),
      serp({ query: "weaker q", domain: "rival.com", rankObserved: 2 }),
      // missing: competitor observed, we are not
      serp({ query: "missing q", domain: "rival.com", rankObserved: 4 }),
      // unique: we observed, competitor is not
      serp({
        query: "unique q",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 1,
      }),
    ];
    const [insight] = computeCompetitorInsights([competitor()], rows);
    const byQuery = new Map(insight.gap.map((g) => [g.query, g.category]));
    expect(byQuery.get("weaker q")).toBe("weaker");
    expect(byQuery.get("missing q")).toBe("missing");
    expect(byQuery.get("unique q")).toBe("unique");
  });

  it("uses only the most recent observation session per query for the gap table", () => {
    const rows = [
      serp({
        query: "blue widgets",
        observedAt: "2026-01-01T00:00:00Z",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 20,
      }),
      serp({
        query: "blue widgets",
        observedAt: "2026-01-01T00:00:00Z",
        domain: "rival.com",
        rankObserved: 3,
      }),
      serp({
        query: "blue widgets",
        observedAt: "2026-01-20T00:00:00Z",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 1,
      }),
      serp({
        query: "blue widgets",
        observedAt: "2026-01-20T00:00:00Z",
        domain: "rival.com",
        rankObserved: 5,
      }),
    ];
    const [insight] = computeCompetitorInsights([competitor()], rows);
    expect(insight.gap).toHaveLength(1);
    expect(insight.gap[0].lastObservedAt).toBe("2026-01-20T00:00:00Z");
    expect(insight.gap[0].category).toBe("stronger");
  });

  it("counts every historical appearance, not just the latest session", () => {
    const rows = [
      serp({
        query: "q1",
        observedAt: "2026-01-01T00:00:00Z",
        domain: "rival.com",
        rankObserved: 3,
      }),
      serp({
        query: "q2",
        observedAt: "2026-01-05T00:00:00Z",
        domain: "rival.com",
        rankObserved: 4,
      }),
      serp({
        query: "q1",
        observedAt: "2026-01-10T00:00:00Z",
        domain: "rival.com",
        rankObserved: 2,
      }),
    ];
    const [insight] = computeCompetitorInsights([competitor()], rows);
    expect(insight.appearanceCount).toBe(3);
    expect(insight.appearanceTrend).toHaveLength(3);
  });
});

describe("suggestCompetitorDomains", () => {
  it("suggests a domain that appears repeatedly but isn't tracked yet", () => {
    const rows = [
      serp({ query: "q1", domain: "newcomer.com", rankObserved: 5 }),
      serp({ query: "q2", domain: "newcomer.com", rankObserved: 6 }),
    ];
    const suggestions = suggestCompetitorDomains([], rows);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].domain).toBe("newcomer.com");
    expect(suggestions[0].appearanceCount).toBe(2);
  });

  it("does not suggest a domain that appeared only once", () => {
    const rows = [
      serp({ query: "q1", domain: "one-hit.com", rankObserved: 5 }),
    ];
    expect(suggestCompetitorDomains([], rows)).toHaveLength(0);
  });

  it("never suggests our own site or an already-tracked domain", () => {
    const rows = [
      serp({
        query: "q1",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 1,
      }),
      serp({
        query: "q2",
        domain: "our-site.com",
        isOwnSite: true,
        rankObserved: 1,
      }),
      serp({ query: "q1", domain: "rival.com", rankObserved: 2 }),
      serp({ query: "q2", domain: "rival.com", rankObserved: 2 }),
    ];
    expect(suggestCompetitorDomains([competitor()], rows)).toHaveLength(0);
  });
});
