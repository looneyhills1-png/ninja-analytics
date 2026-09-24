import { describe, expect, it } from "vitest";
import {
  normalizeBingRows,
  normalizeBingQueryRows,
  normalizeBingPageRows,
  normalizeBingCrawlStatsRows,
  parseMicrosoftDate,
  findMatchingBingSite,
  hasEmbeddedBingError,
  normalizeSiteUrl,
} from "../../supabase/functions/_shared/bing-parse";

const SITE = "site-1";
const UPDATED = "2026-06-21T00:00:00.000Z";

describe("parseMicrosoftDate", () => {
  it("parses Microsoft JSON dates with an offset", () => {
    // 1718841600000 ms = 2024-06-20T00:00:00Z
    expect(parseMicrosoftDate("/Date(1718841600000+0000)/")).toBe("2024-06-20");
  });
  it("parses Microsoft JSON dates without an offset", () => {
    expect(parseMicrosoftDate("/Date(1718841600000)/")).toBe("2024-06-20");
  });
  it("tolerates a plain ISO date", () => {
    expect(parseMicrosoftDate("2026-06-20")).toBe("2026-06-20");
  });
  it("returns null for junk or non-strings", () => {
    expect(parseMicrosoftDate("not a date")).toBeNull();
    expect(parseMicrosoftDate(12345)).toBeNull();
    expect(parseMicrosoftDate(undefined)).toBeNull();
  });
});

describe("normalizeBingRows", () => {
  it("maps clicks/impressions and leaves ctr/position null", () => {
    const rows = normalizeBingRows(
      [{ Date: "/Date(1718841600000+0000)/", Clicks: 12, Impressions: 340 }],
      SITE,
      UPDATED,
    );
    expect(rows[0]).toEqual({
      site_id: SITE,
      engine: "bing",
      metric_date: "2024-06-20",
      clicks: 12,
      impressions: 340,
      ctr: null,
      average_position: null,
      updated_at: UPDATED,
    });
  });

  it("drops rows with an unparseable date", () => {
    const rows = normalizeBingRows(
      [{ Date: "bad", Clicks: 1, Impressions: 2 }],
      SITE,
      UPDATED,
    );
    expect(rows).toHaveLength(0);
  });

  it("dedupes by date so an upsert can't hit a row twice", () => {
    const rows = normalizeBingRows(
      [
        { Date: "/Date(1718841600000)/", Clicks: 1, Impressions: 10 },
        { Date: "/Date(1718841600000)/", Clicks: 5, Impressions: 50 },
      ],
      SITE,
      UPDATED,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].clicks).toBe(5); // last write wins
  });

  it("caps an unreasonable payload", () => {
    const many: { Date: string; Clicks: number; Impressions: number }[] = [];
    for (let i = 0; i < 50; i++) {
      // distinct days so dedupe keeps them all
      const ms = 1718841600000 + i * 86_400_000;
      many.push({ Date: `/Date(${ms})/`, Clicks: i, Impressions: i });
    }
    expect(normalizeBingRows(many, SITE, UPDATED, 10)).toHaveLength(10);
  });

  it("handles an undefined array", () => {
    expect(normalizeBingRows(undefined, SITE, UPDATED)).toEqual([]);
  });
});

// Fixtures captured verbatim from a live diagnose-bing run against the real
// ninjatickets.com Bing Webmaster account (2026-09-14, session
// claude/bing-diagnostic-verify-jwt). At the time of capture every stats
// endpoint legitimately returned zero rows, so this is the real envelope
// shape proven live - not yet a live-verified NON-EMPTY row, which remains
// an open gap until Bing actually reports traffic for this site.
const LIVE_GET_USER_SITES_BODY = {
  d: [
    {
      Url: "https://ninjatickets.com/",
      __type: "Site:#Microsoft.Bing.Webmaster.Api",
      IsVerified: true,
      AuthenticationCode: "AE0926BE819D0F0EF5C344169CB84542",
      DnsVerificationCode: "432618fc1657908222ae819b73e62173.ninjatickets.com",
    },
  ],
};
const LIVE_EMPTY_STATS_BODY = { d: [] };

// Fixtures captured verbatim from a live diagnose-bing run against the real
// ninjatickets.com Bing Webmaster account (2026-09-24, PART 2 of the SEO Fix
// Workflow + Bing Visibility brief - run id 36018096930). This is the run
// that proved GetQueryStats/GetPageStats/GetCrawlStats genuinely return
// non-empty data for this site, which is why they were never called by the
// sync adapter before this - a missing implementation, not an API or data
// limitation.
const LIVE_GET_QUERY_STATS_D = [
  {
    Date: "/Date(1789689600000)/",
    Query: "what is the venue and scale for reading festival",
    Clicks: 0,
    Impressions: 2,
    AvgClickPosition: -1,
    AvgImpressionPosition: 6,
  },
  {
    Date: "/Date(1789689600000)/",
    Query: "blackpool 80s weekender 2026",
    Clicks: 0,
    Impressions: 1,
    AvgClickPosition: -1,
    AvgImpressionPosition: 9,
  },
];
const LIVE_GET_PAGE_STATS_D = [
  {
    Date: "/Date(1789689600000)/",
    Query:
      "https://ninjatickets.com/guides/reading-festival-2026-tickets-guide/",
    Clicks: 0,
    Impressions: 6,
    AvgClickPosition: -1,
    AvgImpressionPosition: 6,
  },
  {
    Date: "/Date(1789689600000)/",
    Query: "https://ninjatickets.com/event/blackpool-80s-weekender-2026/",
    Clicks: 0,
    Impressions: 4,
    AvgClickPosition: -1,
    AvgImpressionPosition: 9,
  },
];
const LIVE_GET_CRAWL_STATS_D = [
  {
    Date: "/Date(1789516800000)/",
    Code2xx: 59,
    Code301: 9,
    Code302: 0,
    Code4xx: 0,
    Code5xx: 0,
    InIndex: 56,
    InLinks: 45,
    CrawlErrors: 1,
    DnsFailures: 0,
    CrawledPages: 11,
    AllOtherCodes: 35,
    ContainsMalware: 0,
    ConnectionTimeout: 0,
    BlockedByRobotsTxt: 1,
  },
];

describe("normalizeBingQueryRows (live GetQueryStats fixture)", () => {
  it("maps real query rows, computing ctr locally and nulling the -1 no-click sentinel", () => {
    const rows = normalizeBingQueryRows(LIVE_GET_QUERY_STATS_D, SITE, UPDATED);
    expect(rows).toHaveLength(2);
    const reading = rows.find((r) => r.query.startsWith("what is the venue"))!;
    expect(reading).toEqual({
      site_id: SITE,
      engine: "bing",
      metric_date: "2026-09-18",
      query: "what is the venue and scale for reading festival",
      clicks: 0,
      impressions: 2,
      ctr: 0,
      average_position: 6,
      updated_at: UPDATED,
    });
  });

  it("drops rows with no query text or unparseable date", () => {
    expect(
      normalizeBingQueryRows(
        [{ Date: "/Date(1789689600000)/", Impressions: 1 }],
        SITE,
        UPDATED,
      ),
    ).toHaveLength(0);
    expect(
      normalizeBingQueryRows(
        [{ Date: "bad", Query: "x", Impressions: 1 }],
        SITE,
        UPDATED,
      ),
    ).toHaveLength(0);
  });

  it("nulls ctr when impressions is zero rather than dividing by zero", () => {
    const rows = normalizeBingQueryRows(
      [
        {
          Date: "/Date(1789689600000)/",
          Query: "x",
          Clicks: 0,
          Impressions: 0,
        },
      ],
      SITE,
      UPDATED,
    );
    expect(rows[0].ctr).toBeNull();
  });
});

describe("normalizeBingPageRows (live GetPageStats fixture)", () => {
  it("maps the page URL out of Bing's `Query` field (a real API quirk, not a bug)", () => {
    const rows = normalizeBingPageRows(LIVE_GET_PAGE_STATS_D, SITE, UPDATED);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.page)).toContain(
      "https://ninjatickets.com/event/blackpool-80s-weekender-2026/",
    );
    expect(rows[0].average_position).not.toBeNull();
  });
});

describe("normalizeBingCrawlStatsRows (live GetCrawlStats fixture)", () => {
  it("maps real crawl/index health counters, confirming Bing has this site's pages indexed", () => {
    const rows = normalizeBingCrawlStatsRows(
      LIVE_GET_CRAWL_STATS_D,
      SITE,
      UPDATED,
    );
    expect(rows).toEqual([
      {
        site_id: SITE,
        metric_date: "2026-09-16",
        crawled_pages: 11,
        in_index: 56,
        in_links: 45,
        crawl_errors: 1,
        dns_failures: 0,
        blocked_by_robots_txt: 1,
        code_2xx: 59,
        code_301: 9,
        code_302: 0,
        code_4xx: 0,
        code_5xx: 0,
        contains_malware: 0,
        connection_timeout: 0,
        all_other_codes: 35,
        updated_at: UPDATED,
      },
    ]);
  });

  it("handles an undefined array", () => {
    expect(normalizeBingCrawlStatsRows(undefined, SITE, UPDATED)).toEqual([]);
  });
});

describe("normalizeSiteUrl", () => {
  it("normalizes protocol, www and trailing slash the same way", () => {
    expect(normalizeSiteUrl("https://ninjatickets.com/")).toBe(
      "ninjatickets.com",
    );
    expect(normalizeSiteUrl("http://www.ninjatickets.com")).toBe(
      "ninjatickets.com",
    );
    expect(normalizeSiteUrl("NinjaTickets.com/")).toBe("ninjatickets.com");
  });
});

describe("findMatchingBingSite (live GetUserSites fixture)", () => {
  it("matches the configured URL against Bing's own returned site", () => {
    const match = findMatchingBingSite(
      LIVE_GET_USER_SITES_BODY.d,
      "https://ninjatickets.com/",
    );
    expect(match?.Url).toBe("https://ninjatickets.com/");
    expect(match?.IsVerified).toBe(true);
  });

  it("still matches when the configured value differs in protocol/www/slash", () => {
    const match = findMatchingBingSite(
      LIVE_GET_USER_SITES_BODY.d,
      "http://www.ninjatickets.com",
    );
    expect(match?.Url).toBe("https://ninjatickets.com/");
  });

  it("returns null when the configured site isn't among Bing's accessible sites", () => {
    const match = findMatchingBingSite(
      LIVE_GET_USER_SITES_BODY.d,
      "https://some-other-domain.example/",
    );
    expect(match).toBeNull();
  });
});

describe("hasEmbeddedBingError", () => {
  it("treats the live GetUserSites body as a genuine, error-free response", () => {
    expect(hasEmbeddedBingError(LIVE_GET_USER_SITES_BODY)).toBe(false);
  });

  it("treats a live legitimate empty stats body ({d: []}) as error-free", () => {
    expect(hasEmbeddedBingError(LIVE_EMPTY_STATS_BODY)).toBe(false);
  });

  it("flags a 200 response with `d` missing as suspicious, not empty", () => {
    expect(hasEmbeddedBingError({})).toBe(true);
  });

  it("flags a 200 response with `d` explicitly null as suspicious", () => {
    expect(hasEmbeddedBingError({ d: null })).toBe(true);
  });

  it("flags an envelope carrying extra top-level keys alongside `d`", () => {
    expect(
      hasEmbeddedBingError({ d: [], Message: "An error has occurred." }),
    ).toBe(true);
  });

  it("flags a non-object body (e.g. a bare array or string)", () => {
    expect(hasEmbeddedBingError([])).toBe(true);
    expect(hasEmbeddedBingError("oops")).toBe(true);
    expect(hasEmbeddedBingError(null)).toBe(true);
  });
});

describe("normalizeBingQueryRows", () => {
  it("maps Bing keyword rows including CTR and average impression position", () => {
    const rows = normalizeBingQueryRows(
      [
        {
          Date: "/Date(1718841600000+0000)/",
          Query: "ninjatickets",
          Clicks: 2,
          Impressions: 3,
          AvgClickPosition: 8,
          AvgImpressionPosition: 8.33,
        },
      ],
      SITE,
      UPDATED,
    );
    expect(rows[0]).toEqual({
      site_id: SITE,
      engine: "bing",
      metric_date: "2024-06-20",
      query: "ninjatickets",
      clicks: 2,
      impressions: 3,
      ctr: 2 / 3,
      average_position: 8.33,
      updated_at: UPDATED,
    });
  });
});

describe("normalizeBingPageRows", () => {
  it("maps GetPageStats Query field to the page URL", () => {
    const rows = normalizeBingPageRows(
      [
        {
          Date: "/Date(1718841600000+0000)/",
          Query: "https://ninjatickets.com/festivals/",
          Clicks: 1,
          Impressions: 9,
          AvgImpressionPosition: 4,
        },
      ],
      SITE,
      UPDATED,
    );
    expect(rows[0]).toEqual({
      site_id: SITE,
      engine: "bing",
      metric_date: "2024-06-20",
      page: "https://ninjatickets.com/festivals/",
      clicks: 1,
      impressions: 9,
      ctr: 1 / 9,
      average_position: 4,
      updated_at: UPDATED,
    });
  });
});
