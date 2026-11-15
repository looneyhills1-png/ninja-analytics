import { describe, expect, it } from "vitest";
import {
  allowedHosts,
  applyLiveCanonical,
  classifyLive,
  diagnoseUrl,
  headerNoindex,
  indexHtmlTarget,
  inspectionQueue,
  isAssetUrl,
  LIMITS,
  liveQueue,
  mergeInventory,
  normalizeUrl,
  summariseCoverage,
  type InspectionFact,
  type InventoryRow,
} from "../../supabase/functions/_shared/coverage";

const hosts = allowedHosts("https://ww3supply.com/", "ww3supply.com");
const now = new Date("2026-11-15T12:00:00Z");

const row = (o: Partial<InventoryRow> & { url: string }): InventoryRow => ({
  sources: ["sitemap"],
  inSitemap: true,
  isAlias: false,
  canonicalGroup: null,
  liveCheckedAt: null,
  liveStatus: null,
  liveRedirectTo: null,
  liveCanonical: null,
  liveNoindex: null,
  liveWordCount: null,
  liveError: null,
  robotsAllowed: null,
  ...o,
});

const insp = (status: string, state: string | null = null): InspectionFact => ({
  ninjaStatus: status,
  coverageState: state,
  lastCrawlTime: "2026-11-10T08:00:00Z",
  lastInspectedAt: "2026-11-14T08:00:00Z",
});

describe("URL normalisation and discovery", () => {
  it("drops fragments and tracking parameters, keeps real parameters and the path", () => {
    expect(
      normalizeUrl("https://WW3Supply.com/a/?utm_source=x&page=2#top"),
    ).toBe("https://ww3supply.com/a/?page=2");
    expect(normalizeUrl("/guides/", "https://ww3supply.com/blog/")).toBe(
      "https://ww3supply.com/guides/",
    );
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
  });
  it("accepts only the verified host (with or without www)", () => {
    const { rows, rejected } = mergeInventory(
      [],
      [
        { url: "https://ww3supply.com/a/", source: "sitemap" },
        { url: "https://www.ww3supply.com/b/", source: "internal_link" },
        { url: "https://evil.example/c/", source: "internal_link" },
        { url: "https://ww3supply.com/logo.png", source: "internal_link" },
      ],
      hosts,
    );
    expect(rows.map((r) => r.url).sort()).toEqual([
      "https://ww3supply.com/a/",
      "https://www.ww3supply.com/b/",
    ]);
    expect(rejected).toBe(2);
  });
  it("de-duplicates across sources and records every source", () => {
    const { rows, added } = mergeInventory(
      [],
      [
        { url: "https://ww3supply.com/a/", source: "sitemap" },
        { url: "https://ww3supply.com/a/#x", source: "gsc" },
        {
          url: "https://ww3supply.com/a/?utm_medium=y",
          source: "internal_link",
        },
      ],
      hosts,
    );
    expect(rows).toHaveLength(1);
    expect(added).toBe(1);
    expect(rows[0].sources.sort()).toEqual(["gsc", "internal_link", "sitemap"]);
    expect(rows[0].inSitemap).toBe(true);
  });
  it("flags /page/index.html as an alias of /page/ without dropping it", () => {
    const { rows } = mergeInventory(
      [],
      [
        {
          url: "https://ww3supply.com/blog/x/index.html",
          source: "internal_link",
        },
      ],
      hosts,
    );
    expect(rows[0].isAlias).toBe(true);
    expect(rows[0].canonicalGroup).toBe("https://ww3supply.com/blog/x/");
    expect(indexHtmlTarget("https://ww3supply.com/blog/x/")).toBeNull();
  });
  it("never removes a known URL and respects the inventory cap", () => {
    const first = mergeInventory(
      [],
      [{ url: "https://ww3supply.com/a/", source: "sitemap" }],
      hosts,
    );
    const next = mergeInventory(
      first.rows,
      [{ url: "https://ww3supply.com/b/", source: "sitemap" }],
      hosts,
      1,
    );
    expect(next.rows.map((r) => r.url)).toEqual(["https://ww3supply.com/a/"]);
    expect(next.rejected).toBe(1);
  });
  it("ignores static assets", () => {
    expect(isAssetUrl("https://ww3supply.com/a.css")).toBe(true);
    expect(isAssetUrl("https://ww3supply.com/guides/")).toBe(false);
  });
});

describe("canonical de-duplication", () => {
  it("a page whose canonical points elsewhere becomes an alias of it", () => {
    const r = applyLiveCanonical(
      row({
        url: "https://ww3supply.com/blog/x/index.html",
        liveCanonical: "https://ww3supply.com/blog/x/",
      }),
    );
    expect(r.isAlias).toBe(true);
    expect(r.canonicalGroup).toBe("https://ww3supply.com/blog/x/");
  });
  it("a self-canonical index.html page is its own master", () => {
    const u = "https://ww3supply.com/blog/x/index.html";
    const r = applyLiveCanonical(
      row({
        url: u,
        isAlias: true,
        canonicalGroup: "https://ww3supply.com/blog/x/",
        liveCanonical: u,
      }),
    );
    expect(r.isAlias).toBe(false);
    expect(r.canonicalGroup).toBe(u);
  });
});

describe("incremental queues and quotas", () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    row({ url: `https://ww3supply.com/p${i}/` }),
  );
  it("never exceeds the live-check and inspection budgets", () => {
    expect(liveQueue(many, now)).toHaveLength(LIMITS.liveBatch);
    expect(inspectionQueue(many, new Map(), now)).toHaveLength(
      LIMITS.inspectBatch,
    );
  });
  it("skips URLs checked or inspected inside the staleness window", () => {
    const fresh = row({
      url: "https://ww3supply.com/fresh/",
      liveCheckedAt: "2026-11-14T00:00:00Z",
    });
    const stale = row({
      url: "https://ww3supply.com/stale/",
      liveCheckedAt: "2026-10-01T00:00:00Z",
    });
    expect(liveQueue([fresh, stale], now)).toEqual([
      "https://ww3supply.com/stale/",
    ]);
    const inspected = new Map([
      ["https://ww3supply.com/fresh/", "2026-11-14T00:00:00Z"],
    ]);
    expect(inspectionQueue([fresh], inspected, now)).toEqual([]);
  });
  it("inspects never-inspected pages first, aliases last", () => {
    const a = row({ url: "https://ww3supply.com/a/" });
    const alias = row({
      url: "https://ww3supply.com/a/index.html",
      isAlias: true,
      inSitemap: false,
      sources: ["internal_link"],
    });
    const old = row({ url: "https://ww3supply.com/old/" });
    const order = inspectionQueue(
      [alias, old, a],
      new Map([[old.url, "2026-10-01T00:00:00Z"]]),
      now,
    );
    expect(order).toEqual([a.url, alias.url, old.url]);
  });
  it("covers every URL over successive runs (finite, no repeats)", () => {
    const seen = new Set<string>();
    const done = new Map<string, string>();
    for (let day = 0; day < 6; day++) {
      const batch = inspectionQueue(many, done, now);
      for (const u of batch) {
        expect(seen.has(u)).toBe(false);
        seen.add(u);
        done.set(u, now.toISOString());
      }
    }
    expect(seen.size).toBe(100);
  });
});

describe("live classification", () => {
  it("classifies HTTP outcomes", () => {
    const p = (status: number | null, error: string | null = null) =>
      classifyLive({ status, location: null, xRobotsTag: null, error });
    expect(p(200)).toBe("ok");
    expect(p(301)).toBe("redirect");
    expect(p(404)).toBe("not_found");
    expect(p(410)).toBe("not_found");
    expect(p(403)).toBe("client_error");
    expect(p(503)).toBe("server_error");
    expect(p(null, "timeout")).toBe("unreachable");
  });
  it("reads noindex from the X-Robots-Tag header", () => {
    expect(headerNoindex("noindex, nofollow")).toBe(true);
    expect(headerNoindex("index, follow")).toBe(false);
    expect(headerNoindex(null)).toBe(false);
  });
});

describe("coverage summary: UNKNOWN until complete", () => {
  const rows = [
    row({ url: "https://ww3supply.com/a/" }),
    row({ url: "https://ww3supply.com/b/" }),
    row({ url: "https://ww3supply.com/c/" }),
  ];
  it("does not extrapolate a partial sample to a site total", () => {
    const s = summariseCoverage(
      rows,
      new Map([["https://ww3supply.com/a/", insp("indexed")]]),
    );
    expect(s.indexedAmongInspected).toBe(1);
    expect(s.indexedTotal).toBeNull();
    expect(s.excludedTotal).toBeNull();
    expect(s.complete).toBe(false);
  });
  it("reports totals and reasons once every eligible URL is inspected", () => {
    const s = summariseCoverage(
      rows,
      new Map([
        ["https://ww3supply.com/a/", insp("indexed")],
        [
          "https://ww3supply.com/b/",
          insp("crawled_not_indexed", "Crawled - currently not indexed"),
        ],
        [
          "https://ww3supply.com/c/",
          insp("crawled_not_indexed", "Crawled - currently not indexed"),
        ],
      ]),
    );
    expect(s.complete).toBe(true);
    expect(s.indexedTotal).toBe(1);
    expect(s.excludedTotal).toBe(2);
    expect(s.excludedByReason[0]).toMatchObject({
      reason: "Crawled - currently not indexed",
      count: 2,
    });
  });
  it("lists genuine technical errors only (a sitemap 404, server errors)", () => {
    const s = summariseCoverage(
      [
        row({
          url: "https://ww3supply.com/gone/",
          liveStatus: 404,
          liveCheckedAt: "x",
        }),
        row({
          url: "https://ww3supply.com/moved/",
          liveStatus: 301,
          liveCheckedAt: "x",
        }),
        row({
          url: "https://ww3supply.com/ok/",
          liveStatus: 200,
          liveCheckedAt: "x",
        }),
      ],
      new Map(),
    );
    expect(s.technicalErrors.map((e) => e.url)).toEqual([
      "https://ww3supply.com/gone/",
    ]);
  });
});

describe("diagnoseUrl", () => {
  it("404 in the sitemap: should not be indexed, fix the sitemap, approval for redirect", () => {
    const d = diagnoseUrl(
      row({ url: "https://ww3supply.com/gone/", liveStatus: 404 }),
      insp("not_indexed", "Not found (404)"),
    );
    expect(d.shouldBeIndexed).toBe("no");
    expect(d.category).toBe("not_found");
    expect(d.action).toContain("Remove it from the sitemap");
    expect(d.needsApproval).toBe(true);
  });
  it("redirecting page: Google correctly indexes the destination", () => {
    const d = diagnoseUrl(
      row({
        url: "https://ww3supply.com/old/",
        liveStatus: 301,
        liveRedirectTo: "https://ww3supply.com/new/",
      }),
      insp("not_indexed", "Page with redirect"),
    );
    expect(d.shouldBeIndexed).toBe("no");
    expect(d.category).toBe("redirect");
    expect(d.needsApproval).toBe(false);
  });
  it("alias: no canonical or redirect change, fix the links", () => {
    const d = diagnoseUrl(
      row({
        url: "https://ww3supply.com/blog/x/index.html",
        isAlias: true,
        canonicalGroup: "https://ww3supply.com/blog/x/",
        liveStatus: 200,
      }),
      undefined,
    );
    expect(d.category).toBe("alias");
    expect(d.action).toContain("No canonical or redirect change is needed");
  });
  it("crawled but not indexed, reachable page: content, never 'just resubmit'", () => {
    const d = diagnoseUrl(
      row({
        url: "https://ww3supply.com/g/",
        liveStatus: 200,
        liveWordCount: 180,
      }),
      insp("crawled_not_indexed", "Crawled - currently not indexed"),
    );
    expect(d.shouldBeIndexed).toBe("yes");
    expect(d.category).toBe("content");
    expect(d.reason).toContain("180 words");
    expect(d.action).toContain("Do not resubmit");
    expect(d.needsApproval).toBe(true);
  });
  it("a 4xx other than 404 is unclear: we cannot prove what Googlebot receives", () => {
    const d = diagnoseUrl(
      row({ url: "https://ww3supply.com/x/", liveStatus: 403 }),
      insp("not_indexed", "Blocked due to other 4xx issue"),
    );
    expect(d.shouldBeIndexed).toBe("unclear");
    expect(d.reason).toContain("cannot prove what Googlebot receives");
  });
  it("noindex pages are not flagged as problems to force into the index", () => {
    const d = diagnoseUrl(
      row({
        url: "https://ww3supply.com/private/",
        liveStatus: 200,
        liveNoindex: true,
        inSitemap: false,
      }),
      insp("not_indexed", "Excluded by 'noindex' tag"),
    );
    expect(d.shouldBeIndexed).toBe("no");
    expect(d.category).toBe("noindex");
  });
  it("a live, indexable page Google has never seen is 'undiscovered', not a page fault", () => {
    const d = diagnoseUrl(
      row({
        url: "https://ww3supply.com/supplies/",
        liveStatus: 200,
        robotsAllowed: true,
        liveNoindex: false,
      }),
      insp("unknown", "URL is unknown to Google"),
    );
    expect(d.category).toBe("undiscovered");
    expect(d.shouldBeIndexed).toBe("yes");
    expect(d.action).toContain("read-only access");
    expect(d.needsApproval).toBe(false);
  });
  it("without an inspection it says so rather than guessing", () => {
    const d = diagnoseUrl(row({ url: "https://ww3supply.com/n/" }), undefined);
    expect(d.shouldBeIndexed).toBe("unclear");
    expect(d.evidence[0]).toBe("Google: not inspected yet");
  });
});
