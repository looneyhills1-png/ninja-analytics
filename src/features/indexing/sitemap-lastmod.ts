// The site's own current sitemap.xml <lastmod> values, fetched directly from
// the browser (same pattern/CORS assumption as
// src/features/keywords/site-pages-source.ts - the target site must serve
// /sitemap.xml with Access-Control-Allow-Origin, which NinjaTickets already
// does). This is the real, first-party "when did our own build last touch
// this page" signal the Indexing tracker (Ranking Growth Roadmap Phase 4)
// uses for "newly published" and "changed since Google's last crawl" -
// never a guessed or invented date. A URL with no <lastmod> in the sitemap
// is simply absent from the returned map.
//
// Deliberately a separate, small implementation from the Deno-side
// parseSitemapLastmods (supabase/functions/_shared/site-crawler.ts) rather
// than shared code - the browser bundle and the Edge Functions are genuinely
// separate runtimes/directories, same reason site-pages-source.ts
// re-implements its own tiny sitemap <loc> parser instead of importing from
// _shared.

const URL_BLOCK_RE = /<url>([\s\S]*?)<\/url>/gi;
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/i;
const LASTMOD_RE = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;

export function parseSitemapLastmods(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(URL_BLOCK_RE);
  while ((match = re.exec(xml)) !== null) {
    const block = match[1];
    const loc = LOC_RE.exec(block)?.[1];
    const lastmod = LASTMOD_RE.exec(block)?.[1];
    if (loc && lastmod) out.set(loc, lastmod);
  }
  return out;
}

/** Map keyed by the full URL exactly as it appears in the sitemap (the same
 * form GSC's URL Inspection API expects as `inspectionUrl`). Empty map (not
 * an error) if the sitemap is unreachable or has no lastmod data - callers
 * degrade gracefully, same convention as fetchSitePagesInventory. */
export async function fetchSitemapLastmods(
  domain: string,
): Promise<Map<string, string>> {
  try {
    const res = await fetch(`https://${domain}/sitemap.xml`, { mode: "cors" });
    if (!res.ok) return new Map();
    return parseSitemapLastmods(await res.text());
  } catch {
    return new Map();
  }
}
