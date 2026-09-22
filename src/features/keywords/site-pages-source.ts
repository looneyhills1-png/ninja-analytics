// Primary inventory source for the Internal Link Engine (Phase 2): the
// site's own current sitemap.xml and search-index.json, fetched directly
// from the browser. No new backend, no crawler - two plain GET requests to
// already-public, already-served static files (search-index.json already
// powers that site's own public search widget), parsed client-side.
//
// Both files are cross-origin from this app's perspective, so the target
// site must serve them with Access-Control-Allow-Origin (NinjaTickets does,
// on /sitemap.xml and /assets/data/* - see its public/_headers). A site
// that hasn't set this yet, or doesn't have search-index.json at all, just
// contributes nothing from that source - never a hard error - so a run
// against another tracked site degrades gracefully rather than breaking.
import type { CandidatePage } from "@/features/keywords/internal-link-engine";

interface SearchIndexEntity {
  type?: string;
  name?: string;
  url?: string;
  meta?: string;
  blurb?: string;
  category?: string;
  categoryName?: string;
  cityName?: string;
  searchExtra?: string;
}

function parseSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) urls.push(m[1]);
  return urls;
}

async function fetchSitemapPages(domain: string): Promise<CandidatePage[]> {
  try {
    const res = await fetch(`https://${domain}/sitemap.xml`, { mode: "cors" });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseSitemapUrls(xml).map((url) => ({
      url,
      title: null,
      extraText: null,
      source: "sitemap" as const,
    }));
  } catch {
    return [];
  }
}

// Covers "events/guides/cities/categories data" too - search-index.json's
// entities already index all of those (type: event/artist/guide/provider/
// city/category), so there's no separate file to fetch for that source.
async function fetchSearchIndexPages(domain: string): Promise<CandidatePage[]> {
  try {
    const res = await fetch(
      `https://${domain}/assets/data/search-index.json`,
      { mode: "cors" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { entities?: SearchIndexEntity[] };
    const base = `https://${domain}`;
    return (data.entities ?? [])
      .filter((e): e is SearchIndexEntity & { url: string } => !!e.url)
      .map((e) => {
        const url = e.url.startsWith("http") ? e.url : `${base}${e.url}`;
        const extraText = [
          e.meta,
          e.blurb,
          e.category,
          e.categoryName,
          e.cityName,
          e.searchExtra,
        ]
          .filter(Boolean)
          .join(" ");
        return {
          url,
          title: e.name ?? null,
          extraText: extraText || null,
          source: "search-index" as const,
        };
      });
  } catch {
    return [];
  }
}

// Existing internal-link audit data (source #5), best-effort. Only tells us
// whether the TARGET page overall has too few inbound links (the audit's
// own weaklyLinkedUrls) - there is no per-source-page link graph published,
// so this can never answer "does source X already link to target Y"
// without fetching and parsing that page's live HTML, which this
// analyse-only phase doesn't do. null = unavailable this run (not yet
// published for this site, or unreachable) - callers report
// targetLinkStatus "not-verified" in that case, never guessing.
async function fetchWeaklyLinkedUrls(
  domain: string,
): Promise<Set<string> | null> {
  try {
    const res = await fetch(
      `https://${domain}/assets/data/internal-link-audit.json`,
      { mode: "cors" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { weaklyLinkedUrls?: unknown };
    if (!Array.isArray(data.weaklyLinkedUrls)) return null;
    return new Set(data.weaklyLinkedUrls.filter((u) => typeof u === "string"));
  } catch {
    return null;
  }
}

export interface SitePagesInventory {
  /** Deduped by URL - a URL known to both sources keeps search-index.json's
   * richer text. */
  pages: CandidatePage[];
  /** null = the current internal-link audit wasn't reachable this run. */
  weaklyLinkedUrls: Set<string> | null;
}

export async function fetchSitePagesInventory(
  domain: string,
): Promise<SitePagesInventory> {
  const [sitemapPages, searchIndexPages, weaklyLinkedUrls] =
    await Promise.all([
      fetchSitemapPages(domain),
      fetchSearchIndexPages(domain),
      fetchWeaklyLinkedUrls(domain),
    ]);
  const byUrl = new Map<string, CandidatePage>();
  for (const p of sitemapPages) byUrl.set(p.url, p);
  for (const p of searchIndexPages) byUrl.set(p.url, p);
  return { pages: [...byUrl.values()], weaklyLinkedUrls };
}
