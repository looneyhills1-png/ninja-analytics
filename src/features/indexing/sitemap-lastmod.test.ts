import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSitemapLastmods,
  parseSitemapLastmods,
} from "@/features/indexing/sitemap-lastmod";

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://ninjatickets.com/</loc></url>
  <url><loc>https://ninjatickets.com/guides/anastacia-uk-tour-2026-tickets/</loc><lastmod>2026-09-22</lastmod></url>
  <url><loc>https://ninjatickets.com/event/oasis-tickets/</loc><lastmod>2026-09-20</lastmod></url>
</urlset>`;

describe("parseSitemapLastmods", () => {
  it("maps loc -> lastmod, omitting entries with no lastmod", () => {
    const map = parseSitemapLastmods(SITEMAP_XML);
    expect(map.size).toBe(2);
    expect(
      map.get(
        "https://ninjatickets.com/guides/anastacia-uk-tour-2026-tickets/",
      ),
    ).toBe("2026-09-22");
    expect(map.has("https://ninjatickets.com/")).toBe(false);
  });
});

describe("fetchSitemapLastmods", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and parses the site's real sitemap.xml", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: true, text: async () => SITEMAP_XML }) as Response,
      ),
    );
    const map = await fetchSitemapLastmods("ninjatickets.com");
    expect(map.get("https://ninjatickets.com/event/oasis-tickets/")).toBe(
      "2026-09-20",
    );
  });

  it("degrades to an empty map (never throws) when the sitemap is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );
    const map = await fetchSitemapLastmods("unreachable.example");
    expect(map.size).toBe(0);
  });

  it("degrades to an empty map on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "" }) as Response),
    );
    const map = await fetchSitemapLastmods("ninjatickets.com");
    expect(map.size).toBe(0);
  });
});
