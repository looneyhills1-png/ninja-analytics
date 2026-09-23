import { describe, expect, it } from "vitest";
import {
  computeHealthScore,
  extractPageData,
  isDisallowed,
  isLikelySitemapIndex,
  parseRobotsTxt,
  parseSitemapLastmods,
  parseSitemapLocs,
  resolveLink,
} from "../../supabase/functions/_shared/site-crawler";

describe("parseRobotsTxt", () => {
  it("collects disallow rules from the wildcard user-agent block", () => {
    const rules = parseRobotsTxt(
      "User-agent: *\nDisallow: /admin\nDisallow: /cart\nSitemap: https://example.com/sitemap.xml",
    );
    expect(rules.disallow).toEqual(["/admin", "/cart"]);
    expect(rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("ignores rules scoped to a different user-agent", () => {
    const rules = parseRobotsTxt(
      "User-agent: Googlebot-Image\nDisallow: /images\nUser-agent: *\nDisallow: /private",
    );
    expect(rules.disallow).toEqual(["/private"]);
  });

  it("treats rules before any User-agent line as applying to everyone", () => {
    const rules = parseRobotsTxt(
      "Disallow: /early\nUser-agent: *\nDisallow: /late",
    );
    expect(rules.disallow).toEqual(["/early", "/late"]);
  });
});

describe("isDisallowed", () => {
  it("matches a path prefix", () => {
    expect(isDisallowed("/admin/users", ["/admin"])).toBe(true);
    expect(isDisallowed("/about", ["/admin"])).toBe(false);
  });
});

describe("parseSitemapLocs / isLikelySitemapIndex", () => {
  it("extracts every <loc>", () => {
    const xml = `<urlset><url><loc>https://a.com/1</loc></url><url><loc>https://a.com/2</loc></url></urlset>`;
    expect(parseSitemapLocs(xml)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
    ]);
  });

  it("detects a sitemap index vs a regular urlset", () => {
    expect(
      isLikelySitemapIndex("<sitemapindex><sitemap></sitemap></sitemapindex>"),
    ).toBe(true);
    expect(isLikelySitemapIndex("<urlset></urlset>")).toBe(false);
  });
});

describe("parseSitemapLastmods", () => {
  it("maps loc -> lastmod for entries that have both (Phase 4 indexing tracker's freshness signal)", () => {
    const xml = `<urlset>
      <url><loc>https://a.com/1</loc><lastmod>2026-09-20</lastmod></url>
      <url><loc>https://a.com/2</loc><lastmod>2026-09-01</lastmod></url>
    </urlset>`;
    const map = parseSitemapLastmods(xml);
    expect(map.get("https://a.com/1")).toBe("2026-09-20");
    expect(map.get("https://a.com/2")).toBe("2026-09-01");
    expect(map.size).toBe(2);
  });

  it("never invents a lastmod for a <url> entry that has none", () => {
    const xml = `<urlset><url><loc>https://a.com/no-lastmod</loc></url></urlset>`;
    const map = parseSitemapLastmods(xml);
    expect(map.has("https://a.com/no-lastmod")).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("resolveLink", () => {
  it("resolves a relative link against the base URL", () => {
    const url = resolveLink("/pricing", "https://example.com/about");
    expect(url?.toString()).toBe("https://example.com/pricing");
  });

  it("drops anchors, mailto and javascript links", () => {
    expect(resolveLink("#section", "https://example.com/")).toBeNull();
    expect(resolveLink("mailto:a@b.com", "https://example.com/")).toBeNull();
    expect(
      resolveLink("javascript:void(0)", "https://example.com/"),
    ).toBeNull();
  });

  it("strips the fragment from an otherwise valid link", () => {
    const url = resolveLink("/page#top", "https://example.com/");
    expect(url?.toString()).toBe("https://example.com/page");
  });
});

describe("extractPageData", () => {
  const BASE_HTML = (extra: string) => `<!doctype html>
<html><head>
<title>Best Blue Widgets | Acme</title>
<meta name="description" content="Shop the best blue widgets online.">
<link rel="canonical" href="https://example.com/blue-widgets">
${extra}
</head><body>
<h1>Blue Widgets</h1>
<p>Some real body copy about widgets that is reasonably long so it does not look like thin content in this particular fixture text block here today.</p>
<a href="/other-page">Other page</a>
<a href="https://external.com/page">External</a>
<img src="/a.jpg" alt="a widget">
<img src="/b.jpg">
</body></html>`;

  it("extracts title, meta description and canonical", () => {
    const data = extractPageData(
      BASE_HTML(""),
      "https://example.com/blue-widgets",
    );
    expect(data.title).toBe("Best Blue Widgets | Acme");
    expect(data.metaDescription).toBe("Shop the best blue widgets online.");
    expect(data.canonicalUrl).toBe("https://example.com/blue-widgets");
  });

  it("counts internal vs external links and images missing alt", () => {
    const data = extractPageData(
      BASE_HTML(""),
      "https://example.com/blue-widgets",
    );
    expect(data.internalLinks).toEqual(["https://example.com/other-page"]);
    expect(data.externalLinkCount).toBe(1);
    expect(data.imagesTotal).toBe(2);
    expect(data.imagesMissingAlt).toBe(1);
  });

  it("detects noindex from meta robots", () => {
    const withNoindex = extractPageData(
      BASE_HTML('<meta name="robots" content="noindex, follow">'),
      "https://example.com/",
    );
    expect(withNoindex.metaRobotsNoindex).toBe(true);

    const withoutNoindex = extractPageData(
      BASE_HTML(""),
      "https://example.com/",
    );
    expect(withoutNoindex.metaRobotsNoindex).toBe(false);
  });

  it("detects schema, viewport, OpenGraph, hreflang and pagination independently", () => {
    const bare = extractPageData(BASE_HTML(""), "https://example.com/");
    expect(bare.hasSchema).toBe(false);
    expect(bare.hasViewportMeta).toBe(false);
    expect(bare.hasOpenGraph).toBe(false);
    expect(bare.hasHreflang).toBe(false);
    expect(bare.hasPagination).toBe(false);

    const enriched = extractPageData(
      BASE_HTML(`
        <script type="application/ld+json">{"@type":"Product"}</script>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta property="og:title" content="Blue Widgets">
        <link rel="alternate" hreflang="fr" href="https://example.com/fr/blue-widgets">
        <link rel="next" href="https://example.com/blue-widgets?page=2">
      `),
      "https://example.com/",
    );
    expect(enriched.hasSchema).toBe(true);
    expect(enriched.hasViewportMeta).toBe(true);
    expect(enriched.hasOpenGraph).toBe(true);
    expect(enriched.hasHreflang).toBe(true);
    expect(enriched.hasPagination).toBe(true);
  });

  it("produces the same content hash for pages with identical extracted text", () => {
    const a = extractPageData(BASE_HTML(""), "https://example.com/a");
    const b = extractPageData(BASE_HTML(""), "https://example.com/b");
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("counts words from the visible body text only", () => {
    const html = `<html><head><title>T</title></head><body><script>var x = "not visible words here";</script><p>one two three</p></body></html>`;
    const data = extractPageData(html, "https://example.com/");
    expect(data.wordCount).toBe(3);
  });
});

describe("computeHealthScore", () => {
  it("returns 100 for a page with no issues", () => {
    expect(computeHealthScore(0, 0, 0)).toBe(100);
  });

  it("deducts more for errors than warnings, and more for warnings than notices", () => {
    expect(computeHealthScore(1, 0, 0)).toBeLessThan(100);
    expect(computeHealthScore(1, 0, 0)).toBeLessThan(
      computeHealthScore(0, 1, 0) + 100,
    );
    const errorScore = computeHealthScore(1, 0, 0);
    const warningScore = computeHealthScore(0, 1, 0);
    const noticeScore = computeHealthScore(0, 0, 1);
    expect(errorScore).toBeLessThan(warningScore);
    expect(warningScore).toBeLessThan(noticeScore);
  });

  it("never goes below 0", () => {
    expect(computeHealthScore(1000, 0, 0)).toBe(0);
  });
});
