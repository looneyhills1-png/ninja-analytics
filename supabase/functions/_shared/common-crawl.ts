// Zero-cost Common Crawl research module (CLAUDE.md Phase 3). Uses only
// Common Crawl's public CDX Server API (index.commoncrawl.org) - a free,
// public index of URLs Common Crawl has already fetched. This never mirrors
// Common Crawl's own data (no bulk WARC/S3 download) and never calls a paid
// SEO API. Per crawl-snapshot coverage is inherently partial (Common Crawl
// does not index every page on every site), which the UI must say plainly.

import { fetchWithRetry } from "./http.ts";
import { sanitizeMessage } from "./errors.ts";

const CDX_BASE = "https://index.commoncrawl.org";

export interface CdxRecord {
  url: string;
  timestamp: string; // YYYYMMDDHHMMSS
  status: number | null;
  mime: string | null;
}

interface CollinfoEntry {
  id: string;
  name: string;
  timegate: string;
  "cdx-api": string;
}

/** The most recent Common Crawl monthly index id, e.g. "CC-MAIN-2025-38". */
export async function fetchLatestCrawlId(): Promise<string> {
  const res = await fetchWithRetry(`${CDX_BASE}/collinfo.json`, {
    headers: { "User-Agent": "ninja-analytics-common-crawl/1.0" },
  });
  if (!res.ok) {
    throw new Error(`collinfo.json returned ${res.status}`);
  }
  const list = (await res.json()) as CollinfoEntry[];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("collinfo.json returned no crawls");
  }
  // Entries are newest-first in Common Crawl's own listing, but sort
  // defensively by id (CC-MAIN-YYYY-WW sorts lexicographically newest-last,
  // so take the max) rather than trusting array order.
  return list
    .map((c) => c.id)
    .sort()
    .at(-1)!;
}

/**
 * Every URL Common Crawl indexed for `domain` in one monthly snapshot.
 * Bounded by `limit` - this is a research aid, not a full mirror.
 */
export async function queryCdxIndex(
  domain: string,
  crawlId: string,
  limit: number,
): Promise<CdxRecord[]> {
  const url = new URL(`${CDX_BASE}/${crawlId}-index`);
  url.searchParams.set("url", `${domain}/*`);
  url.searchParams.set("output", "json");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithRetry(url.toString(), {
    headers: { "User-Agent": "ninja-analytics-common-crawl/1.0" },
  });
  // The CDX API returns 404 for a domain it has no records for at all - a
  // legitimate "nothing indexed", not an error.
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`CDX query returned ${res.status}`);
  }
  const text = await res.text();
  const records: CdxRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        url?: string;
        timestamp?: string;
        status?: string;
        mime?: string;
      };
      if (!row.url || !row.timestamp) continue;
      records.push({
        url: row.url,
        timestamp: row.timestamp,
        status: row.status ? Number(row.status) : null,
        mime: row.mime ?? null,
      });
    } catch {
      // Skip a malformed line rather than failing the whole sync.
    }
  }
  return records;
}

export interface LiveCheckResult {
  statusCode: number | null;
  title: string | null;
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Best-effort live check of one URL - a normal, single HTTP GET (same shape
 * as the existing uptime probe), never a Common Crawl WARC/S3 fetch. Used
 * only for a small, capped number of newly-discovered URLs per sync so a
 * title can be shown "where retrievable", per the brief.
 */
export async function liveCheckPage(
  url: string,
  timeoutMs = 8_000,
): Promise<LiveCheckResult> {
  try {
    const res = await fetchWithRetry(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "ninja-analytics-common-crawl/1.0" },
      },
      { timeoutMs, maxRetries: 0 },
    );
    let title: string | null = null;
    if (res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("html")) {
        // Bounded read - only the first chunk is needed to find <title>.
        const buf = await res.arrayBuffer();
        const html = new TextDecoder().decode(buf.slice(0, 65_536));
        const match = TITLE_RE.exec(html);
        title = match
          ? decodeEntities(match[1]).trim().slice(0, 300) || null
          : null;
      } else {
        await res.body?.cancel();
      }
    } else {
      await res.body?.cancel();
    }
    return { statusCode: res.status, title };
  } catch (err) {
    void sanitizeMessage(err, 120); // never thrown further - a dead page is a normal outcome
    return { statusCode: null, title: null };
  }
}
