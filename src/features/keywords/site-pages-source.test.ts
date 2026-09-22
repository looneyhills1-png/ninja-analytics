import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSitePagesInventory } from "@/features/keywords/site-pages-source";

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://ninjatickets.com/</loc></url>
  <url><loc>https://ninjatickets.com/event/wicked-london/</loc></url>
  <url><loc>https://ninjatickets.com/things-to-do-in-llandudno/</loc></url>
</urlset>`;

const SEARCH_INDEX = {
  generatedAt: "2026-09-22T00:00:00Z",
  entities: [
    {
      type: "event",
      name: "Wicked",
      url: "/event/wicked-london/",
      meta: "Apollo Victoria Theatre, London",
      blurb: "The untold story of the witches of Oz.",
      category: "theatre",
      cityName: "London",
    },
    {
      type: "guide",
      name: "Things to Do in Llandudno",
      url: "/things-to-do-in-llandudno/",
      category: "guide",
      cityName: "Llandudno",
    },
  ],
};

const INTERNAL_LINK_AUDIT = {
  generatedAt: "2026-09-22T00:00:00Z",
  weaklyLinkedUrls: ["/event/wicked-london/"],
};

function mockFetchByUrl(
  responses: Record<string, { ok: boolean; body?: unknown; isText?: boolean }>,
) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.entries(responses).find(([key]) => url.includes(key));
    if (!match) {
      return { ok: false, status: 404 } as Response;
    }
    const [, resp] = match;
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 404,
      text: async () => (resp.body as string) ?? "",
      json: async () => resp.body,
    } as unknown as Response;
  });
}

describe("fetchSitePagesInventory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges sitemap.xml and search-index.json into a deduped page list, and reads weaklyLinkedUrls", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "sitemap.xml": { ok: true, body: SITEMAP_XML, isText: true },
        "search-index.json": { ok: true, body: SEARCH_INDEX },
        "internal-link-audit.json": { ok: true, body: INTERNAL_LINK_AUDIT },
      }),
    );

    const result = await fetchSitePagesInventory("ninjatickets.com");

    // 3 sitemap URLs, one of which (wicked-london) also appears in
    // search-index.json and should be deduped to a single, richer entry.
    expect(result.pages).toHaveLength(3);
    const wicked = result.pages.find((p) => p.url.includes("wicked-london"));
    expect(wicked?.title).toBe("Wicked");
    expect(wicked?.extraText).toContain("London");
    expect(wicked?.source).toBe("search-index");

    const home = result.pages.find(
      (p) => p.url === "https://ninjatickets.com/",
    );
    expect(home?.source).toBe("sitemap");
    expect(home?.title).toBeNull();

    expect(result.weaklyLinkedUrls).not.toBeNull();
    expect(result.weaklyLinkedUrls?.has("/event/wicked-london/")).toBe(true);
  });

  it("degrades gracefully when search-index.json and the internal-link audit are absent (a non-NinjaTickets tracked site)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchByUrl({
        "sitemap.xml": { ok: true, body: SITEMAP_XML, isText: true },
      }),
    );

    const result = await fetchSitePagesInventory("example-competitor.com");

    expect(result.pages).toHaveLength(3);
    expect(result.pages.every((p) => p.source === "sitemap")).toBe(true);
    expect(result.weaklyLinkedUrls).toBeNull();
  });

  it("returns an empty inventory (never throws) when every source is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );

    const result = await fetchSitePagesInventory("unreachable-site.com");

    expect(result.pages).toEqual([]);
    expect(result.weaklyLinkedUrls).toBeNull();
  });
});
